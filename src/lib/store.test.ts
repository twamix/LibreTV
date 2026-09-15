import { beforeEach, describe, expect, it, vi } from 'vitest';

// store.ts 运行时引用 db.ts（IndexedDB），node 测试环境下 mock 掉
vi.mock('./db', () => ({
  db: {},
  clearLiveProbeResultsDb: vi.fn(async () => {}),
  loadLiveProbeResults: vi.fn(async () => ({})),
  saveLiveProbeResults: vi.fn(async () => {}),
}));

import {
  isInDisabledSubscription,
  isSourceDisabled,
  keyBelongsToSubscription,
  SOURCE_DISABLE_LADDER,
  subKeyPrefix,
  useAppStore,
} from './store';

const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    customAPIs: [],
    selectedKeys: [],
    subscriptions: [],
    sourceHealth: {},
    liveSubscriptions: [],
    liveSelectedUrls: [],
    liveFavorites: [],
    liveRecent: [],
    yellowFilter: false,
  });
});

describe('subKeyPrefix / keyBelongsToSubscription', () => {
  it('key 完整形态为 `${prefix}_${i}`，归属判断要求前缀后紧跟分隔符', () => {
    const prefix = subKeyPrefix('https://sub.example.com/list.json');
    expect(prefix.startsWith('sub_')).toBe(true);
    expect(keyBelongsToSubscription(`${prefix}_0`, prefix)).toBe(true);
    expect(keyBelongsToSubscription(prefix, prefix)).toBe(true);
    expect(keyBelongsToSubscription('manual_0', prefix)).toBe(false);
  });

  it('真实碰撞构造：hash 互为前缀的两个订阅互不误伤', () => {
    const hashOf = (url: string) => subKeyPrefix(url).slice(4);

    // 找一个 hash36 为 6 位的基准 URL
    let base = '';
    for (let i = 0; i < 10000 && !base; i++) {
      const p = hashOf(`https://base${i}.example.com/list.json`);
      if (p.length === 6) base = p;
    }
    expect(base).not.toBe('');

    // 暴力搜索一个 hash36 以 base 为前缀的 URL
    let colliding: string | null = null;
    for (let i = 0; i < 200000 && !colliding; i++) {
      const p = hashOf(`https://collide${i}.example.com/list.json`);
      if (p !== base && p.startsWith(base)) colliding = `https://collide${i}.example.com/list.json`;
    }
    if (!colliding) return; // 找不到碰撞也不影响测试

    const collidingPrefix = subKeyPrefix(colliding);
    expect(collidingPrefix.startsWith(base)).toBe(true);
    expect(keyBelongsToSubscription(`${collidingPrefix}_0`, base)).toBe(false);
    expect(keyBelongsToSubscription(`${base}_0`, base)).toBe(true);
  });
});

describe('点播源自动停用阶梯', () => {
  const fail = (key: string) => ({ sourceKey: key, ok: false, error: '超时', list: [] as never[] });
  const okOutcome = (key: string) => ({ sourceKey: key, ok: true, ms: 12, list: [] as never[] });
  /** 连续两次搜索失败（每次搜索各记录一次），返回两次调用产生的停用事件合集 */
  const failTwice = (key: string) => [
    ...store().recordSourceHealth([fail(key)]),
    ...store().recordSourceHealth([fail(key)]),
  ];
  /** 模拟停用到期：把截止时间挪到过去 */
  const expire = (key: string) => {
    const entry = store().sourceHealth[key];
    useAppStore.setState({
      sourceHealth: { ...store().sourceHealth, [key]: { ...entry, disabledUntil: Date.now() - 1 } },
    });
  };

  beforeEach(() => useAppStore.setState({ sourceHealth: {} }));

  it('达到阈值才停用，首次为 30 分钟', () => {
    expect(store().recordSourceHealth([fail('a')])).toEqual([]);
    expect(isSourceDisabled(store(), 'a')).toBe(false);

    const events = failTwice('a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'a', level: 1, permanent: false, ttlMs: SOURCE_DISABLE_LADDER[0] });
    expect(isSourceDisabled(store(), 'a')).toBe(true);
  });

  it('到期恢复后再次连续失败 → 升级为 24 小时', () => {
    failTwice('a');
    expire('a');
    expect(isSourceDisabled(store(), 'a')).toBe(false);

    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 2, permanent: false, ttlMs: SOURCE_DISABLE_LADDER[1] });
  });

  it('阶梯用尽 → 长期停用，不随到期恢复，须手动清除', () => {
    failTwice('a');
    expire('a');
    failTwice('a');
    expire('a');
    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 3, permanent: true });
    expect(events[0].ttlMs).toBeUndefined();

    // 即便把停用时间挪到过去也不会自动恢复
    expire('a');
    expect(isSourceDisabled(store(), 'a')).toBe(true);

    store().clearSourceHealth('a');
    expect(isSourceDisabled(store(), 'a')).toBe(false);
  });

  it('成功一次降一级：偶发抽风的源不会一路升到长期停用', () => {
    failTwice('a'); // 第 1 级
    expire('a');
    failTwice('a'); // 第 2 级
    expire('a');

    store().recordSourceHealth([okOutcome('a')]);
    expect(store().sourceHealth['a'].disableCount).toBe(1);

    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 2, permanent: false });
  });

  it('成功后立即清除停用标记与失败连击', () => {
    failTwice('a');
    expect(isSourceDisabled(store(), 'a')).toBe(true);

    store().recordSourceHealth([okOutcome('a')]);
    expect(isSourceDisabled(store(), 'a')).toBe(false);
    expect(store().sourceHealth['a'].failStreak).toBe(0);
  });
});

