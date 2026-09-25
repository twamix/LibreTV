import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { clearShares, saveShare } from '@/lib/share-store';

/**
 * 订阅接口单测（本站直链部分）：直链读内存快照，不走出网、不受 SSRF 规则影响；
 * 旧粘贴板链接与格式识别逻辑由原有测试覆盖，这里只补直链分支。
 */

const state = vi.hoisted(() => ({
  body: null as unknown,
  rawText: null as string | null,
  proxyAllowed: (() => true) as (url: string) => boolean,
  liveAllowed: true as boolean,
}));

vi.mock('@/lib/fetch-utils', () => ({
  fetchUpstream: vi.fn(
    async () =>
      new Response(state.rawText ?? JSON.stringify(state.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  ),
}));

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: state.liveAllowed })),
  isValidProxyUrl: vi.fn((url: string) => state.proxyAllowed(url)),
}));

function makeRequest(subUrl: string): Request {
  const { token } = signSession();
  const sp = new URLSearchParams({ url: subUrl });
  return new Request(`https://local.test/api/source-list?${sp.toString()}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  delete process.env.PROXY_SECRET;
});

beforeEach(() => {
  clearShares();
  state.body = null;
  state.rawText = null;
  state.proxyAllowed = () => true;
  state.liveAllowed = true;
});

describe('GET /api/source-list（本站直链）', () => {
  it('直链读内存快照：落盘格式原样导入', async () => {
    const id = saveShare(
      JSON.stringify({
        name: 'LibreTV-SourceList',
        version: 2,
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u' }],
      })
    );
    const res = await GET(makeRequest(`https://local.test/api/share/${id}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sources: { url: string }[]; liveSources: { url: string }[] };
    expect(json.sources.map((s) => s.url)).toEqual(['https://a.example.com/api.php/provide/vod']);
    expect(json.liveSources.map((s) => s.url)).toEqual(['https://live.example.com/tv.m3u']);
  });

  it('直链快照丢失时返回 404 提示重新发布', async () => {
    const res = await GET(makeRequest(`https://local.test/api/share/${'b'.repeat(32)}`));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('重新发布') });
  });
});
