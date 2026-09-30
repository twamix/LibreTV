import { describe, expect, it } from 'vitest';
import { buildImageCandidates, buildImageUrl } from './utils';

const DOUBAN = 'https://img9.doubanio.com/view/photo/x/public/p123.jpg';
const OTHER = 'https://img.lzipic.com/upload/vod/a.jpg';

describe('buildImageUrl', () => {
  it('空地址返回 undefined', () => {
    expect(buildImageUrl(undefined, 'proxy', '')).toBeUndefined();
  });

  it('proxy 走查询串代理（阶段 B 的路径形式已废弃）', () => {
    expect(buildImageUrl(OTHER, 'proxy', '')).toBe(`/api/proxy?url=${encodeURIComponent(OTHER)}`);
  });

  it('custom 支持 {url} 占位符与直接拼接', () => {
    expect(buildImageUrl(OTHER, 'custom', 'https://p.example.com/?url={url}')).toBe(
      `https://p.example.com/?url=${encodeURIComponent(OTHER)}`
    );
    expect(buildImageUrl(OTHER, 'custom', 'https://p.example.com/?u=')).toBe(
      `https://p.example.com/?u=${encodeURIComponent(OTHER)}`
    );
  });

  it('direct 返回原址', () => {
    expect(buildImageUrl(OTHER, 'direct', '')).toBe(OTHER);
  });
});

describe('buildImageCandidates', () => {
  it('空地址返回空候选链', () => {
    expect(buildImageCandidates(undefined, 'proxy', '')).toEqual([]);
    expect(buildImageCandidates('', 'direct', '')).toEqual([]);
  });

  it('proxy：内置代理优先，豆瓣图再补公共镜像与原址兜底', () => {
    const chain = buildImageCandidates(DOUBAN, 'proxy', '');
    expect(chain[0]).toBe(`/api/proxy?url=${encodeURIComponent(DOUBAN)}`);
    expect(chain).toContain('https://img.doubanio.cmliussss.net/view/photo/x/public/p123.jpg');
    expect(chain).toContain('https://img.doubanio.cmliussss.com/view/photo/x/public/p123.jpg');
    expect(chain[chain.length - 1]).toBe(DOUBAN);
  });

  it('proxy：非豆瓣图只有代理与原址两级', () => {
    expect(buildImageCandidates(OTHER, 'proxy', '')).toEqual([
      `/api/proxy?url=${encodeURIComponent(OTHER)}`,
      OTHER,
    ]);
  });

  it('direct：原址优先，豆瓣图依次回落镜像与内置代理', () => {
    const chain = buildImageCandidates(DOUBAN, 'direct', '');
    expect(chain[0]).toBe(DOUBAN);
    expect(chain).toContain('https://img.doubanio.cmliussss.net/view/photo/x/public/p123.jpg');
    expect(chain[chain.length - 1]).toBe(`/api/proxy?url=${encodeURIComponent(DOUBAN)}`);
  });

  it('direct：非豆瓣图回落到内置代理', () => {
    expect(buildImageCandidates(OTHER, 'direct', '')).toEqual([OTHER, `/api/proxy?url=${encodeURIComponent(OTHER)}`]);
  });

  it('custom 保持单地址，不被静默回退掩盖模板错误', () => {
    expect(buildImageCandidates(DOUBAN, 'custom', 'https://p.example.com/?url={url}')).toEqual([
      'https://p.example.com/?url=' + encodeURIComponent(DOUBAN),
    ]);
  });

  it('首选地址与 buildImageUrl 一致（两套 API 不会给出不同首选）', () => {
    expect(buildImageCandidates(DOUBAN, 'direct', '')[0]).toBe(buildImageUrl(DOUBAN, 'direct', ''));
    expect(buildImageCandidates(DOUBAN, 'proxy', '')[0]).toBe(buildImageUrl(DOUBAN, 'proxy', ''));
    const template = 'https://p.example.com/?url={url}';
    expect(buildImageCandidates(DOUBAN, 'custom', template)[0]).toBe(buildImageUrl(DOUBAN, 'custom', template));
  });
});