describe('订阅整体开关', () => {
  const subUrl = 'https://sub.example.com/list.json';
  const otherUrl = 'https://other.example.com/list.json';

  beforeEach(() => {
    useAppStore.setState({ customAPIs: [], selectedKeys: [], subscriptions: [], sourceHealth: {} });
  });

  it('未设置 enabled 的订阅视为启用，不影响其源', () => {
    store().addSubscription(subUrl, 'S');
    expect(store().subscriptions[0].enabled).toBeUndefined();
    expect(isInDisabledSubscription(store(), `${subKeyPrefix(subUrl)}_0`)).toBe(false);
  });

  it('停用订阅仅影响搜索采用：源数据与勾选状态都保留，可无损恢复', () => {
    store().addSubscription(subUrl, 'S');
    const key = `${subKeyPrefix(subUrl)}_0`;
    store().addCustomApi({ key, name: 'A', url: 'https://a.example.com/api.php/provide/vod' });
    store().setSelectedKeys([key]);

    store().setSubscriptionEnabled(subUrl, false);
    expect(isInDisabledSubscription(store(), key)).toBe(true);
    // 关键：无损——源还在、勾选也还在
    expect(store().customAPIs.map((a) => a.key)).toContain(key);
    expect(store().selectedKeys).toContain(key);

    store().setSubscriptionEnabled(subUrl, true);
    expect(isInDisabledSubscription(store(), key)).toBe(false);
  });

  it('只影响本订阅名下的源，其他订阅与手动添加的源不受牵连', () => {
    store().addSubscription(subUrl, 'S');
    store().addSubscription(otherUrl, 'O');
    store().setSubscriptionEnabled(subUrl, false);

    expect(isInDisabledSubscription(store(), `${subKeyPrefix(subUrl)}_1`)).toBe(true);
    expect(isInDisabledSubscription(store(), `${subKeyPrefix(otherUrl)}_1`)).toBe(false);
    expect(isInDisabledSubscription(store(), 'manual_0')).toBe(false);
  });
});

