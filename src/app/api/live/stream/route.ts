import { NextResponse } from 'next/server';
import { handleLiveStreamRequest, readTargetFromQuery } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 直播流代理（查询串形式）：`/api/live/stream?url=<encodeURIComponent(target)>` */
export async function GET(req: Request) {
  const targetUrl = readTargetFromQuery(req);
  if (!targetUrl) {
    return NextResponse.json({ error: '缺少 url 参数' }, { status: 400 });
  }
  return handleLiveStreamRequest(req, targetUrl);
}
