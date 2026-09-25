import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { clearShares, getShareText } from '@/lib/share-store';

/**
 * 发布接口单测：登录守卫、字段白名单与条数上限，以及本站直链形状。
 * 内容直存服务端内存，不再经过第三方粘贴板——断言返回的直链能读回原文。
 */

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

/** 从直链 URL 反查内存快照原文（两步发布的 tvbox-proxy 会存两份，逐个查） */
function readShareText(shareUrl: string): string | null {
  const m = /\/api\/share\/([0-9a-f]{32,64})/i.exec(shareUrl);
  return m ? getShareText(m[1]) : null;
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  clearShares();
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

  it('没有任何可用源时返回 400，且不存快照', async () => {
    const res = await POST(makeRequest({ sources: [], liveSources: [] }));
    expect(res.status).toBe(400);
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
    const json = (await res.json()) as { url: string };
    const published = readShareText(json.url) ?? '';
    expect(published).toContain('a.example.com');
    expect(published).toContain('live.example.com/tv.m3u');
    expect(published).not.toContain('etc/passwd');
    expect(published).not.toContain('evil');
    expect(published).not.toContain('secret');
  });

  it('成功时返回本站直链、来源标识与条数统计', async () => {
    const res = await POST(
      makeRequest({
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u' }],
      })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/local\.test\/api\/share\/[0-9a-f]{32,64}$/),
      provider: '本站直链',
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
    const json = (await res.json()) as { url: string; format: string; sources: number; liveSources: number };
    expect(json).toMatchObject({ format: 'tvbox', sources: 1, liveSources: 1 });

    const published = readShareText(json.url) ?? '';
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
    const json = (await res.json()) as { url: string; format: string };
    expect(json.format).toBe('libretv');
    expect(readShareText(json.url) ?? '').toContain('"version": 2');
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
    const json = (await res.json()) as { url: string };
    const published = readShareText(json.url) ?? '';
    expect(published).toContain('a.example.com');
    expect(published).not.toContain('isAdult');
  });

  it('format=tvbox-proxy 时单步发布：源列表带 proxyToken，TVBOX 配置为单 proxy site + 直连 lives', async () => {
    const res = await POST(
      makeRequest({
        format: 'tvbox-proxy',
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod' }],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u', epg: 'https://epg.example.com/e.xml' }],
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; format: string; sources: number; liveSources: number };
    expect(json).toMatchObject({ format: 'tvbox-proxy', sources: 1, liveSources: 1 });
    expect(json.url).toMatch(/^https:\/\/local\.test\/api\/share\/[0-9a-f]{32,64}$/);

    // 第二步存的是 TVBOX 配置：单 proxy site + 直连直播
    const config = JSON.parse(readShareText(json.url) ?? '') as {
      sites: { key: string; type: number; api: string }[];
      lives: { name: string; type: number; url: string; epg?: string }[];
    };
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0].type).toBe(1);
    const apiUrl = new URL(config.sites[0].api);
    expect(`${apiUrl.origin}${apiUrl.pathname}`).toBe('https://local.test/api/tvbox/proxy');
    expect(apiUrl.searchParams.get('token')).toMatch(/^[0-9a-f]{32}$/);
    // list 指向第一步存的本站源列表直链，且 token 与源列表里的 proxyToken 一致
    const listUrl = apiUrl.searchParams.get('list') ?? '';
    expect(listUrl).toMatch(/^https:\/\/local\.test\/api\/share\/[0-9a-f]{32,64}$/);
    const sourceList = JSON.parse(readShareText(listUrl) ?? '') as {
      sources: { url: string }[];
      liveSources: unknown[];
      proxyToken: string;
    };
    expect(sourceList.sources).toHaveLength(1);
    expect(sourceList.liveSources).toHaveLength(0);
    expect(sourceList.proxyToken).toBe(apiUrl.searchParams.get('token'));
    expect(config.lives).toHaveLength(1);
    expect(config.lives[0]).toMatchObject({
      name: 'L',
      type: 0,
      url: 'https://live.example.com/tv.m3u',
      epg: 'https://epg.example.com/e.xml',
    });
  });

  it('format=tvbox-proxy 无点播源时返回 400 且不存快照', async () => {
    const res = await POST(
      makeRequest({
        format: 'tvbox-proxy',
        sources: [],
        liveSources: [{ name: 'L', url: 'https://live.example.com/tv.m3u' }],
      })
    );
    expect(res.status).toBe(400);
  });

  it('format=tvbox-proxy 只透出白名单字段，isAdult 不会进入源列表', async () => {
    const res = await POST(
      makeRequest({
        format: 'tvbox-proxy',
        sources: [{ name: 'A', url: 'https://a.example.com/api.php/provide/vod', isAdult: true }],
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string };
    const config = JSON.parse(readShareText(json.url) ?? '') as { sites: { api: string }[] };
    const listUrl = new URL(config.sites[0].api).searchParams.get('list') ?? '';
    const sourceListText = readShareText(listUrl) ?? '';
    expect(sourceListText).toContain('a.example.com');
    expect(sourceListText).not.toContain('isAdult');
  });
});
