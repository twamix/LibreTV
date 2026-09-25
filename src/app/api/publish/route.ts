import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES } from '@/lib/source-list';
import { MAX_PUBLISH_BYTES, saveShare } from '@/lib/share-store';
import { buildTvboxConfig, buildTvboxProxyConfig } from '@/lib/tvbox-export';
import { parseSubscriptionPayload } from '@/lib/tvbox-parser';

export const runtime = 'nodejs';

/**
 * 发布格式：
 * - libretv：默认 LibreTV-SourceList，存本站内存，返回 `/api/share/<id>` 直链；
 * - tvbox：常规 TVBOX 配置（sites/lives，逐源直连），同样存本站、返回直链；
 * - tvbox-proxy：家庭过滤版——点播只放一个单 site 指向本站聚合代理
 *   （强制成人过滤），直播仍直连 M3U。
 *
 * 三种格式都不再经过第三方粘贴板：内容只存在自己服务器内存里，
 * 返回的直链就是 `${origin}/api/share/<id>`，TVBOX 与本站订阅都直接回源拉取，
 * 不怕粘贴板域名被墙。代价是服务重启后快照丢失，需重新发布（UI 文案里已告知）。
 */
const FORMATS = ['libretv', 'tvbox', 'tvbox-proxy'] as const;
type PublishFormat = (typeof FORMATS)[number];

/** 发布来源标识：前端展示「已发布到」时用，不再是粘贴板名 */
const PROVIDER = '本站直链';

/** 单个字段长度上限：源名与地址再长也不该超过这个量级 */
const MAX_FIELD_LEN = 2048;

interface VodOut {
  name: string;
  url: string;
}

interface LiveOut {
  name: string;
  url: string;
  epg?: string;
}

/**
 * 只抽取已知字段并重新序列化。
 * 本接口的语义是「发布源列表」，不是通用上传通道：白名单式取字段 + 条数上限，
 * 避免它被当作任意内容的存储口（内容会落在可公开读取的直链上，这一点必须守住）。
 */
function normalizePayload(raw: unknown): { name?: string; sources: VodOut[]; liveSources: LiveOut[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const text = (v: unknown, max = MAX_FIELD_LEN) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const url = (v: unknown) => {
    const s = text(v);
    return /^https?:\/\//i.test(s) ? s : '';
  };

  const sources = (Array.isArray(record.sources) ? record.sources : [])
    .slice(0, MAX_VOD_SOURCES)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return { name: text(o.name, 128), url: url(o.url) };
    })
    .filter((s) => s.url);

  const liveSources = (Array.isArray(record.liveSources) ? record.liveSources : [])
    .slice(0, MAX_LIVE_SOURCES)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const epg = url(o.epg);
      return { name: text(o.name, 128), url: url(o.url), ...(epg ? { epg } : {}) };
    })
    .filter((s) => s.url);

  if (sources.length === 0 && liveSources.length === 0) return null;
  return { name: text(record.name, 64) || undefined, sources, liveSources };
}

/** 从请求头推导本站公网 origin：直链与代理 api 地址必须写绝对 URL，TVBOX 客户端直连它 */
function publicOrigin(req: Request): string | null {
  const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0].trim() || 'https';
  // 测试/直连环境下 Host 头可能缺失，退化为请求 URL 自带的主机名
  let host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').split(',')[0].trim();
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      return null;
    }
  }
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) return null;
  if (proto !== 'http' && proto !== 'https') return null;
  return `${proto}://${host}`;
}

/** 把文本存本站内存，返回可直接填入订阅框的直链 URL */
function publishText(origin: string, text: string): { url: string } | { error: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_PUBLISH_BYTES) {
    return { error: '源列表体积超出本站分享限制，无法发布' };
  }
  return { url: `${origin}/api/share/${saveShare(text)}` };
}

