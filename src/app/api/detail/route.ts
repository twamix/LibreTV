import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { resolveDetail } from '@/lib/detail-resolve';
import type { SourceConfig, VideoDetail } from '@/lib/types';

export const runtime = 'nodejs';

function parseSource(raw: string | null): SourceConfig | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as SourceConfig;
    if (!obj || !/^https?:\/\//.test(obj.url || '')) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 视频详情：优先走列表接口 ?ac=videolist&ids=，
 * 拿不到播放地址时（部分源需要爬详情页）降级到 detail 页 HTML 提取。
 * 解析核心复用 `@/lib/detail-resolve`，与家庭过滤版 TVBOX 代理共用同一套链路。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  const source = parseSource(url.searchParams.get('source'));
  const baseUrl = (url.searchParams.get('baseUrl') || '').trim(); // 可选：详情页根地址

  if (!id || !/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID' }, { status: 400 });
  }
  if (!source) {
    return NextResponse.json({ error: '无效的点播源配置' }, { status: 400 });
  }

  try {
    const resolved = await resolveDetail(id, source, baseUrl);
    if (!resolved.ok) {
      if (resolved.blocked) {
        return NextResponse.json({ error: resolved.blocked }, { status: 400 });
      }
      return NextResponse.json({ error: '未找到播放资源' }, { status: 404 });
    }
    const detail: VideoDetail = resolved.detail;
    return NextResponse.json(detail);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取详情失败' },
      { status: 502 }
    );
  }
}
