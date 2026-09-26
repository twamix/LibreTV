import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isAdultContent } from '@/lib/cms-parser';
import { resolveDetail } from '@/lib/detail-resolve';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkRateLimit } from '@/lib/rate-limit';
import { aggregateOutcomes, SEARCH_MAX_PAGES, searchSource } from '@/lib/search-aggregate';
import { extractShareId, getShareText } from '@/lib/share-store';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { parseSubscriptionJson, parseSubscriptionPayload } from '@/lib/tvbox-parser';
import type { SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 家人用的 TVBOX 过滤代理：把本站的聚合搜索伪装成一个 Apple CMS 单站，
 * TVBOX 客户端只需订阅一个 site，搜索/详情全部走这台服务器——
 * 成人过滤（关键词规则与本站一致）在服务端强制执行，TVBOX 侧关不掉。
 *
 * 协议（Apple CMS 子集）：
 * - 首页：`?list=...&token=...&ac=videolist&pg=页码`（无 wd，空关键词搜上游最新列表给 TVBOX 首页用）
 * - 分类：`?list=...&token=...&ac=list`（暂无真实分类，返回空分类避免客户端报错）
 * - 搜索：`?list=<本站分享URL或id>&token=...&ac=videolist&wd=关键词&pg=页码`
 * - 详情：`?list=...&token=...&ac=videolist&ids=<编码id>`（ac=detail 同义）
 *
 * 认证：无登录态，token 即凭证（发布时写入源列表的 proxyToken，请求时原样带回）。
 * 源列表存本站内存（60s 缓存），发布后改源需重新发布家人用链接（服务重启同样需重发）。
 * 兼容以前已发布的粘贴板链接：list 指向外部 URL 时仍走出网拉取。
 * 直播不经过这里——TVBOX 配置里的 lives 仍是直连 M3U。
 */

const LIST_CACHE_TTL = 60 * 1000;
const SEARCH_CACHE_TTL = 60 * 1000;
/**
 * 上游搜索并发数：家中电视的弱网环境下，6 源齐发常被路由器逐个 RST，
 * 收敛到 2 个一批更稳。TVBOX 单站搜索通常只等 5~8 秒，2 并发 × 首轮 1 页
 * 一般 2~3 秒能回，足够进电视的超时窗口。
 */
const SEARCH_CONCURRENCY = 2;
/** 每页条数：CMS 惯例 20，TVBOX 按 pg 翻页 */
const PAGE_LIMIT = 20;
/** 限流：单链接每分钟 120 次（含搜索展开的多源 fan-out，家里电视用绰绰有余） */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 1000;

/** vod_id 编解码：`p<源序号>:<上游vodId>` → base64url，TVBOX 只当不透明字符串回传 */
function encodeProxyId(sourceIndex: number, vodId: string): string {
  return Buffer.from(`p${sourceIndex}:${vodId}`, 'utf8').toString('base64url');
}

function decodeProxyId(encoded: string): { sourceIndex: number; vodId: string } | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const m = /^p(\d+):([\s\S]*)$/.exec(raw);
    if (!m || !m[2]) return null;
    return { sourceIndex: parseInt(m[1], 10), vodId: m[2] };
  } catch {
    return null;
  }
}

function timingSafeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface ProxySources {
  sources: SourceConfig[];
}