describe('删除撤销（点播源）', () => {
  beforeEach(() => {
    useAppStore.setState({ customAPIs: [], selectedKeys: [], subscriptions: [], sourceHealth: {} });
  });

  const add = (key: string) =>
    store().addCustomApi({ key, name: 'A', url: 'https://a.example.com/api.php/provide/vod' });

  it('removeCustomApi 返回被删条目与勾选态，列表与勾选同步移除', () => {
    add('manual_0');
    store().setSelectedKeys(['manual_0']);

    const snap = store().removeCustomApi('manual_0');
    expect(snap).toEqual({
      entry: expect.objectContaining({ key: 'manual_0', name: 'A' }),
      selected: true,
    });
    expect(store().customAPIs).toHaveLength(0);
    expect(store().selectedKeys).toEqual([]);
  });

  it('删除未勾选的源时快照 selected 为 false', () => {
    add('manual_0');
    store().setSelectedKeys([]);
    const snap = store().removeCustomApi('manual_0');
    expect(snap?.selected).toBe(false);
  });

  it('key 不存在时返回 null，不改动任何状态', () => {
    expect(store().removeCustomApi('nope')).toBeNull();
    expect(store().customAPIs).toHaveLength(0);
  });

  it('restoreCustomApi 原样恢复条目与勾选态', () => {
    add('manual_0');
    store().setSelectedKeys(['manual_0']);
    const snap = store().removeCustomApi('manual_0')!;

    expect(store().restoreCustomApi(snap)).toBe(true);
    expect(store().customAPIs.map((a) => a.key)).toContain('manual_0');
    expect(store().selectedKeys).toContain('manual_0');
  });

  it('key 已被重新占用（如订阅同步生成同 key）时放弃撤销，返回 false 且不重复插入', () => {
    add('manual_0');
    const snap = store().removeCustomApi('manual_0')!;

    // 撤销前同 key 又出现（模拟重新同步/手动重添）
    add('manual_0');
    expect(store().restoreCustomApi(snap)).toBe(false);
    expect(store().customAPIs).toHaveLength(1);
  });

  it('被删时未勾选，撤销后保持未勾选', () => {
    add('manual_0');
    // add 自动勾选，需手动清空以模拟"未勾选"场景
    store().setSelectedKeys([]);
    const snap = store().removeCustomApi('manual_0')!;
    expect(snap.selected).toBe(false);
    store().restoreCustomApi(snap);
    expect(store().selectedKeys).toEqual([]);
  });
});

describe('直播源：删除撤销 / 编辑 / 批量勾选', () => {
  beforeEach(() => {
    useAppStore.setState({ liveSubscriptions: [], liveSelectedUrls: [], liveFavorites: [], liveRecent: [] });
  });

  it('removeLiveSubscription 返回快照并移除条目与勾选；restore 完整恢复', () => {
    store().addLiveSubscription('https://a.example.com/tv.m3u', 'A');
    const snap = store().removeLiveSubscription('https://a.example.com/tv.m3u');

    expect(snap).toEqual({
      entry: expect.objectContaining({ url: 'https://a.example.com/tv.m3u', name: 'A' }),
      selected: true, // addLiveSubscription 默认启用
    });
    expect(store().liveSubscriptions).toHaveLength(0);
    expect(store().liveSelectedUrls).toEqual([]);

    store().restoreLiveSubscription(snap!);
    expect(store().liveSubscriptions.map((s) => s.url)).toContain('https://a.example.com/tv.m3u');
    expect(store().liveSelectedUrls).toContain('https://a.example.com/tv.m3u');
  });

  it('删除不存在的直播源返回 null', () => {
    expect(store().removeLiveSubscription('https://nope.example.com/x.m3u')).toBeNull();
  });

  it('restoreLiveSubscription 遇同 url 已存在时静默放弃（不重复插入）', () => {
    store().addLiveSubscription('https://a.example.com/tv.m3u', 'A');
    const snap = store().removeLiveSubscription('https://a.example.com/tv.m3u')!;
    store().addLiveSubscription('https://a.example.com/tv.m3u', 'A2');
    store().restoreLiveSubscription(snap);
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].name).toBe('A2'); // 保留新条目
  });

  it('updateLiveSubscription 只改 name/epg：url 不变、勾选态不动', () => {
    store().addLiveSubscription('https://a.example.com/tv.m3u', 'A', 'https://epg.example.com/e.gz');
    const before = store().liveSelectedUrls;

    store().updateLiveSubscription('https://a.example.com/tv.m3u', { name: 'B', epg: 'https://epg2.example.com/e.gz' });
    const s = store().liveSubscriptions[0];
    expect(s.name).toBe('B');
    expect(s.epg).toBe('https://epg2.example.com/e.gz');
    expect(s.url).toBe('https://a.example.com/tv.m3u');
    expect(store().liveSelectedUrls).toEqual(before);
  });

  it('setLiveSelectedUrls 整体替换（批量全选/清空）', () => {
    store().addLiveSubscription('https://a.example.com/tv.m3u');
    store().addLiveSubscription('https://b.example.com/tv.m3u');
    expect(store().liveSelectedUrls).toHaveLength(2);

    store().setLiveSelectedUrls([]);
    expect(store().liveSelectedUrls).toEqual([]);

    store().setLiveSelectedUrls(['https://a.example.com/tv.m3u']);
    expect(store().liveSelectedUrls).toEqual(['https://a.example.com/tv.m3u']);
  });
});
