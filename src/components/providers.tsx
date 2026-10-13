'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { GlobalDownloadManager } from './download-manager';
import { useAppStore, hydrateLiveProbeResults, autoSelectFastest, selectAllNonAdultEnvSources } from '@/lib/store';
import { syncEnvSubscriptions } from '@/lib/subscription-sync';
import { SETTINGS_UNLOCKED_EVENT } from './auth';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // 尚未自动勾选过的预置点播源 key（供解锁设置后测速自动勾选最快 N 个）。
  // 旧版本（v2.13.0）曾在解锁前把 envKeysSeen 标记为已处理且测速从未成功：
  // 从未跑出结果（autoSelectRun=false）且零勾选时，忽略残留 seen 标记、给全部源一次机会；
  // 其余情况只补未看过的源，尊重用户手动取消勾选。
  const pendingEnvSourceKeys = () => {
    const s = useAppStore.getState();
    const unselected = s.envSources.filter((src) => !s.selectedKeys.includes(src.key));
    if (!s.autoSelectRun && s.selectedKeys.length === 0) return unselected.map((src) => src.key);
    return unselected.filter((src) => !s.envKeysSeen.includes(src.key)).map((src) => src.key);
  };

  // 未解锁期间待补跑的预置订阅（拉取订阅属设置类接口，未解锁会 401）
  const pendingEnvSubsRef = useRef<{ url: string; name?: string }[]>([]);

  // 设置解锁成功（libretv:settings-unlocked）后补跑：
  // 解锁前探活/订阅拉取会整体 401，这些流程只在解锁后才可用。
  useEffect(() => {
    const run = () => {
      const subs = pendingEnvSubsRef.current;
      if (subs.length > 0) {
        pendingEnvSubsRef.current = [];
        void syncEnvSubscriptions(subs);
      }
      const keys = pendingEnvSourceKeys();
      if (keys.length > 0) void autoSelectFastest(keys);
    };
    window.addEventListener(SETTINGS_UNLOCKED_EVENT, run);
    return () => window.removeEventListener(SETTINGS_UNLOCKED_EVENT, run);
  }, []);

  // store 配置了 skipHydration：等挂载后再读 localStorage，
  // 保证 hydration 阶段客户端与服务端渲染结果一致。
  useEffect(() => {
    // 先等持久化状态恢复，再拉服务端下发数据：
    // 避免 setEnvSources/setLiveEnvSources 的勾选合并发生在 rehydrate 之前被覆盖
    Promise.resolve(useAppStore.persist.rehydrate())
      .then(() => {
        // 测活缓存从 IndexedDB 恢复（并顺带搬迁旧 localStorage 快照里的存量），
        // 与下方 /api/status 拉取互不依赖，失败静默
        void hydrateLiveProbeResults();
        // 拉取部署者通过 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 预置的源（失败时静默忽略）
        return fetch('/api/status');
      })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.adultConfigured === 'boolean') {
          useAppStore.getState().setAdultConfigured(d.adultConfigured);
        }
        if (d && typeof d.adultUnlocked === 'boolean') {
          useAppStore.getState().setAdultUnlocked(d.adultUnlocked);
        }
        if (d && Array.isArray(d.defaultSources)) {
          useAppStore.getState().setEnvSources(d.defaultSources);
        }
        if (d && Array.isArray(d.defaultLiveSources)) {
          useAppStore.getState().setLiveEnvSources(d.defaultLiveSources);
        }
        // 预置订阅（DEFAULT_SUBSCRIPTIONS）：首次自动导入，超 24h 静默刷新，失败下次重试。
        // 拉取订阅走设置类接口（未解锁 401）：未解锁时挂起，等解锁事件补跑，避免白跑一次 401
        if (d && Array.isArray(d.defaultSubscriptions) && d.defaultSubscriptions.length > 0) {
          if (d.settingsUnlocked) void syncEnvSubscriptions(d.defaultSubscriptions);
          else pendingEnvSubsRef.current = d.defaultSubscriptions;
        }
        // 部署者默认值（DEFAULT_RECOMMEND_SOURCE / DEFAULT_IMAGE_MODE）：
        // 只对「用户从未动过这项设置、且当前值仍是出厂默认」的浏览器生效——
        // 用户主动改过的（touched）与老版本里改过值的都不会被覆盖；
        // 直写 state 不打 touched 标，部署者调整默认值时下个访客仍按同样规则判定（幂等）。
        const s = useAppStore.getState();
        if (
          typeof d.defaultRecommendSource === 'string' &&
          !s.recommendSourceTouched &&
          s.recommendSource === 'douban'
        ) {
          useAppStore.setState({ recommendSource: d.defaultRecommendSource });
        }
        if (typeof d.defaultImageMode === 'string' && !s.imageProxyModeTouched && s.imageProxyMode === 'proxy') {
          useAppStore.setState({ imageProxyMode: d.defaultImageMode });
        }
        // 预置点播源的勾选：
        // - 设置已解锁 → 测速自动勾选最快 N 个（走 /api/source/test，设置类接口）；
        // - 未解锁 → 测速接口不可用，退化为全选非成人预置源，并标记为已处理，
        //   防止用户随后手动取消后又被下次启动自动勾回；新加入的预置源仍可解锁后测速。
        // /api/status 拿不到（d 为空）时不做任何勾选：避免在不知服务端配置的情况下改动用户的勾选。
        if (d) {
          if (d.settingsUnlocked) {
            const keys = pendingEnvSourceKeys();
            if (keys.length > 0) void autoSelectFastest(keys);
          } else {
            selectAllNonAdultEnvSources();
          }
        }
      })
      .catch(() => {});
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            {children}
            {/* 下载事件监听必须常驻（抽屉关闭时播放页也会派发入队事件），故挂在根 Providers 上 */}
            <GlobalDownloadManager />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