/** 发布当前源列表：三种格式都是一步存本站，返回直链 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: '请求内容不是合法 JSON' }, { status: 400 });
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const format: PublishFormat =
    record.format === 'tvbox-proxy' ? 'tvbox-proxy' : record.format === 'tvbox' ? 'tvbox' : 'libretv';

  const normalized = normalizePayload(raw);
  if (!normalized) {
    return NextResponse.json({ error: '没有可发布的源（当前没有已勾选启用的点播源或直播源）' }, { status: 400 });
  }

  const origin = publicOrigin(req);
  if (!origin) {
    return NextResponse.json({ error: '无法确定本站公网地址（缺少 Host 请求头）' }, { status: 500 });
  }

  // 家庭过滤版走单步代理发布（源列表与 TVBOX 配置合在一起存），其余格式一次存储
  if (format === 'tvbox-proxy') {
    return publishProxy(origin, normalized);
  }

  const payload =
    format === 'tvbox'
      ? // 常规 TVBOX：sites/lives 结构，TVBOX 客户端可直接订阅；
        // 复用本站的订阅入口解析器做一次往返校验，导出的东西必须本站自己认得回来
        tvboxPayload(normalized)
      : // 与「导出数据源」保持同一种格式，发布出去的链接可以直接被本站或他人订阅
        JSON.stringify(
          {
            name: normalized.name ?? 'LibreTV-SourceList',
            version: 2,
            exportedAt: Date.now(),
            sources: normalized.sources,
            liveSources: normalized.liveSources,
          },
          null,
          2
        );

  if (payload === null) {
    return NextResponse.json({ error: 'TVBOX 导出内容无法被本站订阅入口识别，请重试' }, { status: 500 });
  }

  const published = publishText(origin, payload);
  if ('error' in published) {
    return NextResponse.json({ error: published.error }, { status: 413 });
  }
  return NextResponse.json({
    url: published.url,
    provider: PROVIDER,
    format,
    sources: normalized.sources.length,
    liveSources: normalized.liveSources.length,
  });
}

/**
 * 家庭过滤版的单步发布：
 * 源列表（含 proxyToken，直播不进聚合所以只存点播）先存本站拿到分享 id，
 * 再拼出代理 api 地址，TVBOX 配置（单 proxy site + 直连 lives）同样存本站，
 * 返回的直链即家里电视用的订阅链接。
 * 点播源为空时直接 400：单 proxy site 无源可聚，配了也搜不出东西。
 */
function publishProxy(
  origin: string,
  normalized: { name?: string; sources: VodOut[]; liveSources: LiveOut[] }
): NextResponse {
  if (normalized.sources.length === 0) {
    return NextResponse.json({ error: '家庭过滤版需要至少一个点播源（聚合搜索无源可聚）' }, { status: 400 });
  }

  const token = randomBytes(16).toString('hex'); // 128 位，链接即凭证，注意保管
  const sourceListText = JSON.stringify(
    {
      name: normalized.name ?? 'LibreTV-SourceList',
      version: 2,
      exportedAt: Date.now(),
      sources: normalized.sources,
      liveSources: [],
      // 代理认证用：本站订阅入口解析时会忽略该未知键，无害
      proxyToken: token,
    },
    null,
    2
  );
  const listSaved = publishText(origin, sourceListText);
  if ('error' in listSaved) {
    return NextResponse.json({ error: listSaved.error }, { status: 413 });
  }

  const proxyApi =
    `${origin}/api/tvbox/proxy?list=${encodeURIComponent(listSaved.url)}&token=${encodeURIComponent(token)}`;
  const config = buildTvboxProxyConfig(proxyApi, normalized.liveSources);
  // 单 proxy site 同样要过往返校验：导出的东西必须本站订阅入口认得回来
  const roundTrip = parseSubscriptionPayload(config);
  if (roundTrip.sources.length === 0) {
    return NextResponse.json({ error: 'TVBOX 导出内容无法被本站订阅入口识别，请重试' }, { status: 500 });
  }
  const configSaved = publishText(origin, JSON.stringify(config, null, 2));
  if ('error' in configSaved) {
    return NextResponse.json({ error: configSaved.error }, { status: 413 });
  }
  return NextResponse.json({
    url: configSaved.url,
    provider: PROVIDER,
    format: 'tvbox-proxy' as const,
    sources: normalized.sources.length,
    liveSources: normalized.liveSources.length,
  });
}

/**
 * 生成 TVBOX 配置文本。返回 null 表示往返校验失败——正常不会发生，
 * 一旦发生说明导出与导入两端的映射脱钩，宁可报错也不发布半残配置。
 */
function tvboxPayload(normalized: { sources: VodOut[]; liveSources: LiveOut[] }): string | null {
  const config = buildTvboxConfig(normalized.sources, normalized.liveSources);
  try {
    const roundTrip = parseSubscriptionPayload(config);
    if (roundTrip.sources.length === 0 && roundTrip.liveSources.length === 0) return null;
    // 往返不丢源：转换过程中被解析器跳过的条目数不得超过截断容忍（正常为 0）
    if (
      roundTrip.sources.length < normalized.sources.length ||
      roundTrip.liveSources.length < normalized.liveSources.length
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return JSON.stringify(config, null, 2);
}
