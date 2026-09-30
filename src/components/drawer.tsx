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
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
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
          width
        )}
        role="dialog"
        aria-label={title}
      >
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
