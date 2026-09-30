import { decodePathTarget, handleLiveStreamRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 直播流代理（旧路径形式，兼容入口）：`/api/live/stream/<encodeURIComponent(target)>` */
export async function GET(req: Request, ctx: { params: Promise<{ url: string }> }) {
  const { url: encodedUrl } = await ctx.params;
  return handleLiveStreamRequest(req, decodePathTarget(encodedUrl));
}
