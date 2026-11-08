'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 面板通用骨架：右侧抽屉。
 *
 * 从 header.tsx 抽出为独立模块：header 会依赖 download-manager（「下载管理」入口），
 * 而 download-manager 也需要抽屉——两者同住 header.tsx 会形成循环引用。
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
  mobileFull = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /**
   * 小屏（<sm）改为近全屏底部面板（默认 false）。
   * 设置抽屉里分好几组、每组又有若干开关与输入框，60vh 在手机上明显不够用；
   * 近全屏仍保留顶部一条露出遮罩，点空白处即可关闭。
   */
  mobileFull?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} />
      <div
        ref={ref}
        className={cn(
          'absolute right-0 top-0 h-full w-full bg-surface-raised border-l border-line overflow-y-auto scrollbar-thin animate-slide-up',
          width,
          // 手机端改为底部近全屏面板：贴底、顶部圆角、撑满高度，留出安全区内边距
          mobileFull &&
            'max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:h-[92dvh] max-sm:max-w-none max-sm:rounded-t-xl max-sm:border-t max-sm:border-l-0 max-sm:pb-[env(safe-area-inset-bottom)]'
        )}
        role="dialog"
        aria-label={title}
      >
        {mobileFull && (
          /* 顶部把手：明确「这是可关闭的底部面板」，只在手机形态出现 */
          <div className="hidden max-sm:flex shrink-0 justify-center pt-2 pb-0.5" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-line" />
          </div>
        )}
        <div className="sticky top-0 bg-surface-raised px-4 py-3.5 border-b border-line flex items-center justify-between z-10">
          <h2 className="font-semibold text-content">{title}</h2>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
