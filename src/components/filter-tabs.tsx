'use client';

import { cn } from '@/lib/utils';

/**
 * 源列表筛选标签条（点播源 / 直播源面板共用）。
 * 与设置内 Tab 同款视觉；aria-pressed 声明当前筛选态。
 */
export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((f) => (
        <button
          key={f.id}
          className={cn(
            'px-2 py-1 rounded-md text-[11px] transition-colors',
            value === f.id
              ? 'bg-accent/10 text-accent font-medium'
              : 'text-muted hover:text-content hover:bg-hover'
          )}
          aria-pressed={value === f.id}
          onClick={() => onChange(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** 源列表筛选维度，与点播/直播源面板保持同一组选项与顺序 */
export type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

export const VOD_FILTERS: { id: VodFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];
