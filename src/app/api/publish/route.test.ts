import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 发布接口单测：登录守卫、字段白名单与条数上限。
 * 这里只验证「接口不成为任意内容上传通道」，真实上传逻辑由发布器自身测试覆盖。
 */

const state = vi.hoisted(() => ({
  /** 记录传给发布器的文本，用于断言白名单是否生效 */
  publishedText: null as string | null,
  fail: false,
}));

vi.mock('@/lib/source-list-publish', () => ({
  MAX_PUBLISH_BYTES: 256 * 1024,
  publishSourceList: vi.fn(async (text: string) => {
    if (state.fail) throw new Error('发布失败：paste.rs（HTTP 500）');
    state.publishedText = text;
    return { url: 'https://paste.rs/abc123', provider: 'paste.rs' };
  }),
}));

function makeRequest(body: unknown, options?: { authenticated?: boolean }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.authenticated !== false) {
    headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  }
  return new Request('https://local.test/api/publish', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  state.publishedText = null;
  state.fail = false;
});

describe('POST /api/publish', () => {
  it('未登录直接被守卫拦下', async () => {
    const res = await POST(makeRequest({ sources: [] }, { authenticated: false }));
    expect(res.status).toBe(401);
  });

  it('请求体不是合法 JSON 时返回 400', async () => {
    const res = await POST(makeRequest('not json'));
    expect(res.status).toBe(400);
  });

  it('没有任何可用源时返回 400，且不触达粘贴板', async () => {
    const res = await POST(makeRequest({ sources: [], liveSources: [] }));
    expect(res.status).toBe(400);
    expect(state.publishedText).toBeNull();
  });

  it('只透出白名单字段：未知键与非 http 地址一律剔除', async () => {
    const res = await POST(
      makeRequest({
        name: '我的源',
        sources: [
          { name: 'A', url: 'https://a.example.com/api.php/provide/vod', evil: 'should-not-appear' },
          { name: 'B', url: 'file:///etc/passwd' },
        ],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u', epg: 'https://epg.example.com/e.xml' }],
        extraTopLevel: { secret: 1 },
      })
    );
    expect(res.status).toBe(200);
    const published = state.publishedText ?? '';
    expect(published).toContain('a.example.com');
    expect(published).toContain('live.example.com/tv.m3u');
    expect(published).not.toContain('etc/passwd');
    expect(published).not.toContain('evil');
    expect(published).not.toContain('secret');
  });

  it('成功时返回链接、来源与条数统计', async () => {
    const res = await POST(
      makeRequest({
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u' }],
      })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      url: 'https://paste.rs/abc123',
      provider: 'paste.rs',
      format: 'libretv',
      sources: 1,
      liveSources: 1,
    });
  });

  it('format=tvbox 时发布为 sites/lives 结构且本站订阅入口认得回来', async () => {
    const res = await POST(
      makeRequest({
        format: 'tvbox',
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u', epg: 'https://epg.example.com/e.xml' }],
      })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: 'tvbox', sources: 1, liveSources: 1 });

    const published = state.publishedText ?? '';
    const config = JSON.parse(published) as {
      sites: { key: string; type: number; api: string }[];
      lives: { name: string; type: number; url: string; epg?: string }[];
    };
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0]).toMatchObject({ key: 'A', type: 1, api: 'https://a.example.com/api.php/provide/vod' });
    expect(config.lives).toHaveLength(1);
    expect(config.lives[0]).toMatchObject({
      name: 'L',
      type: 0,
      url: 'https://live.example.com/tv.m3u',
      epg: 'https://epg.example.com/e.xml',
    });
    // 发布出去的不是本站格式，不应带 version/sources 顶层键
    expect(published).not.toContain('"sources"');
  });

  it('format 非法时回落为本站格式', async () => {
    const res = await POST(
      makeRequest({
        format: 'unknown-format',
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
      })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: 'libretv' });
    expect(state.publishedText ?? '').toContain('"version": 2');
  });

  it('成人内容按源标记过滤：前端负责剔除，接口只透出白名单字段', async () => {
    // isAdult 等未知键必须被 normalizePayload 剔除——发布文本里不能出现源标记之外的元信息；
    // 成人源的取舍由前端按 yellowFilter / adultUnlocked 决定后只传可用源，接口侧不再二次判断
    const res = await POST(
      makeRequest({
        format: 'tvbox',
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod', isAdult: true }],
      })
    );
    expect(res.status).toBe(200);
    const published = state.publishedText ?? '';
    expect(published).toContain('a.example.com');
    expect(published).not.toContain('isAdult');
  });

  it('发布器全部失败时返回 502 并透出原因', async () => {
    state.fail = true;
    const res = await POST(makeRequest({ sources: [{ name: 'A', url: 'https://a.example.com/x' }] }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('paste.rs') });
  });
});
