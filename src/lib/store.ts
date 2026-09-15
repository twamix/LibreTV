'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SourceConfig, LiveSourceConfig, SourceSearchOutcome } from './types';
import { clearLiveProbeResultsDb, loadLiveProbeResults, saveLiveProbeResults } from './db';
import { api, ApiError } from './client-api';

/**
 * 全局设置（zustand + localStorage 持久化）。
 * 旧版把 10+ 个零散 localStorage key 当作跨页面状态总线，这里统一为单一 store。
 */

export interface AppSettings {
  customAPIs: SourceConfig[];
  selectedKeys: string[];
  yellowFilter: boolean;
  adFilter: boolean;
  doubanEnabled: boolean;
  /** 首页推荐数据源：豆瓣热门 / Bangumi 每日放送（免 key）/ 影视热榜（60s API），默认豆瓣 */
  recommendSource: 'douban' | 'bangumi' | 'hot-list';
  autoplayNext: boolean;
  imageProxyMode: 'direct' | 'proxy' | 'custom';
  customImageProxy: string;
}

/**
 * 数据源订阅：远程源列表（LibreTV-SourceList JSON），可一键同步更新。
 * 一份订阅同时下发点播源与直播源；老订阅只有点播源。
 */
export interface SourceSubscription {
  url: string;
  /** 订阅列表自带名称 */
  name?: string;
  /** 上次同步成功时间 */
  lastSync?: number;
  /** 订阅整体开关：false = 停用（其下源不参与搜索，数据与勾选状态保留）；undefined/true = 启用 */
  enabled?: boolean;
}

/** 直播源：远程 M3U 播放列表；可来自用户手动添加，也可来自统一订阅 */
export interface LiveSubscription {
  url: string;
  name?: string;
  /** 该订阅关联的 XMLTV 节目单地址 */
  epg?: string;
  /** 上次同步成功时间 */
  lastSync?: number;
  /**
   * 该直播源来自哪个订阅 URL；手动添加时为空。
   * 删除订阅时按此归属精确清理，避免误删用户手动添加的源。
   */
  fromSubscription?: string;
}

/** 删除点播源后的撤销快照 */
export interface RemovedSourceSnapshot {
  entry: SourceConfig;
  selected: boolean;
}

/** 删除直播源后的撤销快照 */
export interface RemovedLiveSnapshot {
  entry: LiveSubscription;
  selected: boolean;
}

/** 直播最近观看条目（上限 20 条，按 url 去重） */
export interface LiveRecentEntry {
  url: string;
  name: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  /** 来源订阅地址（用于回查 EPG） */
  epg?: string;
  /** 所属直播源地址（M3U 订阅 URL），删除订阅时按此清理；旧数据缺失则自然淘汰 */
  sourceUrl?: string;
  timestamp: number;
}

/** 测活结果有效期：6 小时内直接复用，过期后重新探测 */
export const LIVE_PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/** 直播测活结果缓存条目（按流 URL 唯一标识） */
export interface LiveProbeEntry {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  /** 流编码（master playlist 的 CODECS 属性），用于提示 H.265 等不可解码情况 */
  codec?: string;
  /** 因超时失败（源可能只是慢），前端以琥珀色区分展示 */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps）：低于阈值的源前端标记为「源限速」琥珀色 */
  kbps?: number;
  /** 测活时间戳（epoch ms），配合 TTL 判断有效性 */
  timestamp: number;
}

/** 订阅导入的源 key 前缀：sub_<hash8(url)>_<i>，同步时按前缀整体替换 */
export function subKeyPrefix(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return `sub_${h.toString(36)}`;
}

/**
 * 判断源 key 是否属于指定订阅。
 * 不能直接 startsWith(prefix)：两个不同订阅的 hash36 可能恰好互为前缀
 * （如 sub_1a 与 sub_1a2b），此时会误伤另一个订阅的源。
 * key 的完整形态是 `${prefix}_${i}`，因此要求前缀后紧跟分隔符。
 */
