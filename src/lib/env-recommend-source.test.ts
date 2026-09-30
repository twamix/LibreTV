import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnvRecommendSource } from './env-recommend-source';

const KEY = 'DEFAULT_RECOMMEND_SOURCE';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  vi.restoreAllMocks();
});

describe('getEnvRecommendSource', () => {
  it('未配置时返回 undefined', () => {
    delete process.env[KEY];
    expect(getEnvRecommendSource()).toBeUndefined();
  });

  it('空值与纯空白视为未配置', () => {
    for (const v of ['', '   ']) {
      process.env[KEY] = v;
      expect(getEnvRecommendSource()).toBeUndefined();
    }
  });

  it('三个合法取值（大小写不敏感，自动去空白）', () => {
    for (const [raw, expected] of [
      ['douban', 'douban'],
      ['BANGUMI', 'bangumi'],
      [' hot-list ', 'hot-list'],
    ] as const) {
      process.env[KEY] = raw;
      expect(getEnvRecommendSource()).toBe(expected);
    }
  });

  it('非法取值返回 undefined 而非抛错，并告警提示可选值', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[KEY] = 'maoyan';
    expect(getEnvRecommendSource()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
