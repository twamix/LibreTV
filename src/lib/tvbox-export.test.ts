import { describe, expect, it } from 'vitest';
import { buildTvboxConfig } from './tvbox-export';
import { isTvboxPayload, parseTvboxPayload } from './tvbox-parser';

/**
 * TVBOX 导出单测：字段映射、key 去重，以及「导出 → 解析」往返不丢源。
 */

describe('buildTvboxConfig', () => {
  it('点播按 type=1 导出并带 TVBOX 通用字段，直播按 type=0 导出', () => {
    const config = buildTvboxConfig(
      [{ name: '采集站', url: 'https://a.example.com/api.php/provide/vod' }],
      [{ name: '频道表', url: 'https://l.example.com/tv.m3u', epg: 'https://e.example.com/e.xml' }]
    );
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0]).toMatchObject({
      key: '采集站',
      name: '采集站',
      type: 1,
      api: 'https://a.example.com/api.php/provide/vod',
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    });
    expect(config.lives).toHaveLength(1);
    expect(config.lives[0]).toMatchObject({
      name: '频道表',
      type: 0,
      url: 'https://l.example.com/tv.m3u',
      epg: 'https://e.example.com/e.xml',
    });
  });

  it('空名回落为地址；无 EPG 的直播源不带 epg 键', () => {
    const config = buildTvboxConfig(
      [{ name: '  ', url: 'https://a.example.com/api.php/provide/vod' }],
      [{ name: '', url: 'https://l.example.com/tv.m3u' }]
    );
    expect(config.sites[0].key).toBe('https://a.example.com/api.php/provide/vod');
    expect(config.sites[0].name).toBe('https://a.example.com/api.php/provide/vod');
    expect(config.lives[0].name).toBe('https://l.example.com/tv.m3u');
    expect(config.lives[0]).not.toHaveProperty('epg');
  });

  it('同名站点的 key 追加 _2、_3 顺延，导出的 key 永不重复', () => {
    const config = buildTvboxConfig(
      [
        { name: '同名', url: 'https://a.example.com/api.php/provide/vod' },
        { name: '同名', url: 'https://b.example.com/api.php/provide/vod' },
        { name: '同名', url: 'https://c.example.com/api.php/provide/vod' },
      ],
      []
    );
    expect(config.sites.map((s) => s.key)).toEqual(['同名', '同名_2', '同名_3']);
  });

  it('导出 → 解析往返：条目不丢失，地址原样', () => {
    const config = buildTvboxConfig(
      [
        { name: 'A', url: 'https://a.example.com/api.php/provide/vod' },
        { name: 'B', url: 'https://b.example.com/api.php/provide/vod' },
      ],
      [{ name: 'L', url: 'https://l.example.com/tv.m3u', epg: 'https://e.example.com/e.xml' }]
    );
    const json = JSON.parse(JSON.stringify(config)) as unknown;
    expect(isTvboxPayload(json)).toBe(true);

    const parsed = parseTvboxPayload(json);
    expect(parsed.sources.map((s) => s.url).sort()).toEqual([
      'https://a.example.com/api.php/provide/vod',
      'https://b.example.com/api.php/provide/vod',
    ]);
    expect(parsed.liveSources).toHaveLength(1);
    expect(parsed.liveSources[0]).toMatchObject({
      url: 'https://l.example.com/tv.m3u',
      epg: 'https://e.example.com/e.xml',
    });
  });
});
