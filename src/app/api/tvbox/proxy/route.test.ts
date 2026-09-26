import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { resetRateLimits } from '@/lib/rate-limit';
import { clearShares, saveShare } from '@/lib/share-store';
import type { SourceSearchOutcome } from '@/lib/types';

/**
 * 家庭过滤版 TVBOX 代理单测：认证、CMS 协议形状、强制成人过滤、详情拼装、限流。
 * 源列表走本站直链（真实 share-store 内存快照）；旧粘贴板链接走出网拉取（mock）。
 * searchSource 只 mock 数据来源，真实的 aggregateOutcomes 跑过滤——
 * 正是要验证「强制过滤关不掉」。
 */

const TOKEN = 'test-token-123';
const SOURCE_LIST_TEXT = JSON.stringify({
  name: 'LibreTV-SourceList',
  version: 2,
  sources: [
    { name: 'A', url: 'https://a.example.com/api.php/provide/vod' },
    { name: 'B', url: 'https://b.example.com/api.php/provide/vod' },
  ],
  liveSources: [],
  proxyToken: TOKEN,
});

const LEGACY_LIST_URL = 'https://paste.rs/legacy-list';

/** 本轮测试用的本站直链（beforeEach 里重新存，隔离快照状态） */
let listUrl = '';

const state = vi.hoisted(() => ({
  /** searchSource 返回的原始 outcome（含成人条目，由真实 aggregateOutcomes 过滤） */
  searchOutcome: null as SourceSearchOutcome | null,
  detailResult: { ok: true as const, detail: { episodes: [] as string[], videoInfo: {} } } as unknown as
    | { ok: true; detail: { episodes: string[]; videoInfo: Record<string, unknown> } }
    | { ok: false; blocked?: string },
}));

vi.mock('@/lib/fetch-utils', () => ({
  fetchUpstream: vi.fn(async () => new Response(SOURCE_LIST_TEXT, { status: 200 })),
  getCache: vi.fn(() => undefined),
  setCache: vi.fn(() => {}),
}));

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/search-aggregate', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/search-aggregate')>();
  return {
    ...mod,
    searchSource: vi.fn(async (): Promise<SourceSearchOutcome> => {
      if (!state.searchOutcome) throw new Error('searchOutcome 未设置');
      return state.searchOutcome;
    }),
  };
});

vi.mock('@/lib/detail-resolve', () => ({
  resolveDetail: vi.fn(async () => state.detailResult),
  DETAIL_CACHE_TTL: 60 * 1000,
}));

function makeRequest(params: Record<string, string>): Request {
  const sp = new URLSearchParams(params);
  return new Request(`https://home.example.com/api/tvbox/proxy?${sp.toString()}`);
}

function searchOutcomeWith(items: { vodId: string; name: string; typeName?: string }[]): SourceSearchOutcome {
  return {
    sourceKey: 'proxy_0',
    ok: true,
    list: items.map((item) => ({
      sourceKey: 'proxy_0',
      sourceName: 'A',
      vodId: item.vodId,
      name: item.name,
      typeName: item.typeName,
      sourceUrl: 'https://a.example.com/api.php/provide/vod',
    })),
  };
}

beforeEach(() => {
  resetRateLimits();
  clearShares();
  listUrl = `https://home.example.com/api/share/${saveShare(SOURCE_LIST_TEXT)}`;
  state.searchOutcome = null;
  state.detailResult = {
    ok: true,
    detail: {
      episodes: ['https://cdn.example.com/1.m3u8', 'https://cdn.example.com/2.m3u8'],
      videoInfo: { title: '正片', typeName: '动作片' },
    },
  } as unknown as typeof state.detailResult;
});

