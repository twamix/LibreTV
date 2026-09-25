import { beforeEach, describe, expect, it } from 'vitest';
import { clearShares, extractShareId, getShareText, saveShare } from './share-store';

/**
 * 本站直链快照存储单测：存取往返、id 不可猜、分享 URL 反解、容量淘汰。
 */

beforeEach(() => {
  clearShares();
});

describe('share-store', () => {
  it('存入文本后凭 id 原样取回', () => {
    const id = saveShare('{"a":1}');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(getShareText(id)).toBe('{"a":1}');
  });

  it('不存在的 id 返回 null（调用方统一提示重发）', () => {
    expect(getShareText('0'.repeat(32))).toBeNull();
  });

  it('每次存入的 id 都不同（不可猜）', () => {
    const ids = new Set(Array.from({ length: 20 }, () => saveShare('x')));
    expect(ids.size).toBe(20);
  });

  it('extractShareId 支持裸 id 与完整分享 URL，非本站链接返回 null', () => {
    const id = saveShare('x');
    expect(extractShareId(id)).toBe(id);
    expect(extractShareId(`https://home.example.com/api/share/${id}`)).toBe(id);
    expect(extractShareId('https://paste.rs/abc123')).toBeNull();
    expect(extractShareId('not-a-url')).toBeNull();
  });

  it('超过容量上限时淘汰最早的快照', () => {
    const first = saveShare('first');
    for (let i = 0; i < 500; i++) saveShare(`fill-${i}`);
    expect(getShareText(first)).toBeNull();
  });
});
