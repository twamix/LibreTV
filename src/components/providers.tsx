'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { useAppStore, hydrateLiveProbeResults, autoSelectFastest } from '@/lib/store';
import { syncEnvSubscriptions } from '@/lib/subscription-sync';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // 尚未自动勾选过的预置点播源 key（供登录后测速自动勾选最快 N 个）。
  // 旧版本（v2.13.0）曾在登录前把 envKeysSeen 标记为已处理且测速从未成功：
  // 从未跑出结果（autoSelectRun=false）且零勾选时，忽略残留 seen 标记、给全部源一次机会；
  // 其余情况只补未看过的源，尊重用户手动取消勾选。
  const pendingEnvSourceKeys = () => {
    const s = useAppStore.getState();
    const unselected = s.envSources.filter((src) => !s.selectedKeys.includes(src.key));
    if (!s.autoSelectRun && s.selectedKeys.length === 0) return unselected.map((src) => src.key);
    return unselected.filter((src) => !s.envKeysSeen.includes(src.key)).map((src) => src.key);
  };

  // 登录成功（libretv:authed）后补跑：启动时若尚未登录，探活会整体 401，
  // autoSelectFastest 会中止且不标记已处理，这里在会话就绪后重新触发。
  useEffect(() => {
    const run = () => {
      const keys = pendingEnvSourceKeys();
      if (keys.length > 0) void autoSelectFastest(keys);
    };
    window.addEventListener('libretv:authed', run);
    return () => window.removeEventListener('libretv:authed', run);
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
        // 预置订阅（DEFAULT_SUBSCRIPTIONS）：首次自动导入，超 24h 静默刷新，失败下次重试
        if (d && Array.isArray(d.defaultSubscriptions) && d.defaultSubscriptions.length > 0) {
          void syncEnvSubscriptions(d.defaultSubscriptions);
        }
        // 预置点播源测速自动勾选：会话已有效则立即执行；
        // 否则等登录成功事件（libretv:authed）由上面的监听补跑
        if (d && d.verified) {
          const keys = pendingEnvSourceKeys();
          if (keys.length > 0) void autoSelectFastest(keys);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
