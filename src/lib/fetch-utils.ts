/** 服务端上游请求工具：超时、重试、安全跳转、JSON 解析 */

import { checkLiveUrlAllowed, checkUpstreamAllowed, runWithSSRFProtection } from './ssrf';

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /**
   * 安全跳转（默认开启）：禁用 fetch 的自动跟随，改为手动逐跳跟随，
   * 每一跳重新执行 SSRF 校验——否则公网 URL 可 302 跳转到内网地址绕过预检。
   */
  safeRedirects?: boolean;
  /**
   * 直播场景放行内网地址（自建 IPTV）：仅在部署者设置 LIVE_ALLOW_PRIVATE=1 时生效。
   * 校验复用 checkLiveUrlAllowed，与直播流代理使用同一把尺子。
   */
  allowPrivate?: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export interface FetchResult {
  res: Response;
  /** 跟随重定向后的最终 URL（manual 模式下 res.url 不可靠，须自行跟踪）。
   *  解析 manifest 内的相对地址必须用它，否则分片路径会指向错误目录。 */
  finalUrl: string;
}

/**
 * 把连接层 SSRF 拦截错误翻译成可读提示。
 * 底层抛的是 `TypeError: fetch failed`，真正的原因在 cause.code 里；
 * 不翻译的话用户只会看到「上游请求失败」这种没有信息量的文案。
 */
function normalizeSSRFError(err: unknown): never {
  if (
    err &&
    typeof err === 'object' &&
    'cause' in err &&
    err.cause &&
    typeof err.cause === 'object' &&
    'code' in err.cause &&
    (err.cause as { code?: string }).code === 'ERR_SSRF_BLOCKED'
  ) {
    const cause = err.cause as { message?: string };
    throw new Error(`连接目标被拒绝: ${cause.message || '目标地址被拒绝'}`);
  }
  throw err;
}

export async function fetchUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

/** 同 fetchUpstream，额外返回重定向后的最终 URL */
export async function fetchUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 8000, retries = 0, safeRedirects = true, allowPrivate = false, ...init } = options;
  // 外部 signal（调用方的总死线中断）与单次超时合并：任一触发即中断请求
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!safeRedirects) {
        try {
          // 自动跟随也要走连接级防护：预检之后 fetch 自己跟的 3xx 同样可能进内网
          const res = await runWithSSRFProtection({ allowPrivate }, () =>
            fetch(url, {
              ...init,
              signal,
              redirect: init.redirect ?? 'follow',
            })
          );
          return { res, finalUrl: res.url || url };
        } catch (err) {
          normalizeSSRFError(err);
        }
      }
      // 手动逐跳跟随，每一跳重新过 SSRF 校验
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        const verdict = allowPrivate
          ? await checkLiveUrlAllowed(current)
          : await checkUpstreamAllowed(current);
        if (!verdict.ok) {
          throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
        }
        const res = await runWithSSRFProtection({ allowPrivate }, () =>
          fetch(current, {
            ...init,
            redirect: 'manual',
            signal,
          })
        ).catch((err: unknown) => normalizeSSRFError(err));
        if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
        const location = res.headers.get('location');
        if (!location) return { res, finalUrl: current };
        current = new URL(location, current).href;
      }
      throw new Error('重定向次数过多');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上游请求失败');
}

export async function fetchUpstreamJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await fetchUpstream(url, options);
  if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
  const data = (await res.json()) as T;
  return data;
}

/** 内存 TTL 缓存（豆瓣推荐等热点数据） */
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function getCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCache(key: string, value: unknown, ttlMs: number): void {
  if (cache.size > 500) {
    // 简单防膨胀：超限时清掉最早过期的条目
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
    if (cache.size > 500) cache.clear();
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
