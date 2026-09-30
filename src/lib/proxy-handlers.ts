import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed, checkUpstreamAllowed, isBlockedByDNS, isValidProxyUrl } from '@/lib/ssrf';
import { rewriteM3u8 } from '@/lib/m3u8';

/**
 * 代理路由公共实现。
 *
 * 同时服务两种入口：
 * - 查询串形式 `/api/proxy?url=…`、`/api/live/stream?url=…`（新，见 route.ts）；
 * - 路径形式 `/api/proxy/<encoded>`、`/api/live/stream/<encoded>`（旧，
 *   保留是为兼容已下发的播放列表与浏览器缓存——路径形式的编码段会被 EdgeOne
 *   等网关的 URL 归一化破坏（`%3A%2F%2F` 被解码后路由参数对不上），故新地址
 *   一律走查询串，旧地址继续可解。
 *
 * 两条 handler 的抓取策略不同（点播整段限时重试 / 直播仅响应头限时不重试），
 * 因此分别实现，但 SSRF 校验、鉴权、m3u8 重写前缀等语义在此统一。
 */

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PROXY_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || '8000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '1', 10);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

const LIVE_HEADER_TIMEOUT_MS = 15_000;

/** 旧路径形式的地址解码（`/api/proxy/<encoded>`），非法编码时原样返回 */
export function decodePathTarget(encodedUrl: string): string {
  try {
    return decodeURIComponent(encodedUrl);
  } catch {
    return encodedUrl;
  }
}

/** 查询串形式的地址读取：`?url=`，缺失或空串返回 null */
export function readTargetFromQuery(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get('url');
  return raw && raw.trim() ? raw : null;
}

/**
 * 代理专用上游抓取：手动逐跳跟随跳转，每一跳重新执行 SSRF 校验。
 * 不能用 redirect:'follow'——预检之后 fetch 自动跟随的 3xx 可把请求
 * 带进内网/元数据地址，绕过对首跳的校验。
 * 返回最终 URL：m3u8 内相对分片地址必须以重定向后的 URL 为 base 解析。
 */
async function proxyFetch(
  targetUrl: string,
  init: { headers: Record<string, string> }
): Promise<{ res: Response; finalUrl: string }> {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = await checkUpstreamAllowed(current);
    if (!verdict.ok) {
      throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
    }
    const res = await fetch(current, {
      headers: init.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current };
    current = new URL(location, current).href;
  }
  throw new Error('重定向次数过多');
}

/**
 * 精确域名匹配：仅 `douban.com` 本身及其子域放行。
 * 不能用 endsWith('douban.com')——那样 `evil-douban.com` 也会命中，形成鉴权绕过。
 */
function isDoubanHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'douban.com' || h.endsWith('.douban.com') ||
    h === 'doubanio.com' || h.endsWith('.doubanio.com')
  );
}

/**
 * 未登录即可代理的图片域白名单（精确后缀匹配，防 `evil-bgm.tv` 类绕过）：
 * 豆瓣封面需要 Referer 伪装；cmliussss 镜像、热榜 cover_proxy 镜像与 Bangumi 封面
 * 均为公开图片 CDN，无 Referer 校验，仅需防开放代理滥用。
 */
function isAnonymousImageHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    isDoubanHost(h) ||
    h === 'doubanio.viki.moe' || h.endsWith('.doubanio.viki.moe') ||
    h === 'doubanio.cmliussss.net' || h.endsWith('.doubanio.cmliussss.net') ||
    h === 'doubanio.cmliussss.com' || h.endsWith('.doubanio.cmliussss.com') ||
    h === 'bgm.tv' || h.endsWith('.bgm.tv')
  );
}

// 未鉴权的图片等资源也允许走代理（豆瓣防盗链需要 Referer 伪装）；
// 但为防止被当作开放代理滥用，仅放行上述公开图片域，其余必须已登录。
function looksLikeImageUrl(target: string): boolean {
  const host = (() => {
    try { return new URL(target).hostname; } catch { return ''; }
  })();
  return isAnonymousImageHost(host);
}

