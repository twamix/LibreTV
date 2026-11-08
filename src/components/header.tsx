'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { Icon, type IconName } from './icon';
import { requestShowDownloadManager } from './download-manager';
import { useAuth } from './auth';
import { cn } from '@/lib/utils';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { settingsUnlocked, openLogin } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 移动端（<sm）折叠菜单：窄屏放不下导航项与多个图标按钮 */
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);

  const closeMenu = () => setMenuOpen(false);

  /** 设置入口需要密码：未解锁先弹解锁框，成功后再打开抽屉 */
  const openSettings = () => {
    closeMenu();
    if (settingsUnlocked) setSettingsOpen(true);
    else openLogin(() => setSettingsOpen(true));
  };

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    closeMenu();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2 sm:gap-3">
          <Link href="/" aria-label="TV 首页" className="flex items-center shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512.png" alt="TV" className="w-7 h-7 rounded-lg" />
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-9',
                    // 展开时：上圆角与外框沿用聚焦样式，底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible &&
                      'rounded-b-none border-accent border-b-line bg-surface-raised focus:ring-0 focus:border-accent'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索影片..."
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          {/* 窄屏占位：把右侧按钮组推到边上（桌面搜索框已用 flex-1 占位） */}
          <div className="flex-1 sm:hidden" />

          {/* 桌面 / 平板：完整导航 */}
          <nav className="hidden sm:flex items-center gap-1 ml-auto">
            <HeaderLink href="/live" active={pathname === '/live'}>
              直播
            </HeaderLink>
            <ThemeToggle />
            <IconButton label="下载管理" onClick={() => requestShowDownloadManager()}>
              <Icon name="download" className="w-5 h-5" />
            </IconButton>
            <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </IconButton>
            {/* 设置入口需要密码：未解锁先弹解锁框，成功后再打开抽屉（未配置 PASSWORD 时提示管理员） */}
            <IconButton label="设置" onClick={openSettings}>
              <Icon name="gear" className="w-5 h-5" />
            </IconButton>
          </nav>

          {/* 手机：设置直接露出（最常用），其余收进汉堡菜单 */}
          <div className="sm:hidden flex items-center gap-1 shrink-0">
            <IconButton label="设置" onClick={openSettings}>
              <Icon name="gear" className="w-5 h-5" />
            </IconButton>
            <IconButton
              label={menuOpen ? '关闭菜单' : '打开菜单'}
              expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} className="w-5 h-5" />
            </IconButton>
          </div>
        </div>

        {/* 手机折叠菜单：链接 + 次要操作；点任一项后自动收起 */}
        {menuOpen && (
          <nav
            aria-label="主菜单"
            className="sm:hidden border-t border-line bg-surface/95 backdrop-blur px-3 py-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom))] animate-fade-in"
          >
            <div className="grid grid-cols-2 gap-1.5">
              <MenuRow href="/live" active={pathname === '/live'} icon="bolt" onNavigate={closeMenu}>
                直播
              </MenuRow>
              <MenuAction icon="clock" onClick={() => { closeMenu(); setHistoryOpen(true); }}>
                观看历史
              </MenuAction>
              <MenuAction icon="download" onClick={() => { closeMenu(); requestShowDownloadManager(); }}>
                下载管理
              </MenuAction>
              <MenuRow href="/" active={pathname === '/'} icon="home" onNavigate={closeMenu}>
                首页
              </MenuRow>
            </div>
            <div className="mt-1.5 flex items-center justify-between rounded-lg bg-chip px-3 py-2">
              <span className="text-xs text-muted">外观主题</span>
              <ThemeToggle />
            </div>
          </nav>
        )}
      </header>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

function HeaderLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2.5 py-1.5 rounded-md text-sm transition-colors',
        active ? 'text-content bg-hover' : 'text-muted hover:text-content'
      )}
    >
      {children}
    </Link>
  );
}

function IconButton({
  label,
  onClick,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  /** 展开态按钮（汉堡菜单）需要 aria-expanded 告知辅助技术 */
  expanded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 手机折叠菜单里的导航项（整行可点，热区 ≥40px） */
function MenuRow({
  href,
  active,
  icon,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  icon: IconName;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors',
        active ? 'bg-hover text-content' : 'text-muted hover:bg-hover hover:text-content'
      )}
    >
      <Icon name={icon} className="w-4 h-4 shrink-0" />
      {children}
    </Link>
  );
}

/** 手机折叠菜单里的动作项（打开抽屉，不是跳转） */
function MenuAction({
  icon,
  onClick,
  children,
}: {
  icon: IconName;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-muted transition-colors hover:bg-hover hover:text-content"
    >
      <Icon name={icon} className="w-4 h-4 shrink-0" />
      {children}
    </button>
  );
}

// Drawer 已抽至 ./drawer（download-manager 等组件也复用，避免 header 循环依赖），此处再导出保持既有引用不变
export { Drawer } from './drawer';