export function keyBelongsToSubscription(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}_`);
}

/** 点播源自动停用阈值：连续失败/超时达到该次数即临时摘除 */
export const SOURCE_DISABLE_THRESHOLD = 2;
/**
 * 点播源自动停用阶梯：下标 i 对应第 i+1 次停用，超出数组长度则进入长期停用（permanent）。
 * 第 1 次 30 分钟、第 2 次 24 小时、第 3 次起只能手动恢复。
 */
export const SOURCE_DISABLE_LADDER = [30 * 60 * 1000, 24 * 60 * 60 * 1000];

/** 一次「源被自动停用」的事件，供调用方按级别提示 */
export interface SourceDisableEvent {
  /** 源 key */
  key: string;
  /** 第几次被停用（从 1 开始） */
  level: number;
  /** 长期停用：不设到期时间，只能手动恢复 */
  permanent: boolean;
  /** 本次停用时长（毫秒）；长期停用时为 undefined */
  ttlMs?: number;
}

/** 点播源健康度条目（按 sourceKey），随搜索结果滚动更新 */
export interface SourceHealthEntry {
  ok: boolean;
  ms?: number;
  error?: string;
  timedOut?: boolean;
  /** 连续失败/超时次数；成功时归零 */
  failStreak: number;
  /** 命中阈值后的临时停用截止时间（epoch ms）；恢复成功后清除 */
  disabledUntil?: number;
  /** 累计的自动停用等级（决定惩罚时长）；每成功一次降一级 */
  disableCount?: number;
  /** 阶梯用尽后的长期停用：不设到期时间，只能由用户手动恢复 */
  permanent?: boolean;
  timestamp: number;
}

interface AppState extends AppSettings {
  /** 部署者通过 DEFAULT_SOURCES 环境变量预置的源（服务端下发，不持久化） */
  envSources: SourceConfig[];
  /** 已向用户展示过并自动勾选过的预置源 key（持久化：用户取消勾选后不再反复勾上） */
  envKeysSeen: string[];
  autoSelectRun: boolean;
  subscriptions: SourceSubscription[];
  /** —— 直播模块 —— */
  /** 部署者通过 DEFAULT_LIVE_SOURCES 预置的直播源（服务端下发，不持久化） */
  liveEnvSources: LiveSourceConfig[];
  /** 已出现过的预置直播源 key（持久化：用于「首次自动可见」去重） */
  liveEnvKeysSeen: string[];
  /** 用户直播源：手动添加的 M3U + 订阅导入的 M3U（后者带 fromSubscription） */
  liveSubscriptions: LiveSubscription[];
  /** 已启用的直播源（按订阅 URL 唯一标识，首次出现自动勾选） */
  liveSelectedUrls: string[];
  /** 收藏频道（按流 URL 唯一标识） */
  liveFavorites: string[];
  /** 最近观看频道（上限 20） */
  liveRecent: LiveRecentEntry[];
  /** 测活结果缓存（6 小时有效，跨会话持久化） */
  liveProbeResults: Record<string, LiveProbeEntry>;
  /** 点播源健康度（随搜索滚动更新，跨会话持久化） */
  sourceHealth: Record<string, SourceHealthEntry>;
  /** 已出现过的 env 预置订阅 URL（持久化：用户删除后不再被自动加回） */
  envSubsSeen: string[];
  /**
   * 成人内容源是否已解锁（会话级，仅内存态）。
   * 真实状态以服务端 ltv_adult cookie 为准，页面加载时经 /api/status 核对后写入。
   */
  adultUnlocked: boolean;
  /** 部署者是否配置了 ADULT_PASSWORD（决定设置页是否展示成人解锁密码框） */
  adultConfigured: boolean;
  addCustomApi: (api: Omit<SourceConfig, 'key'> & { key?: string }) => void;
  updateCustomApi: (key: string, patch: Partial<SourceConfig>) => void;
  /** 删除点播源；返回被删快照供撤销，key 不存在时返回 null */
  removeCustomApi: (key: string) => RemovedSourceSnapshot | null;
  /** 撤销删除；原 key 已被占用（如订阅重新同步占用）时放弃并返回 false */
  restoreCustomApi: (snapshot: RemovedSourceSnapshot) => boolean;
  toggleSourceSelected: (key: string) => void;
  setSelectedKeys: (keys: string[]) => void;
  setEnvSources: (list: SourceConfig[]) => string[];
  markEnvSeen: (keys: string[]) => void;
  markAutoSelectRun: () => void;
  addSubscription: (url: string, name?: string) => void;
  removeSubscription: (url: string) => void;
  /** 订阅整体开关：false = 停用（其下源不参与搜索），undefined/true = 启用；仅改开关，不触碰已导入的源与勾选 */
  setSubscriptionEnabled: (url: string, enabled: boolean) => void;
  markSubscriptionSynced: (url: string, name?: string) => void;
  /** 用订阅内容整体替换该订阅名下的点播源，返回导入数量与新导入的源 key（后者供测速自动勾选） */
  applySubscriptionSources: (subUrl: string, list: Omit<SourceConfig, 'key'>[]) => { count: number; freshKeys: string[] };
  /** 用订阅内容整体替换该订阅名下的直播源，返回新增数量 */
  applySubscriptionLive: (subUrl: string, list: Omit<LiveSourceConfig, 'key'>[]) => number;
  setLiveEnvSources: (list: LiveSourceConfig[]) => void;
  addLiveSubscription: (url: string, name?: string, epg?: string) => void;
  /** 删除直播源；返回被删快照供撤销，不存在时返回 null */
  removeLiveSubscription: (url: string) => RemovedLiveSnapshot | null;
  /** 撤销删除直播源（恢复条目与其启用状态） */
  restoreLiveSubscription: (snapshot: RemovedLiveSnapshot) => void;
  /** 更新直播源的名称/EPG（地址不可改：换地址等于换源，会影响启用状态与最近观看关联） */
  updateLiveSubscription: (url: string, patch: { name?: string; epg?: string }) => void;
  /** 整体替换已启用的直播源 URL 列表（供批量全选/清空） */
  setLiveSelectedUrls: (urls: string[]) => void;
  markLiveSynced: (url: string, name?: string, epg?: string) => void;
  toggleLiveSelected: (url: string) => void;
  toggleLiveFavorite: (channelUrl: string) => void;
  addLiveRecent: (entry: Omit<LiveRecentEntry, 'timestamp'>) => void;
  /** 删除单条最近观看（按流 URL） */
  removeLiveRecent: (channelUrl: string) => void;
  /** 清空最近观看 */
  clearLiveRecent: () => void;
  /** 合并写入测活结果，并顺带清理过期条目 */
  setLiveProbeResults: (entries: Record<string, LiveProbeEntry>) => void;
  clearLiveProbeResults: () => void;
  /**
   * 记录一次搜索的逐源健康度；连续失败/超时达到阈值即按阶梯标记停用
   * （第 1 次 30 分钟、第 2 次 24 小时、第 3 次起长期停用，仅手动恢复）。
   * 不直接改 selectedKeys（用户勾选意图保留，且避免变更引用触发搜索重发），
   * 参与搜索与否由调用方经 isSourceDisabled 过滤；临时停用到期自动恢复。
   * 返回本次新被自动停用的事件列表（供调用方按级别 toast 提示）。
   */
  recordSourceHealth: (outcomes: SourceSearchOutcome[]) => SourceDisableEvent[];
  /** 清除单个源的健康度记录（手动恢复入口） */
  clearSourceHealth: (key: string) => void;
  markEnvSubsSeen: (urls: string[]) => void;
  setAdultUnlocked: (v: boolean) => void;
  setAdultConfigured: (v: boolean) => void;
  updateSettings: (patch: Partial<Omit<AppSettings, 'customAPIs' | 'selectedKeys'>>) => void;
}

/** 全部可用直播源（预置 + 用户订阅）合并视图 */
export function allLiveSources(state: Pick<AppState, 'liveEnvSources' | 'liveSubscriptions'>): LiveSourceConfig[] {
  return [...state.liveEnvSources, ...state.liveSubscriptions.map((s) => ({ key: `sub_${s.url}`, name: s.name || s.url, url: s.url, epg: s.epg }))];
}

function nextCustomKey(apiList: SourceConfig[]): string {
  let i = 0;
  const used = new Set(apiList.map((a) => a.key));
  while (used.has(`custom_${i}`)) i++;
  return `custom_${i}`;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      customAPIs: [],
      envSources: [],
      envKeysSeen: [],
      autoSelectRun: false,
      subscriptions: [],
      liveEnvSources: [],
      liveEnvKeysSeen: [],
      liveSubscriptions: [],
      liveSelectedUrls: [],
      liveFavorites: [],
      liveRecent: [],
      liveProbeResults: {},
      sourceHealth: {},
      envSubsSeen: [],
      selectedKeys: [],
      yellowFilter: true,
      adFilter: true,
      doubanEnabled: true,
      recommendSource: 'douban',
      autoplayNext: true,
      imageProxyMode: 'proxy',
      customImageProxy: '',
      adultUnlocked: false,
      adultConfigured: false,

      addCustomApi: (api) => {
        const list = get().customAPIs;
        const entry: SourceConfig = { ...api, key: api.key || nextCustomKey(list) };
        // 成人内容过滤开启或未解锁成人源时，成人源默认不勾选（解锁/关闭过滤后可手动勾选）
        const selectable = !(entry.isAdult && (get().yellowFilter || !get().adultUnlocked));
        set({
          customAPIs: [...list, entry],
          selectedKeys: selectable ? [...get().selectedKeys, entry.key] : get().selectedKeys,
        });
      },

      updateCustomApi: (key, patch) => {
        // 源被标记为成人内容且过滤开启或未解锁时，同步取消勾选
        const drop = patch.isAdult === true && (get().yellowFilter || !get().adultUnlocked);
        set({
          customAPIs: get().customAPIs.map((a) => (a.key === key ? { ...a, ...patch } : a)),
          selectedKeys: drop ? get().selectedKeys.filter((k) => k !== key) : get().selectedKeys,
        });
      },

      removeCustomApi: (key) => {
        const entry = get().customAPIs.find((a) => a.key === key);
        if (!entry) return null;
        const selected = get().selectedKeys.includes(key);
        set({
          customAPIs: get().customAPIs.filter((a) => a.key !== key),
          selectedKeys: get().selectedKeys.filter((k) => k !== key),
        });
        return { entry, selected };
      },

      restoreCustomApi: ({ entry, selected }) => {
        // key 已被重新占用（如订阅重新同步生成了同 key 的源）时放弃撤销，避免出现重复条目
        if (get().customAPIs.some((a) => a.key === entry.key)) return false;
        set({
          customAPIs: [...get().customAPIs, entry],
          selectedKeys: selected ? [...get().selectedKeys, entry.key] : get().selectedKeys,
        });
        return true;
      },

      toggleSourceSelected: (key) => {
        const cur = get().selectedKeys;
        if (cur.includes(key)) {
          set({ selectedKeys: cur.filter((k) => k !== key) });
          return;
        }
        // 成人内容过滤开启或未解锁时不允许勾选成人源
        const src = [...get().customAPIs, ...get().envSources].find((a) => a.key === key);
        if (src?.isAdult && (get().yellowFilter || !get().adultUnlocked)) return;
        set({ selectedKeys: [...cur, key] });
      },

      setSelectedKeys: (keys) => set({ selectedKeys: keys }),

      setEnvSources: (list) => {
        // 预置源首次出现时不做全量勾选：由调用方经 autoSelectFastest 按实测耗时勾选最低的 N 个。
        // 不在此处写 envKeysSeen——登录前探活会 401，须等登录后真正跑完再标记，否则永不重试。
        const seen = new Set(get().envKeysSeen);
        const freshKeys = list.map((s) => s.key).filter((k) => !seen.has(k));
        set({ envSources: list });
        return freshKeys;
      },

      markEnvSeen: (keys) => {
        const envKeys = keys.filter((k) => k.startsWith('env_'));
        if (envKeys.length === 0) return;
        const seen = new Set(get().envKeysSeen);
        const added = envKeys.filter((k) => !seen.has(k));
        if (added.length === 0) return;
        set({ envKeysSeen: [...get().envKeysSeen, ...added] });
      },

      markAutoSelectRun: () => set({ autoSelectRun: true }),

      addSubscription: (url, name) => {
        if (get().subscriptions.some((s) => s.url === url)) return;
        set({ subscriptions: [...get().subscriptions, { url, name }] });
      },

      setSubscriptionEnabled: (url, enabled) => {
        set({
          subscriptions: get().subscriptions.map((s) => (s.url === url ? { ...s, enabled } : s)),
        });
      },

      removeSubscription: (url) => {
        const prefix = subKeyPrefix(url);
        // 该订阅名下的直播源（M3U 地址集合），用于清理启用状态与最近观看
        const ownedLive = new Set(
          get().liveSubscriptions.filter((s) => s.fromSubscription === url).map((s) => s.url)
        );
        set({
          subscriptions: get().subscriptions.filter((s) => s.url !== url),
          customAPIs: get().customAPIs.filter((a) => !a.key.startsWith(prefix)),
          selectedKeys: get().selectedKeys.filter((k) => !k.startsWith(prefix)),
          liveSubscriptions: get().liveSubscriptions.filter((s) => s.fromSubscription !== url),
          liveSelectedUrls: get().liveSelectedUrls.filter((u) => !ownedLive.has(u)),
          // 收藏的频道是用户主动留下的，删除订阅时保留；其余残留状态一并清理
          liveRecent: get().liveRecent.filter((r) => !r.sourceUrl || !ownedLive.has(r.sourceUrl)),
        });
      },

      markSubscriptionSynced: (url, name) => {
        set({
          subscriptions: get().subscriptions.map((s) =>
            s.url === url ? { ...s, lastSync: Date.now(), name: name ?? s.name } : s
          ),
        });
      },

      applySubscriptionSources: (subUrl, list) => {
        const prefix = subKeyPrefix(subUrl);
        // 与订阅源 URL 相同的手动添加源视为重复，避免同步后出现双份
        const subUrls = new Set(list.map((s) => s.url.replace(/\/+$/, '')));
        const keptCustom = get().customAPIs.filter(
          (a) => !a.key.startsWith(prefix) && !subUrls.has(a.url.replace(/\/+$/, ''))
        );
        const prevOwned = get().customAPIs.filter((a) => a.key.startsWith(prefix));
        // key 按序号重生成，勾选状态需按 url 对齐保留；用户停用的源不会被同步反复勾回
        const prevSelectedUrls = new Set(
          prevOwned
            .filter((a) => get().selectedKeys.includes(a.key))
            .map((a) => a.url.replace(/\/+$/, ''))
        );
        const prevUrlSet = new Set(prevOwned.map((a) => a.url.replace(/\/+$/, '')));
        const incoming: SourceConfig[] = list.map((s, i) => ({
          ...s,
          key: `${prefix}_${i}`,
        }));
        // 只保留用户此前勾选的源；新导入的源不默认全选，交给 autoSelectFastest 按实测耗时选前 N 个
        const toSelect = incoming
          .filter((s) => {
            const u = s.url.replace(/\/+$/, '');
            return prevUrlSet.has(u) && prevSelectedUrls.has(u);
          })
          .map((s) => s.key);
        const freshKeys = incoming
          .filter((s) => !prevUrlSet.has(s.url.replace(/\/+$/, '')))
          .map((s) => s.key);
        set({
          customAPIs: [...keptCustom, ...incoming],
          selectedKeys: [...get().selectedKeys.filter((k) => !k.startsWith(prefix)), ...toSelect],
        });
        return { count: incoming.length, freshKeys };
      },

      applySubscriptionLive: (subUrl, list) => {
        const existing = get().liveSubscriptions;
        const owned = existing.filter((s) => s.fromSubscription === subUrl);
        const ownedUrls = new Set(owned.map((s) => s.url));
        // 手动添加或其他订阅已占用的 M3U 不再重复导入（手动添加优先）
        const kept = existing.filter((s) => s.fromSubscription !== subUrl);
        const keptUrls = new Set(kept.map((s) => s.url));
        const incoming: LiveSubscription[] = list
          .filter((s) => !keptUrls.has(s.url))
          .map((s) => ({ url: s.url, name: s.name, epg: s.epg, fromSubscription: subUrl }));
        // 本次订阅里已消失的旧源：其最近观看记录一并清掉，收藏保留
        const stillPresent = new Set(list.map((s) => s.url));
        const droppedUrls = new Set([...ownedUrls].filter((u) => !stillPresent.has(u)));
        // 仅新导入的源自动启用；已有源维持用户的勾选状态（停用不会被同步反复勾回），
        // 因此只从勾选中移除本次已消失的源
        const freshUrls = incoming.filter((s) => !ownedUrls.has(s.url)).map((s) => s.url);

        set({
          liveSubscriptions: [...kept, ...incoming],
          liveSelectedUrls: [
            ...new Set([
              ...get().liveSelectedUrls.filter((u) => !droppedUrls.has(u)),
              ...freshUrls,
            ]),
          ],
          liveRecent: get().liveRecent.filter((r) => !r.sourceUrl || !droppedUrls.has(r.sourceUrl)),
        });
        return incoming.length;
      },

      setLiveEnvSources: (list) => {
        // 预置直播源首次出现时自动启用；用户此后停用不会被反复勾回
        const seen = new Set(get().liveEnvKeysSeen);
        const freshUrls = list.filter((s) => !seen.has(s.key)).map((s) => s.url);
        set({
          liveEnvSources: list,
          liveEnvKeysSeen: [...get().liveEnvKeysSeen, ...list.map((s) => s.key)],
          liveSelectedUrls: [...get().liveSelectedUrls, ...freshUrls],
        });
      },

      addLiveSubscription: (url, name, epg) => {
        const trimmed = url.trim();
        if (!trimmed || get().liveSubscriptions.some((s) => s.url === trimmed)) return;
        set({
          liveSubscriptions: [...get().liveSubscriptions, { url: trimmed, name, epg }],
          // 新添加的订阅默认启用
          liveSelectedUrls: [...new Set([...get().liveSelectedUrls, trimmed])],
        });
      },

      removeLiveSubscription: (url) => {
        const entry = get().liveSubscriptions.find((s) => s.url === url);
        if (!entry) return null;
        const selected = get().liveSelectedUrls.includes(url);
        set({
          liveSubscriptions: get().liveSubscriptions.filter((s) => s.url !== url),
          liveSelectedUrls: get().liveSelectedUrls.filter((u) => u !== url),
        });
        return { entry, selected };
      },

      restoreLiveSubscription: ({ entry, selected }) => {
        if (get().liveSubscriptions.some((s) => s.url === entry.url)) return;
        set({
          liveSubscriptions: [...get().liveSubscriptions, entry],
          liveSelectedUrls: selected
            ? [...new Set([...get().liveSelectedUrls, entry.url])]
            : get().liveSelectedUrls,
        });
      },

      updateLiveSubscription: (url, patch) => {
        set({
          liveSubscriptions: get().liveSubscriptions.map((s) =>
            s.url === url ? { ...s, ...patch } : s
          ),
        });
      },

      setLiveSelectedUrls: (urls) => set({ liveSelectedUrls: urls }),

      toggleLiveSelected: (url) => {
        const cur = get().liveSelectedUrls;
        set({
          liveSelectedUrls: cur.includes(url)
            ? cur.filter((u) => u !== url)
            : [...cur, url],
        });
      },

      markLiveSynced: (url, name, epg) => {
        set({
          liveSubscriptions: get().liveSubscriptions.map((s) =>
            s.url === url
              ? { ...s, lastSync: Date.now(), name: name ?? s.name, epg: epg ?? s.epg }
              : s
          ),
        });
      },

      toggleLiveFavorite: (channelUrl) => {
        const cur = get().liveFavorites;
        set({
          liveFavorites: cur.includes(channelUrl)
            ? cur.filter((u) => u !== channelUrl)
            : [...cur, channelUrl],
        });
      },

      addLiveRecent: (entry) => {
        const rest = get().liveRecent.filter((r) => r.url !== entry.url);
        set({ liveRecent: [{ ...entry, timestamp: Date.now() }, ...rest].slice(0, 20) });
      },

      removeLiveRecent: (channelUrl) => {
        set({ liveRecent: get().liveRecent.filter((r) => r.url !== channelUrl) });
      },

      clearLiveRecent: () => set({ liveRecent: [] }),

      setLiveProbeResults: (entries) => {
        const now = Date.now();
        // 合并新结果并顺带清理过期条目；内存态是唯一读取源，IndexedDB 仅作持久化
        const next: Record<string, LiveProbeEntry> = {};
        for (const [url, e] of Object.entries(get().liveProbeResults)) {
          if (now - e.timestamp < LIVE_PROBE_TTL_MS) next[url] = e;
        }
        for (const [url, e] of Object.entries(entries)) next[url] = e;
        set({ liveProbeResults: next });
        // 只落库本批新增（按键覆盖），过期行由 hydrateLiveProbeResults 启动时清理；
        // IndexedDB 不可用（隐私模式等）时静默放弃持久化，不影响本会话使用
        saveLiveProbeResults(entries).catch(() => {});
      },

      clearLiveProbeResults: () => {
        set({ liveProbeResults: {} });
        clearLiveProbeResultsDb().catch(() => {});
      },

      recordSourceHealth: (outcomes) => {
        if (outcomes.length === 0) return [];
        const now = Date.now();
        const health: Record<string, SourceHealthEntry> = {};
        // 顺带清理陈旧条目：超过 7 天没再参与过搜索的源，其惩罚等级一并作废
        for (const [key, e] of Object.entries(get().sourceHealth)) {
          if (now - e.timestamp < 7 * 24 * 60 * 60 * 1000) health[key] = e;
        }
        const events: SourceDisableEvent[] = [];
        for (const o of outcomes) {
          const prev = health[o.sourceKey];
          // 停用期已过 → 上一次的连续失败已被「停用 + 恢复」打断，重新从 1 开始累计
          const interrupted = !!prev?.disabledUntil && prev.disabledUntil <= now;
          const failStreak = o.ok ? 0 : interrupted ? 1 : (prev?.failStreak ?? 0) + 1;
          // 成功一次即降一级（而非清零）：偶发抽风的源会自己降回来，
          // 从未成功过的死源才会一路升到长期停用
          const disableCount = o.ok
            ? Math.max(0, (prev?.disableCount ?? 0) - 1)
            : (prev?.disableCount ?? 0);
          // entry 覆盖旧记录：成功时停用标记随之消失（立即恢复）
          const entry: SourceHealthEntry = {
            ok: o.ok,
            ms: o.ms,
            error: o.error,
            timedOut: o.timedOut,
            failStreak,
            disableCount,
            timestamp: now,
          };
          if (!o.ok && failStreak >= SOURCE_DISABLE_THRESHOLD) {
            const alreadyDisabled = prev?.permanent === true || (prev?.disabledUntil ?? 0) > now;
            if (alreadyDisabled) {
              // 已在停用期内（正常不会参与搜索，此处仅作防御）：保持原等级与截止时间
              entry.disableCount = prev?.disableCount ?? disableCount;
              entry.disabledUntil = prev?.disabledUntil;
              entry.permanent = prev?.permanent;
            } else {
              // 第 N 次被停用 → 取阶梯第 N 级；阶梯用尽则进入长期停用
              const nextLevel = disableCount + 1;
              const ttlMs: number | undefined = SOURCE_DISABLE_LADDER[nextLevel - 1];
              entry.disableCount = nextLevel;
              if (ttlMs === undefined) {
                entry.permanent = true;
              } else {
                entry.disabledUntil = now + ttlMs;
              }
              events.push({ key: o.sourceKey, level: nextLevel, permanent: ttlMs === undefined, ttlMs });
            }
          }
          health[o.sourceKey] = entry;
        }
        set({ sourceHealth: health });
        return events;
      },

      clearSourceHealth: (key) => {
        const next = { ...get().sourceHealth };
        delete next[key];
        set({ sourceHealth: next });
      },

      markEnvSubsSeen: (urls) => {
        const seen = new Set(get().envSubsSeen);
        for (const u of urls) seen.add(u);
        set({ envSubsSeen: [...seen] });
      },

      setAdultUnlocked: (v) => set({ adultUnlocked: v }),

      setAdultConfigured: (v) => set({ adultConfigured: v }),

      updateSettings: (patch) => {
        // 打开成人内容过滤时，同步取消勾选所有成人源，避免两者并存
        if (patch.yellowFilter === true) {
          const adultKeys = new Set(
            [...get().customAPIs, ...get().envSources]
              .filter((s) => s.isAdult)
              .map((s) => s.key)
          );
          set({
            ...patch,
            selectedKeys: get().selectedKeys.filter((k) => !adultKeys.has(k)),
          });
          return;
        }
        set(patch);
      },
    }),
    {
      name: 'libretv-settings',
      // v1：直播源新增 fromSubscription 归属字段、最近观看新增 sourceUrl。
      // 此前未声明 version，存量数据会被视为 v0 并走 migrate 补齐（缺失字段按「手动添加」处理）。
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<AppState>;
        if (version < 1) {
          return {
            ...state,
            liveSubscriptions: Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions : [],
            liveRecent: Array.isArray(state.liveRecent) ? state.liveRecent : [],
          } as AppState;
        }
        return state as AppState;
      },
      // envSources 由服务端每次下发，不进 localStorage；
      // liveProbeResults 体积大且写入频繁，持久化走 IndexedDB（db.ts liveProbe 表），不进 localStorage
      partialize: (s) => ({
        customAPIs: s.customAPIs,
        selectedKeys: s.selectedKeys,
        envKeysSeen: s.envKeysSeen,
        autoSelectRun: s.autoSelectRun,
        subscriptions: s.subscriptions,
        liveEnvKeysSeen: s.liveEnvKeysSeen,
        liveSubscriptions: s.liveSubscriptions,
        liveSelectedUrls: s.liveSelectedUrls,
        liveFavorites: s.liveFavorites,
        liveRecent: s.liveRecent,
        sourceHealth: s.sourceHealth,
        envSubsSeen: s.envSubsSeen,
        yellowFilter: s.yellowFilter,
        adFilter: s.adFilter,
        doubanEnabled: s.doubanEnabled,
        recommendSource: s.recommendSource,
        autoplayNext: s.autoplayNext,
        imageProxyMode: s.imageProxyMode,
        customImageProxy: s.customImageProxy,
      }),
      // 同步 storage 会在模块加载时立即 rehydrate（早于 React hydration），
      // 一旦首屏渲染依赖持久化状态就会与 SSR 输出不一致。
      // 改为由 Providers 在挂载后手动 rehydrate。
      skipHydration: true,
    }
  )
);

/**
 * 从 IndexedDB 恢复测活缓存（Providers 挂载后、persist.rehydrate 之后调用）。
 * - 必须晚于 rehydrate：旧版本把 liveProbeResults 存在 localStorage 的设置快照里，
 *   rehydrate 会先把它读进内存，这里合并后一次性搬迁进 IndexedDB，快照随下次持久化自然瘦身；
 * - 顺带清理表中过期行；IndexedDB 不可用时静默跳过（本会话仍可测活，只是不缓存）。
 */
export async function hydrateLiveProbeResults(): Promise<void> {
  try {
    const now = Date.now();
    const stored = await loadLiveProbeResults();
    const merged: Record<string, LiveProbeEntry> = { ...useAppStore.getState().liveProbeResults, ...stored };
    const fresh: Record<string, LiveProbeEntry> = {};
    for (const [url, e] of Object.entries(merged)) {
      if (now - e.timestamp < LIVE_PROBE_TTL_MS) fresh[url] = e;
    }
    // 全量比对后整体覆写，同时覆盖「旧快照搬迁」与「表内过期行清理」两种情况
    await clearLiveProbeResultsDb();
    await saveLiveProbeResults(fresh);
    useAppStore.setState({ liveProbeResults: fresh });
  } catch {
    // 隐私模式 / IndexedDB 被禁用：放弃持久化，不影响内存态
  }
}

/** 获取指定 key 的源配置；找不到时支持从 URL 参数兜底构造 */
export function resolveSource(
  store: Pick<AppState, 'customAPIs' | 'envSources'>,
  key: string,
  fallback?: { url?: string; detail?: string; name?: string }
): SourceConfig | undefined {
  const found = store.customAPIs.find((a) => a.key === key) ?? store.envSources.find((a) => a.key === key);
  if (found) return found;
  if (fallback?.url) {
    return {
      key,
      name: fallback.name || '自定义源',
      url: fallback.url,
      detail: fallback.detail,
    };
  }
  return undefined;
}

/**
 * 源当前是否处于自动停用期（连续超时/失败触发）。
 * 临时停用到期后此判断自然翻转为 false，即「到期自动恢复参与搜索」的懒实现；
 * 长期停用（阶梯用尽）没有到期时间，只有手动恢复（clearSourceHealth）才能解除。
 */
export function isSourceDisabled(
  state: Pick<AppState, 'sourceHealth'>,
  key: string,
  now = Date.now()
): boolean {
  const e = state.sourceHealth[key];
  if (!e) return false;
  return e.permanent === true || (!!e.disabledUntil && e.disabledUntil > now);
}

/**
 * 源是否来自一个被用户整体停用的订阅。
 * 与 isSourceDisabled 分开判断：一个是用户主动关的、一个是系统按连续失败关的，
 * 提示文案与恢复方式都不同，混在一起用户就看不懂源为什么不生效了。
 */
export function isInDisabledSubscription(
  state: Pick<AppState, 'subscriptions'>,
  key: string
): boolean {
  return state.subscriptions.some(
    (s) => s.enabled === false && keyBelongsToSubscription(key, subKeyPrefix(s.url))
  );
}

/** 测速后自动勾选的耗时最低来源数量 */
export const AUTO_SELECT_FASTEST_TOP = 6;
/** 测速探活并发上限，避免一次性压垮上游 */
const AUTO_SELECT_CONCURRENCY = 5;

/**
 * 对候选点播源做探活测速，自动勾选耗时最低的 N 个（默认 6）。
 * 仅限非成人源：成人源一律排除在候选外（解锁与否、是否开启过滤都不参与测速，
 * 成人源的勾选由解锁/锁定动作显式控制）；已勾选、测速失败或超时的源跳过，
 * 因此源数量不足 N 时勾选到几个算几个。用户的既有勾选保持不变。
 *
 * 会话未就绪（未登录 / 服务器未配置密码）时探活会整体 401/503：此时中止且
 * **不标记已处理**，由调用方在登录成功后（libretv:authed）补跑；
 * 登录态下跑完一轮（无论勾选几个）即调用 markEnvSeen 标记，避免每次打开都重测。
 */
export async function autoSelectFastest(candidateKeys: string[], topN = AUTO_SELECT_FASTEST_TOP): Promise<void> {
  if (candidateKeys.length === 0) return;
  const state = useAppStore.getState();
  const all = [...state.customAPIs, ...state.envSources];
  const candidates = candidateKeys
    .map((key) => all.find((s) => s.key === key))
    .filter(
      (s): s is SourceConfig =>
        !!s &&
        !s.isAdult && // 自动探活测速仅限非成人源：成人源永不因此被勾选
        !state.selectedKeys.includes(s.key)
    );
  // 候选为空（全部已勾选 / 成人源被过滤或未解锁）：无需测速，直接标记为已处理
  if (candidates.length === 0) {
    useAppStore.getState().markEnvSeen(candidateKeys);
    return;
  }

  const results: { key: string; ms: number }[] = [];
  const queue = [...candidates];
  let authReady = true;
  const workers = Array.from({ length: AUTO_SELECT_CONCURRENCY }, async () => {
    for (;;) {
      const src = queue.shift();
      if (!src || !authReady) break;
      try {
        const r = await api.testSource(src.url);
        if (r.ok && r.ms > 0) results.push({ key: src.key, ms: r.ms });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 503)) {
          // 会话未就绪：整体中止，等登录后补跑（不标记已处理）
          authReady = false;
          break;
        }
        // 单个源测速失败（源不可达等）不影响其余候选
      }
    }
  });
  await Promise.all(workers);
  if (!authReady) return;
  // 记录“测速自动勾选已在本会话跑出结果”，供 Providers 区分旧版本遗留的 seen 标记
  useAppStore.getState().markAutoSelectRun();

  if (results.length > 0) {
    results.sort((a, b) => a.ms - b.ms);
    const keys = results.slice(0, topN).map((r) => r.key);
    const cur = useAppStore.getState().selectedKeys;
    useAppStore.getState().setSelectedKeys([...new Set([...cur, ...keys])]);
  }
  // 本轮已做出决定（勾选 top N / 全部测速失败）——标记已处理，下次不再重测
  useAppStore.getState().markEnvSeen(candidateKeys);
}

/** 全部成人源 key（env + custom + 订阅导入均在 customAPIs/envSources 内） */
function allAdultKeys(state: Pick<AppState, 'customAPIs' | 'envSources'>): string[] {
  return [...state.customAPIs, ...state.envSources].filter((s) => s.isAdult).map((s) => s.key);
}

/**
 * 成人内容解锁成功后调用：全选所有成人源，取消所有非成人源勾选（切到成人浏览模式）。
 * 只应在用户显式的解锁动作里调用——启动时 /api/status 同步 setAdultUnlocked 不能触发，
 * 否则每次刷新页面都会清掉用户已勾选的非成人源。
 */
export function selectAllAdultSources(): void {
  const state = useAppStore.getState();
  state.setSelectedKeys(allAdultKeys(state));
}

/**
 * 成人内容锁定成功后调用：清空全部勾选，对全部非成人源重新探活测速，
 * 勾选耗时最低的 N 个（默认 6）。同样只应由用户显式的锁定动作触发。
 */
export async function reselectFastestNonAdult(topN = AUTO_SELECT_FASTEST_TOP): Promise<void> {
  const state = useAppStore.getState();
  const nonAdultKeys = [...state.customAPIs, ...state.envSources]
    .filter((s) => !s.isAdult)
    .map((s) => s.key);
  state.setSelectedKeys([]);
  if (nonAdultKeys.length > 0) await autoSelectFastest(nonAdultKeys, topN);
}