/**
 * 豆瓣图片候选链（参考 LibreTV 前身 v 项目的图片获取方案）：
 * 原址 → imgN.doubanio.com 归一化为 img3 → cmliussss.net / .com 镜像。
 * doubanio 直连常被反盗链拒绝（403/418 或 HTML 挑战页），cmliussss 镜像无需
 * Referer 即可稳定回源；仅在目标确为 doubanio 时启用，bgm/viki 等单一直连。
 */
function doubanImageCandidates(target: string): string[] {
  const candidates = [target];
  try {
    const u = new URL(target);
    if (!isDoubanHost(u.hostname)) return candidates;
    const normalized = u.href.replace(/^https?:\/\/img\d+\.doubanio\.com/i, 'https://img3.doubanio.com');
    if (normalized !== u.href) candidates.push(normalized);
    const suffix = u.pathname + u.search;
    candidates.push(`https://img.doubanio.cmliussss.net${suffix}`);
    candidates.push(`https://img.doubanio.cmliussss.com${suffix}`);
  } catch { /* 忽略非法 URL */ }
  return Array.from(new Set(candidates));
}

/**
 * 通用流式代理：
 * - 已登录会话（httpOnly cookie）→ m3u8 重写后的分片同源请求自动携带，不再有旧版丢鉴权参数的问题；
 * - 未登录仅放行图片目标（豆瓣封面等），且同样受 SSRF 防护约束；
 * - m3u8 文本重写为代理查询串地址，分片/key/map 全部经本站转发，规避上游 CORS。
 */
export async function handleProxyRequest(req: Request, targetUrl: string): Promise<Response> {
  const guarded = guardRequest(req);
  if (guarded && !looksLikeImageUrl(targetUrl)) return guarded;

  if (!isValidProxyUrl(targetUrl)) {
    return new NextResponse('无效的 URL', { status: 400 });
  }
  if (await isBlockedByDNS(targetUrl)) {
    return new NextResponse('不允许访问私有/保留网络地址', { status: 403 });
  }

  // 目标为豆瓣图片时启用镜像候选链；其余目标保持原址单次直连
  const targetHost = (() => {
    try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ''; }
  })();
  const candidates = isDoubanHost(targetHost) ? doubanImageCandidates(targetUrl) : [targetUrl];
  const isImageTarget = looksLikeImageUrl(targetUrl);
  const range = req.headers.get('range');

  let response: Response | undefined;
  let finalUrl = targetUrl;
  let lastError: unknown = null;
