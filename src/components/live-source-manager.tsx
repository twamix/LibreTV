'use client';

import { useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useToast } from './toast';
import { api } from '@/lib/client-api';
import { formatRelativeTime, validateSourceUrl, cn } from '@/lib/utils';
import { FilterTabs, VOD_FILTERS, type VodFilter } from './filter-tabs';

/**
 * 直播源管理（嵌入设置抽屉）：M3U 订阅的添加 / 探活 / 同步 / 移除 / 导出，
 * 以及部署者预置源展示。支持搜索/筛选/全选/编辑/删除撤销。
 */

type TestState =
  | { status: 'loading' }
  | { status: 'done'; ok: boolean; ms?: number; count?: number; error?: string };

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function LiveSourceManager() {
  const store = useAppStore();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [epg, setEpg] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});

  // 搜索/筛选状态
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');

  // 编辑状态（仅手动添加的直播源）
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEpg, setEditEpg] = useState('');

  // 合并所有直播源（预置 + 订阅）
  const allLive = useMemo(() => [
    ...store.liveEnvSources.map((s) => ({
      url: s.url,
      name: s.name,
      epg: s.epg,
      preset: true as const,
      fromSubscription: undefined as string | undefined,
      lastSync: undefined as number | undefined,
    })),
    ...store.liveSubscriptions.map((s) => ({
      url: s.url,
      name: s.name,
      epg: s.epg,
      preset: false,
      fromSubscription: s.fromSubscription,
      lastSync: s.lastSync,
    })),
  ], [store.liveEnvSources, store.liveSubscriptions]);

  // 筛选逻辑
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allLive.filter((s) => {
      if (q && !((s.name || '').toLowerCase().includes(q) || s.url.toLowerCase().includes(q))) return false;
      const selected = store.liveSelectedUrls.includes(s.url);
      if (filter === 'enabled' && !selected) return false;
      if (filter === 'disabled' && selected) return false;
      const isSub = !!s.fromSubscription;
      const isPreset = s.preset;
      if (filter === 'sub' && !isSub) return false;
      if (filter === 'manual' && (isSub || isPreset)) return false;
      return true;
    });
  }, [allLive, query, filter, store.liveSelectedUrls]);

  const enabledCount = allLive.filter((s) => store.liveSelectedUrls.includes(s.url)).length;
  const allVisibleSelected = filtered.length > 0 && filtered.every((s) => store.liveSelectedUrls.includes(s.url));

  const toggleAllVisible = () => {
    if (filtered.length === 0) return;
    const urls = filtered.map((s) => s.url);
    if (allVisibleSelected) {
      store.setLiveSelectedUrls(store.liveSelectedUrls.filter((u) => !urls.includes(u)));
    } else {
      store.setLiveSelectedUrls([...new Set([...store.liveSelectedUrls, ...urls])]);
    }
  };

  const beginEdit = (url: string, currentName: string, currentEpg?: string) => {
    setEditing(url);
    setEditName(currentName || '');
    setEditEpg(currentEpg || '');
  };

  const saveEdit = () => {
    if (!editing) return;
    store.updateLiveSubscription(editing, {
      name: editName.trim() || undefined,
      epg: editEpg.trim() || undefined,
    });
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

  const addAndTest = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    store.addLiveSubscription(url, name.trim() || undefined, epg.trim() || undefined);
    void runTest(url, url);
    setSubUrl('');
    setName('');
    setEpg('');
  };

  const runTest = async (key: string, url: string) => {
    setTests((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    const r = await api.liveTest(url);
    setTests((prev) => ({
      ...prev,
      [key]: r.ok
        ? { status: 'done', ok: true, ms: r.ms, count: r.count }
        : { status: 'done', ok: false, error: r.error },
    }));
  };

  const exportM3u = (url: string) => {
    window.open(api.liveExportUrl(url), '_blank', 'noopener');
  };

  const testBadge = (key: string, url: string) => {
    const t = tests[key];
    return (
      <span className="flex items-center gap-1 shrink-0">
        {t?.status === 'done' && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded',
              t.ok ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-red-500/15 text-red-500'
            )}
            title={t.ok ? `解析 ${t.ms}ms，共 ${t.count ?? 0} 个频道` : t.error}
          >
            {t.ok ? `✓ ${t.count ?? 0} 频道` : `✗ ${t.error?.slice(0, 12) || '失败'}`}
          </span>
        )}
        <button
          className={cn(
            'rounded-md p-1.5 transition-colors disabled:opacity-40',
            t?.status === 'done' && !t.ok ? 'text-red-400' : 'text-muted hover:text-accent hover:bg-hover'
          )}
          disabled={t?.status === 'loading'}
          onClick={() => runTest(key, url)}
          aria-label="测试此直播源"
          title="拉取解析并测速（频道数量与耗时）"
        >
          {t?.status === 'loading' ? '…' : '⚡'}
        </button>
      </span>
    );
  };

  const renderRow = ({
    url,
    label,
    epgUrl,
    preset = false,
    lastSync,
    fromSubscription,
  }: {
    url: string;
    label: string;
    epgUrl?: string;
    preset?: boolean;
    lastSync?: number;
    /** 该直播源来自哪个订阅 URL；有值时由订阅统一管理，不可单独删除 */
    fromSubscription?: string;
  }) => {
    const isEditing = editing === url;
    const isManual = !preset && !fromSubscription;

    return (
      <li key={url} className="bg-card rounded-lg p-3 transition-colors hover:bg-hover/50">
        {isManual && isEditing ? (
          // 就地编辑模式：名称 + EPG + 保存/取消
          <div className="space-y-2">
            <input
              className="input w-full"
              placeholder="名称（可选）"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
            <input
              className="input w-full"
              placeholder="EPG 节目单地址（可选，XMLTV xml/xml.gz）"
              value={editEpg}
              onChange={(e) => setEditEpg(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost !py-1 text-xs" onClick={cancelEdit}>
                取消
              </button>
              <button className="btn-primary !py-1 text-xs" onClick={saveEdit}>
                保存
              </button>
            </div>
          </div>
        ) : (
          // 常规显示模式
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#2563eb] shrink-0"
              checked={store.liveSelectedUrls.includes(url)}
              onChange={() => store.toggleLiveSelected(url)}
              aria-label={store.liveSelectedUrls.includes(url) ? `停用 ${label}` : `启用 ${label}`}
              title={store.liveSelectedUrls.includes(url) ? '已启用，取消勾选可停用' : '已停用，勾选后生效'}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content truncate">
                {label}
                {preset && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                    部署者预置
                  </span>
                )}
                {fromSubscription && (
                  <span
                    className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                    title="来自数据源订阅，重新同步时此源的名称/地址会以订阅内容为准"
                  >
                    订阅
                  </span>
                )}
              </div>
              <div className="text-xs text-faint truncate">
                {url}
                {epgUrl && ' · 已配置节目单'}
                {lastSync && ` · 同步于 ${formatRelativeTime(lastSync)}`}
              </div>
            </div>
            {testBadge(url, url)}
            <button
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-accent"
              onClick={() => exportM3u(url)}
              aria-label="导出 M3U"
              title="导出为标准 M3U 文件"
            >
              ⇩
            </button>
            {isManual ? (
              <>
                <button
                  className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-accent"
                  onClick={() => beginEdit(url, label, epgUrl)}
                  aria-label="编辑"
                >
                  ✎
                </button>
                <button
                  className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-red-400"
                  onClick={() => {
                    const snap = store.removeLiveSubscription(url);
                    if (snap) toast(`已移除「${label}」`, 'info', { action: { label: '撤销', onClick: () => store.restoreLiveSubscription(snap) } });
                  }}
                  aria-label="删除"
                >
                  ✕
                </button>
              </>
            ) : fromSubscription ? (
              <button
                className="rounded-md p-1.5 text-muted/40"
                onClick={() => toast('该直播源来自数据源订阅；请到「订阅与配置 → 数据源订阅」中删除整个订阅', 'info')}
                aria-label="订阅源不可单独删除"
                title="该源来自订阅，单独删除会在下次同步时恢复；如需移除请删除整个订阅"
              >
                ✕
              </button>
            ) : null /* preset: no delete button */}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="mb-6 pt-5">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-sm font-semibold text-content">直播源</h3>
        <span className="text-[10px] text-faint">M3U 订阅 · /live 页面播放</span>
      </div>
      <div className="space-y-2 mb-2.5">
        <input
          className="input w-full"
          placeholder="M3U 订阅地址，如 https://example.com/list.m3u"
          value={subUrl}
          maxLength={500}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndTest();
          }}
        />
        {(subUrl.trim() || name.trim() || epg.trim()) && (
          <>
            <input
              className="input w-full"
              placeholder="名称（可选），如 我的频道列表"
              value={name}
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="input w-full"
              placeholder="EPG 节目单地址（可选，XMLTV xml/xml.gz）"
              value={epg}
              maxLength={500}
              onChange={(e) => setEpg(e.target.value)}
            />
          </>
        )}
        <button className="btn-primary !py-1.5 text-xs w-full" disabled={!subUrl.trim()} onClick={addAndTest}>
          添加直播源
        </button>
      </div>
      {store.liveEnvSources.length === 0 && store.liveSubscriptions.length === 0 ? (
        <p className="text-xs text-faint">
          添加 M3U 地址后即可在「直播」页按分组浏览与播放频道；也可在「订阅与配置 → 数据源订阅」中一次导入点播源与直播源；部署者还可通过 DEFAULT_LIVE_SOURCES 环境变量预置。
        </p>
      ) : (
        <>
          {/* 搜索 / 筛选 / 全选工具条 */}
          <div className="space-y-2 mb-2.5">
            <input
              className="input w-full"
              placeholder="搜索名称或地址"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索直播源"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterTabs options={VOD_FILTERS} value={filter} onChange={setFilter} />
              <span className="ml-auto text-[11px] text-faint">显示 {filtered.length} 个 · 已启用 {enabledCount}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button className="btn-ghost !py-1 !px-2 text-[11px]" onClick={toggleAllVisible} disabled={filtered.length === 0}>
                {allVisibleSelected ? '清空勾选' : '全选'}
              </button>
            </div>
          </div>

          {/* 源列表 */}
          <ul className="space-y-2 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
            {filtered.length === 0 ? (
              <li className="text-xs text-faint py-4">没有符合当前搜索或筛选条件的直播源</li>
            ) : (
              filtered.map((s) =>
                renderRow({
                  url: s.url,
                  label: s.name || hostnameOf(s.url),
                  epgUrl: s.epg,
                  preset: s.preset,
                  lastSync: s.lastSync,
                  fromSubscription: s.fromSubscription,
                })
              )
            )}
          </ul>
        </>
      )}
    </section>
  );
}