describe('GET /api/tvbox/proxy', () => {
  it('缺少 list 或 token 时返回 401', async () => {
    expect((await GET(makeRequest({ list: listUrl }))).status).toBe(401);
    expect((await GET(makeRequest({ token: TOKEN }))).status).toBe(401);
  });

  it('token 对不上返回 403', async () => {
    const res = await GET(makeRequest({ list: listUrl, token: 'wrong', ac: 'videolist', wd: ' test ' }));
    expect(res.status).toBe(403);
  });

  it('ac 非法时返回 400', async () => {
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'xxx' }));
    expect(res.status).toBe(400);
  });

  it('ac=list 返回空分类（TVBOX 分类请求不报错）', async () => {
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'list' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { code: number; class: unknown[]; list: unknown[] };
    expect(json.code).toBe(1);
    expect(json.class).toEqual([]);
    expect(json.list).toEqual([]);
  });

  it('无 ac 无 wd 时返回首页聚合（TVBOX 进站首屏不再空白）', async () => {
    state.searchOutcome = searchOutcomeWith([
      { vodId: '100', name: '正片', typeName: '动作片' },
      { vodId: '200', name: '坏东西', typeName: '伦理片' },
    ]);
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { code: number; total: number; list: { vod_name: string }[] };
    expect(json.code).toBe(1);
    // 空关键词不过相关性过滤，上游最新直接展示；成人条目仍被强制过滤
    expect(json.total).toBe(1);
    expect(json.list[0].vod_name).toBe('正片');
  });

  it('搜索返回 CMS 形状：成人条目被强制过滤，vod_id 可解回源序号与上游 id', async () => {
    state.searchOutcome = searchOutcomeWith([
      { vodId: '100', name: '正片', typeName: '动作片' },
      { vodId: '200', name: '坏东西', typeName: '伦理片' },
    ]);
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      code: number; page: number; pagecount: number; limit: number; total: number;
      list: { vod_id: string; vod_name: string; type_name: string }[];
    };
    expect(json.code).toBe(1);
    expect(json.total).toBe(1);
    expect(json.list).toHaveLength(1);
    expect(json.list[0].vod_name).toBe('正片');
    // vod_id 解码：p<源序号>:<上游id>
    const raw = Buffer.from(json.list[0].vod_id, 'base64url').toString('utf8');
    expect(raw).toBe('p0:100');
  });

  it('旧粘贴板链接仍走出网拉取（兼容以前已发布的链接）', async () => {
    state.searchOutcome = searchOutcomeWith([{ vodId: '100', name: '正片', typeName: '动作片' }]);
    const res = await GET(makeRequest({ list: LEGACY_LIST_URL, token: TOKEN, ac: 'videolist', wd: '正片' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(1);
  });

  it('直链快照丢失时（服务重启）返回 502 提示重新发布', async () => {
    clearShares();
    state.searchOutcome = searchOutcomeWith([{ vodId: '100', name: '正片', typeName: '动作片' }]);
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片' }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('重新发布') });
  });

  it('搜索翻页：pg 越界只切片，结果总数不变', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ vodId: String(i), name: `正片${i}`, typeName: '动作片' }));
    state.searchOutcome = searchOutcomeWith(items);
    const first = (await (await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片', pg: '1' }))).json()) as {
      total: number; pagecount: number; list: unknown[];
    };
    expect(first.total).toBe(25);
    expect(first.pagecount).toBe(2);
    expect(first.list).toHaveLength(20);
    const second = (await (await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片', pg: '2' }))).json()) as {
      list: unknown[];
    };
    expect(second.list).toHaveLength(5);
  });

  it('详情：vod_play_url 按「线路$$$第N集$地址」拼装', async () => {
    state.searchOutcome = searchOutcomeWith([{ vodId: '100', name: '正片', typeName: '动作片' }]);
    const search = (await (
      await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片' }))
    ).json()) as { list: { vod_id: string }[] };
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', ids: search.list[0].vod_id }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { list: { vod_play_url: string; vod_name: string }[] };
    expect(json.list[0].vod_name).toBe('正片');
    expect(json.list[0].vod_play_url).toBe(
      'LibreTV-家庭过滤$$$第1集$https://cdn.example.com/1.m3u8#第2集$https://cdn.example.com/2.m3u8'
    );
  });

  it('详情：分类命中成人关键词时直接 404（搜索页 type_name 缺失的兜底）', async () => {
    state.searchOutcome = searchOutcomeWith([{ vodId: '100', name: '可疑片' }]);
    const search = (await (
      await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', wd: '可疑' }))
    ).json()) as { list: { vod_id: string }[] };
    state.detailResult = {
      ok: true,
      detail: { episodes: ['https://cdn.example.com/1.m3u8'], videoInfo: { title: '可疑片', typeName: '伦理片' } },
    } as unknown as typeof state.detailResult;
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'detail', ids: search.list[0].vod_id }));
    expect(res.status).toBe(404);
  });

  it('无效的 ids 返回 400', async () => {
    const res = await GET(makeRequest({ list: listUrl, token: TOKEN, ac: 'videolist', ids: 'not-base64!!' }));
    expect(res.status).toBe(400);
  });

  it('单链接每分钟超过 120 次返回 429', async () => {
    state.searchOutcome = searchOutcomeWith([{ vodId: '1', name: '正片', typeName: '动作片' }]);
    const params = { list: listUrl, token: TOKEN, ac: 'videolist', wd: '正片' };
    let last: Response | undefined;
    for (let i = 0; i < 121; i++) {
      last = await GET(makeRequest(params));
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('Retry-After')).toBeTruthy();
  }, 30000);
});
