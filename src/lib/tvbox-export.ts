/**
 * TVBOX 导出：把本站的点播源 / 直播源转成 TVBOX 客户端可直接订阅的配置格式。
 *
 * 与 tvbox-parser.ts 是互逆关系——那边负责「TVBOX → 本站」导入，
 * 这里负责「本站 → TVBOX」导出。只处理直连类条目（与本站能力对齐）：
 * - 点播：全部按 type=1（Apple CMS JSON 接口）导出，本站的点播源本身就是这类；
 * - 直播：按 type=0（M3U 播放列表）导出，可带 EPG。
 *
 * 纯字段映射，不涉及网络与 SSRF（发布链路复用 /api/publish 的粘贴板通道）。
 */

export interface TvboxExportVod {
  name: string;
  url: string;
}

export interface TvboxExportLive {
  name: string;
  url: string;
  epg?: string;
}

export interface TvboxSite {
  key: string;
  name: string;
  /** TVBOX 站点类型：固定 1（JSON 接口） */
  type: 1;
  api: string;
  searchable: number;
  quickSearch: number;
  filterable: number;
}

export interface TvboxLive {
  name: string;
  /** TVBOX 直播源类型：固定 0（M3U 播放列表） */
  type: 0;
  url: string;
  epg?: string;
}

export interface TvboxConfig {
  sites: TvboxSite[];
  lives: TvboxLive[];
}

/**
 * 由点播/直播源列表生成 TVBOX 配置对象。
 * key 取站点名（TVBOX 客户端内以 key 唯一标识），重名时追加 _2、_3 依次顺延；
 * name 为空时回落为地址，保证导出的 key/name 永不为空。
 */
export function buildTvboxConfig(sources: TvboxExportVod[], liveSources: TvboxExportLive[]): TvboxConfig {
  const usedKeys = new Set<string>();
  const keyOf = (name: string) => {
    const base = name.trim() || '未命名';
    if (!usedKeys.has(base)) {
      usedKeys.add(base);
      return base;
    }
    let i = 2;
    while (usedKeys.has(`${base}_${i}`)) i += 1;
    const key = `${base}_${i}`;
    usedKeys.add(key);
    return key;
  };

  const sites: TvboxSite[] = sources.map((s) => {
    const name = s.name.trim() || s.url;
    return {
      key: keyOf(name),
      name,
      type: 1,
      api: s.url,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
  });

  const lives: TvboxLive[] = liveSources.map((s) => {
    const name = s.name.trim() || s.url;
    const epg = s.epg?.trim();
    return {
      name,
      type: 0,
      url: s.url,
      ...(epg ? { epg } : {}),
    };
  });

  return { sites, lives };
}
