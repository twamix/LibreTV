/**
 * 内存滑动窗口限流：给无登录态的公开代理接口用（TVBOX 客户端没有 cookie，走 token 认证）。
 * 单进程内存实现——多实例部署时每实例独立计数，精度够用（防无意刷，不防分布式攻击）。
 */

const buckets = new Map<string, number[]>();

/** 超过该规模时顺手清理全部过期桶，防止 key 爆炸 */
const MAX_BUCKETS = 2000;

export interface RateLimitResult {
  ok: boolean;
  /** 被限时告知调用方多久后可重试（毫秒） */
  retryAfterMs?: number;
}

export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, stamps] of buckets) {
      const valid = stamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) buckets.delete(k);
      else buckets.set(k, valid);
    }
  }
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    const oldest = stamps[0];
    return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - oldest)) };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { ok: true };
}

/** 仅供单测清理状态 */
export function resetRateLimits(): void {
  buckets.clear();
}
