import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { clearShares, saveShare } from '@/lib/share-store';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ ok: true })),
}));

/**
 * 本站直链读取单测：id 格式校验、快照命中、失效提示。
 * 无登录态（TVBOX 客户端没有 cookie），id 本身就是凭证。
 */

beforeEach(() => {
  clearShares();
});

function makeRequest(path: string): { req: Request; params: Promise<{ id: string }> } {
  const id = path.split('/').pop() ?? '';
  return {
    req: new Request(`https://home.example.com/api/share/${id}`),
    params: Promise.resolve({ id }),
  };
}

describe('GET /api/share/[id]', () => {
  it('命中快照时原样返回发布文本', async () => {
    const text = JSON.stringify({ sources: [{ name: 'A', url: 'https://a.example.com/x' }] });
    const id = saveShare(text);
    const { req, params } = makeRequest(id);
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(text);
  });

  it('id 格式非法时返回 400', async () => {
    const { req, params } = makeRequest('not-a-share-id');
    const res = await GET(req, { params });
    expect(res.status).toBe(400);
  });

  it('快照不存在时返回 404 提示重新发布', async () => {
    const id = 'a'.repeat(32);
    const { req, params } = makeRequest(id);
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('重新发布') });
  });
});