/** 从内存快照或远端拉回源列表原始 JSON：本站直链读内存，其余（旧粘贴板链接）走 SSRF + 出网 */
async function fetchListJson(listUrl: string): Promise<{ text: string } | { error: string; status: number }> {
  const shareId = extractShareId(listUrl);
  if (shareId) {
    const text = getShareText(shareId);
    if (text === null) {
      return { error: '源列表已失效（服务重启后需重新发布家庭过滤版链接）', status: 502 };
    }
    return { text };
  }

  const verdict = await checkUpstreamAllowed(listUrl);
  if (!verdict.ok) {
    return { error: verdict.reason, status: 400 };
  }
  try {
    const res = await fetchUpstream(listUrl, { timeoutMs: 8000, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return { error: `源列表地址返回 HTTP ${res.status}`, status: 502 };
    }
    return { text: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : '源列表拉取失败', status: 502 };
  }
}

async function loadSources(listUrl: string, token: string): Promise<ProxySources | { error: string; status: number }> {
  const cacheKey = `tvproxy:list:${listUrl}`;
  const cached = getCache<{ sources: SourceConfig[]; proxyToken: string }>(cacheKey);
  if (cached) {
    if (!timingSafeCompare(token, cached.proxyToken)) {
      return { error: 'token 无效', status: 403 };
    }
    return { sources: cached.sources };
  }

  const fetched = await fetchListJson(listUrl);
  if ('error' in fetched) return fetched;
  let rawJson: unknown;
  try {
    rawJson = parseSubscriptionJson(fetched.text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : '源列表拉取失败', status: 502 };
  }

  const storedToken = (rawJson as { proxyToken?: unknown }).proxyToken;
  if (typeof storedToken !== 'string' || !storedToken) {
    return { error: '该订阅不是家庭过滤版代理配置', status: 400 };
  }
  if (!timingSafeCompare(token, storedToken)) {
    return { error: 'token 无效', status: 403 };
  }

  let parsed;
  try {
    parsed = parseSubscriptionPayload(rawJson);
  } catch (err) {
    return { error: err instanceof Error ? err.message : '源列表格式不正确', status: 502 };
  }
  if (parsed.sources.length === 0) {
    return { error: '源列表中没有可用点播源', status: 502 };
  }
  const sources: SourceConfig[] = parsed.sources.map((s, i) => ({ key: `proxy_${i}`, ...s }));
  setCache(cacheKey, { sources, proxyToken: storedToken }, LIST_CACHE_TTL);
  return { sources };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const listUrl = (url.searchParams.get('list') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();
  if (!listUrl || !token) {
    return NextResponse.json({ error: '缺少 list 或 token 参数' }, { status: 401 });
  }

  // 先限流再干活：key 含 token，不同家人的链接互不干扰
  const limited = checkRateLimit(`tvproxy:${token}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: '请求过于频繁，请稍后再试' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 60000) / 1000)) } }
    );
  }

  const loaded = await loadSources(listUrl, token);
  if ('error' in loaded) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }
  const { sources } = loaded;

  const ac = (url.searchParams.get('ac') || '').trim().toLowerCase();
  // 部分 TVBOX 进站不带任何参数先拉一次首页：无 wd 时用空关键词走聚合，
  // 空关键词不过相关性过滤（isRelevant 恒真），各源最新列表直接展示，站内不再空白
  if (!ac || ac === 'videolist' || ac === 'detail' || ac === 'list') {
    // 详情优先：带 ids 参数时走详情（TVBOX 点播必经）
    const ids = (url.searchParams.get('ids') || '').trim();
    if (ids) return await handleDetail(ids, sources);
    // 分类请求：暂无真实分类，返回空分类避免客户端报错
    if (ac === 'list') {
      return NextResponse.json({ code: 1, msg: '数据列表', page: 1, pagecount: 0, limit: PAGE_LIMIT, total: 0, list: [], class: [] });
    }
    const wd = (url.searchParams.get('wd') || '').trim();
    return await handleSearch(wd, url.searchParams.get('pg'), sources, listUrl, token);
  }
  return NextResponse.json({ error: '不支持的 ac 参数（仅支持 videolist / detail）' }, { status: 400 });
}

/** 分批搜上游：每批 SEARCH_CONCURRENCY 个，避免弱网下全量齐发被 RST；失败的源记失败不影响其余 */
async function searchBatched(
  sources: SourceConfig[],
  wd: string,
  maxPages: number
): Promise<SourceSearchOutcome[]> {
  const outcomes: SourceSearchOutcome[] = [];
  for (let i = 0; i < sources.length; i += SEARCH_CONCURRENCY) {
    const batch = await Promise.all(sources.slice(i, i + SEARCH_CONCURRENCY).map((s) => searchSource(s, wd, maxPages)));
    outcomes.push(...batch);
  }
  return outcomes;
}

/** 聚合搜索 → CMS 列表形状。成人过滤强制开启，与本站规则同一套。 */
async function handleSearch(
  wd: string,
  pgRaw: string | null,
  sources: SourceConfig[],
  listUrl: string,
  token: string
): Promise<NextResponse> {
  if (wd.length > 100) {
    return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
  }
  const pg = Math.min(50, Math.max(1, parseInt(pgRaw || '1', 10) || 1));

  const cacheKey = `tvproxy:search:${listUrl}\n${token}\n${wd}`;
  let full = getCache<{ total: number; items: { vodId: string; name: string; pic?: string; typeName?: string; year?: string; area?: string; remarks?: string }[] }>(cacheKey);
  if (!full) {
    // TVBOX 单站搜索通常只等 5~8 秒：首轮只抓各源第 1 页（2 并发分批），
    // 2~3 秒先回第一屏给电视；后续翻页（pg>1）再按需抓深页补齐
    const outcomes = await searchBatched(sources, wd, pg > 1 ? SEARCH_MAX_PAGES : 1);
    // filterAdult 恒为 true：代理存在的意义就是这行，TVBOX 侧无法关闭
    const payload = aggregateOutcomes(outcomes, wd, true);
    const items = payload.list.map((item) => ({
      vodId: encodeProxyId(sources.findIndex((s) => s.key === item.sourceKey), item.vodId),
      name: item.name,
      pic: item.pic,
      typeName: item.typeName,
      year: item.year,
      area: item.area,
      remarks: item.remarks,
    }));
    full = { total: items.length, items };
    setCache(cacheKey, full, SEARCH_CACHE_TTL);
  }

  const pagecount = Math.max(1, Math.ceil(full.total / PAGE_LIMIT));
  const pageItems = full.items.slice((pg - 1) * PAGE_LIMIT, pg * PAGE_LIMIT);
  return NextResponse.json({
    code: 1,
    msg: '数据列表',
    page: pg,
    pagecount,
    limit: PAGE_LIMIT,
    total: full.total,
    list: pageItems.map((item) => ({
      vod_id: item.vodId,
      vod_name: item.name,
      vod_pic: item.pic ?? '',
      type_name: item.typeName ?? '',
      vod_year: item.year ?? '',
      vod_area: item.area ?? '',
      vod_remarks: item.remarks ?? '',
    })),
  });
}

/** 详情 → CMS 详情形状，线路名放 vod_play_from、集数串放 vod_play_url；成人分类二次拦截。 */
async function handleDetail(ids: string, sources: SourceConfig[]): Promise<NextResponse> {
  // TVBOX 一次只点一部，多个 id 时取首个
  const first = ids.split(',')[0].trim();
  const decoded = decodeProxyId(first);
  if (!decoded || decoded.sourceIndex < 0 || decoded.sourceIndex >= sources.length) {
    return NextResponse.json({ error: '无效的视频ID' }, { status: 400 });
  }
  const source = sources[decoded.sourceIndex];

  let detail;
  try {
    const resolved = await resolveDetail(decoded.vodId, source);
    if (!resolved.ok) {
      if (resolved.blocked) {
        return NextResponse.json({ error: resolved.blocked }, { status: 400 });
      }
      return NextResponse.json({ error: '未找到播放资源' }, { status: 404 });
    }
    detail = resolved.detail;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '获取详情失败' }, { status: 502 });
  }

  // 二次拦截：详情返回的分类若命中成人关键词，直接 404（搜索页 type_name 缺失时的兜底）
  if (isAdultContent(detail.videoInfo.typeName)) {
    return NextResponse.json({ error: '未找到播放资源' }, { status: 404 });
  }

  // 标准 CMS 详情形状：线路名放独立的 vod_play_from，集数串放 vod_play_url，
  // 两字段按 $$$ 配对（单线路时各一段）。之前把线路名塞进 vod_play_url 里，
  // 多数 TVBOX 客户端解析不到线路直接报「无线路数据」。
  const playFrom = 'LibreTV-家庭过滤';
  const playUrl = detail.episodes.map((ep, i) => `第${i + 1}集$${ep}`).join('#');
  return NextResponse.json({
    code: 1,
    msg: '数据列表',
    page: 1,
    pagecount: 1,
    limit: 1,
    total: 1,
    list: [
      {
        vod_id: first,
        vod_name: detail.videoInfo.title ?? '',
        vod_pic: detail.videoInfo.cover ?? '',
        type_name: detail.videoInfo.typeName ?? '',
        vod_year: detail.videoInfo.year ?? '',
        vod_area: detail.videoInfo.area ?? '',
        vod_actor: detail.videoInfo.actor ?? '',
        vod_director: detail.videoInfo.director ?? '',
        vod_content: detail.videoInfo.desc ?? '',
        vod_remarks: detail.videoInfo.remarks ?? '',
        vod_play_from: playFrom,
        vod_play_url: playUrl,
      },
    ],
  });
}
