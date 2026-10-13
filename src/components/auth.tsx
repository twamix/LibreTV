'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized } from '@/lib/client-api';
import { useToast } from './toast';

/**
 * 设置解锁上下文：
 * - 站点**浏览**（搜索/详情/推荐/直播/播放）不需要密码，页面加载不再拦截；
 * - 只有「设置」入口需要密码：点击设置按钮时若未解锁则弹框，成功后才打开抽屉；
 * - 设置类 API 返回 401/503 时同样全局弹框（客户端 API 层统一触发，不再散落检查），
 *   未配置 PASSWORD 时弹窗提示管理员配置。
 */

type SetupRequired = boolean;

/** 设置解锁成功后派发：Providers 据此补跑仅在解锁后可用的启动流程（预置订阅、源测速） */
export const SETTINGS_UNLOCKED_EVENT = 'libretv:settings-unlocked';

interface AuthContextValue {
  checked: boolean;
  /** 设置是否已解锁（与站点浏览无关） */
  settingsUnlocked: boolean;
  /** 服务器未设置 PASSWORD，需要管理员配置 */
  setupRequired: SetupRequired;
  /** /api/status 返回的应用版本（构建时从 package.json 注入） */
  version: string | null;
  /**
   * 打开设置解锁框。onSuccess 在解锁成功后才调用——
   * 供「点击设置按钮」这类带后续动作的入口把抽屉打开接在解锁之后。
   */
  openLogin: (onSuccess?: () => void) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: false,
  settingsUnlocked: false,
  setupRequired: false,
  version: null,
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // 解锁成功后的待执行动作（如打开设置抽屉）；仅一次，成功或用户关闭弹框后清空
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api
      .status()
      .then((s) => {
        setSettingsUnlocked(s.settingsUnlocked);
        setSetupRequired(!s.passwordRequired);
        setVersion(s.version);
        setChecked(true);
      })
      .catch(() => setChecked(true));
  }, []);

  useEffect(
    () =>
      onUnauthorized((event) => {
        const setup = (event as CustomEvent).detail === 'setup';
        setSetupRequired(setup);
        setSettingsUnlocked(false);
        setModalOpen(true);
      }),
    []
  );

  const openLogin = useCallback((onSuccess?: () => void) => {
    pendingActionRef.current = onSuccess ?? null;
    setModalOpen(true);
  }, []);

  const closeLogin = useCallback(() => {
    pendingActionRef.current = null;
    setModalOpen(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSettingsUnlocked(false);
      toast('设置已锁定', 'info');
    }
  }, [toast]);

  const handleLoginSuccess = useCallback(() => {
    setSettingsUnlocked(true);
    setSetupRequired(false);
    setModalOpen(false);
    // 解锁前以 401/503 失败的查询（如设置抽屉里的探活）需要重新拉取
    queryClient.invalidateQueries();
    toast('设置已解锁', 'success');
    // 通知 Providers 补跑解锁后才可用的启动流程（预置订阅导入、预置源测速自动勾选）
    window.dispatchEvent(new CustomEvent(SETTINGS_UNLOCKED_EVENT));
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    pending?.();
  }, [toast, queryClient]);

  return (
    <AuthContext.Provider value={{ checked, settingsUnlocked, setupRequired, version, openLogin, logout }}>
      {children}
      {modalOpen && (
        <LoginModal setupRequired={setupRequired} onSuccess={handleLoginSuccess} onClose={closeLogin} />
      )}
    </AuthContext.Provider>
  );
}

function LoginModal({
  setupRequired,
  onSuccess,
  onClose,
}: {
  setupRequired: boolean;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const submit = async () => {
    if (!password.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '解锁失败';
      setError(msg === '设置未解锁' ? '密码错误' : msg);
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl">
        {setupRequired ? (
          <>
            <h2 className="text-lg font-semibold text-content mb-3">该功能不可用</h2>
            <p className="text-sm text-muted leading-relaxed">
              此功能需要密码，但当前服务未设置 <code className="text-accent">PASSWORD</code> 环境变量。
              请联系管理员在部署配置中添加该变量后重启服务。
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-content mb-1">输入密码</h2>
            <p className="text-sm text-muted mb-4">浏览与播放无需密码，此功能需要密码</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="密码"
                autoComplete="current-password"
              />
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '解锁中...' : '解锁'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
