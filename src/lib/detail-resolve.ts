import { cmsRequestHeaders, parseDetail, parseDetailPageHtml } from './cms-parser';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { checkUpstreamAllowed } from './ssrf';
import type { SourceConfig, VideoDetail } from './types';

/**
 * 详情解析的复用核心：从 /api/detail 抽出，供家庭过滤版 TVBOX 代理共用。
 * 与路由内原实现逐行一致——改这里会影响两条链路。
 */

/** 详情结果短缓存：换源测速/多人观看同一影片时避免重复打上游 */
export const DETAIL_CACHE_TTL = 60 * 1000;

export type DetailResolveResult = { ok: true; detail: VideoDetail } | { ok: false; blocked?: string };

/**
 * 视频详情：优先走列表接口 ?ac=videolist&ids=，
 * 拿不到播放地址时（部分源需要爬详情页）降级到 detail 页 HTML 提取。
 * ok=false + blocked 有值表示被 SSRF 拦下（调用方一般映射为 400），
 * ok=false 无 blocked 表示单纯没拿到可播地址（调用方一般映射为 404）。
 */
export async function resolveDetail(id: string, source: SourceConfig, baseUrl = ''): Promise<DetailResolveResult> {
  // 命中 60s 缓存直接返回（仅缓存成功拿到剧集的结果）
  const detailRootForCache = (source.detail || baseUrl || '').replace(/\/+$/, '');
  const cacheKey = `detail:${source.url}|${detailRootForCache}|${id}`;
  const cached = getCache<VideoDetail>(cacheKey);
  if (cached) {
    return { ok: true, detail: cached };
  }

  // 用户可控地址发起服务端请求，先过 SSRF 校验（协议白名单 + 内网/保留地址）
  const listVerdict = await checkUpstreamAllowed(source.url);
  if (!listVerdict.ok) {
    return { ok: false, blocked: listVerdict.reason };
  }

  let resolved: VideoDetail | null = null;

  // 1) 标准列表接口
  const api = `${source.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(id)}`;
  const res = await fetchUpstream(api, { timeoutMs: 10000, headers: cmsRequestHeaders() });
  if (res.ok) {
    const data = await res.json();
    try {
      const detail = parseDetail(data, source);
      if (detail.episodes.length > 0) {
        resolved = detail;
      }
      // 有详情但无播放地址 → 继续尝试详情页
    } catch {
      // 列表接口无内容 → 继续尝试详情页
    }
  }

  // 2) 详情页 HTML 提取（detail 地址优先，否则用 API 地址推导）
  const detailRoot = (source.detail || baseUrl || '').replace(/\/+$/, '');
  if (!resolved && detailRoot && /^https?:\/\//.test(detailRoot)) {
    const detailVerdict = await checkUpstreamAllowed(detailRoot);
    if (!detailVerdict.ok) {
      return { ok: false, blocked: detailVerdict.reason };
    }
    const detailUrl = `${detailRoot}/index.php/vod/detail/id/${id}.html`;
    const detailRes = await fetchUpstream(detailUrl, {
      timeoutMs: 10000,
      headers: { 'User-Agent': cmsRequestHeaders()['User-Agent'] },
    });
    if (detailRes.ok) {
      const html = await detailRes.text();
      resolved = parseDetailPageHtml(html, source);
    }
  }

  if (!resolved || resolved.episodes.length === 0) {
    return { ok: false };
  }
  setCache(cacheKey, resolved, DETAIL_CACHE_TTL);
  return { ok: true, detail: resolved };
}