outer:
  for (const candidate of candidates) {
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };
    try {
      const h = new URL(candidate).hostname.toLowerCase();
      // cmliussss 镜像虽不校验 Referer，带上也无副作用，统一伪装成豆瓣访客
      if (isDoubanHost(h) || h.endsWith('.cmliussss.net') || h.endsWith('.cmliussss.com')) {
        headers.Referer = 'https://movie.douban.com/';
      }
    } catch { /* 忽略非法 URL */ }
    if (range) headers.Range = range;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await proxyFetch(candidate, { headers });
        // 反盗链/限流常以 HTML 挑战页回应：命中图片目标时按该候选失败处理，
        // 不重复重试原址，直接换下一个镜像
        const contentType = result.res.headers.get('content-type') || '';
        if (isImageTarget && contentType.includes('text/html')) {
          lastError = new Error('反盗链拒绝（HTML 挑战页）');
          break;
        }
        response = result.res;
        finalUrl = result.finalUrl;
        lastError = null;
        break outer;
      } catch (err) {
        lastError = err;
      }
    }
  }
  if (!response) {
    return new NextResponse(
      `代理请求失败: ${lastError instanceof Error ? lastError.message : '未知错误'}`,
      { status: 502 }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    targetUrl.toLowerCase().endsWith('.m3u8');

  // m3u8 文本：重写为代理查询串地址（以重定向后的最终 URL 为 base 解析相对地址）
  if (isM3u8) {
    const text = await response.text();
    return new NextResponse(rewriteM3u8(text, finalUrl), {
      status: response.status,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 其余（图片 / JSON / 分片 / key）流式透传
  const outHeaders = new Headers();
  for (const name of ['content-type', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
    const v = response.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  // fetch 会自动解压，转发时必须去掉长度相关头避免浏览器二次解压
  outHeaders.set('Cache-Control', 'public, max-age=3600');
  outHeaders.set('Access-Control-Allow-Origin', '*');

  return new NextResponse(response.body, {
    status: response.status,
    headers: outHeaders,
  });
}

/**
 * 带响应头超时的上游抓取：仅首字节（响应头）限时，超时 abort；
 * 响应头到达后清除计时器，body 流不再受限。手动逐跳跟随重定向，
 * 每一跳重新执行 SSRF 校验（302 跳内网是经典绕过手法）。
 * 返回最终 URL：gslb 调度源 302 后路径会变，manifest 内相对分片地址
 * 必须以最终 URL 为 base 解析，否则分片请求会 404。
 */
async function fetchLiveUpstream(
  targetUrl: string,
  headers: Record<string, string>,
  controller: AbortController
): Promise<{ res: Response; finalUrl: string }> {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = await checkLiveUrlAllowed(current);
    if (!verdict.ok) throw new Error(`跳转目标被拒绝: ${verdict.reason}`);

    const timer = setTimeout(() => controller.abort(), LIVE_HEADER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current };
    current = new URL(location, current).href;
  }
  throw new Error('重定向次数过多');
}

/**
 * 直播流专用长连接代理（不复用 /api/proxy）：
 *
 * /api/proxy 的 AbortSignal.timeout 作用于整个响应流，数秒后即切断长连接——
 * 对 HTTP-FLV（单一无限长连接）是致命的。
 * 本实现改为「仅对响应头等待设超时」：fetch 拿到响应头后立即清除计时器，
 * 之后 body 无限时长流式透传，直到客户端断开。
 *
 * - 不重试（重试对直播无意义）；
 * - m3u8 manifest 仍需重写（变体/分片地址改指本路由），FLV 等纯透传；
 * - 每一跳都强制 SSRF 校验（不信任解析阶段的校验结果）；
 * - 部署者可设 LIVE_ALLOW_PRIVATE=1 显式放行内网自建源（默认拒绝）。
 */
export async function handleLiveStreamRequest(req: Request, targetUrl: string): Promise<Response> {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const verdict = await checkLiveUrlAllowed(targetUrl);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const controller = new AbortController();
  // 客户端断开（切台/关页）时终止上游连接，防止连接泄漏
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };

  let response: Response;
  let finalUrl: string;
  try {
    const result = await fetchLiveUpstream(targetUrl, headers, controller);
    response = result.res;
    finalUrl = result.finalUrl;
  } catch (err) {
    return jsonError(
      `直播流连接失败: ${err instanceof Error ? err.message : '未知错误'}`,
      502
    );
  }

  if (!response.ok && response.body) {
    // 非直播正常响应（403/404 等）：透传原始状态码便于前端与开发者工具定位
    // （一律包成 502 会掩盖「token 过期 403」与「源瞬断」的区别）
    try { await response.body.cancel(); } catch { /* 忽略 */ }
    return NextResponse.json(
      { error: `直播流上游返回 ${response.status}` },
      {
        status: response.status,
        headers: { 'Cache-Control': 'no-store', 'X-Live-Upstream-Status': String(response.status) },
      }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    targetUrl.toLowerCase().split('?')[0].endsWith('.m3u8');

  // HLS manifest：重写变体/分片地址指向本路由，保证后续请求同源同鉴权。
  // 关键：以重定向后的最终 URL 为 base 解析相对地址（gslb 调度源 302 后路径会变）
  if (isM3u8) {
    const text = await response.text();
    return new NextResponse(rewriteM3u8(text, finalUrl, 0, '/api/live/stream?url='), {
      status: response.status,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  }

  // FLV / TS 等流媒体：纯流式透传（禁止缓冲与缓存）
  const outHeaders = new Headers();
  const ct = contentType || 'video/mp2t';
  outHeaders.set('Content-Type', ct);
  outHeaders.set('Cache-Control', 'no-store, no-transform');
  outHeaders.set('X-Accel-Buffering', 'no');

  return new NextResponse(response.body, {
    status: response.status,
    headers: outHeaders,
  });
}
