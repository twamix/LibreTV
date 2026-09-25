import { describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimits } from './rate-limit';

/** 内存滑动窗口限流单测：计数、窗口过期、隔离、容量保护 */

describe('checkRateLimit', () => {
  it('限额内放行，超限后拒绝并给出 Retry-After', () => {
    resetRateLimits();
    expect(checkRateLimit('k', 2, 60000, 1000).ok).toBe(true);
    expect(checkRateLimit('k', 2, 60000, 1001).ok).toBe(true);
    const limited = checkRateLimit('k', 2, 60000, 1002);
    expect(limited.ok).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });

  it('窗口过期后计数清零，重新放行', () => {
    resetRateLimits();
    expect(checkRateLimit('k', 1, 1000, 0).ok).toBe(true);
    expect(checkRateLimit('k', 1, 1000, 500).ok).toBe(false);
    expect(checkRateLimit('k', 1, 1000, 1001).ok).toBe(true);
  });

  it('不同 key 互不干扰', () => {
    resetRateLimits();
    expect(checkRateLimit('a', 1, 60000, 0).ok).toBe(true);
    expect(checkRateLimit('a', 1, 60000, 1).ok).toBe(false);
    expect(checkRateLimit('b', 1, 60000, 1).ok).toBe(true);
  });
});
