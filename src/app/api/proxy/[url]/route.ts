import { decodePathTarget, handleProxyRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';

/**
 * 点播/图片代理（旧路径形式，兼容入口）：`/api/proxy/<encodeURIComponent(target)>`
 *
 * 新地址一律由查询串形式 `/api/proxy?url=` 下发；此入口保留是为兼容
 * 已下发给浏览器的播放列表与缓存里的分片地址，实现体仅做解码后转调公共 handler。
 */
export async function GET(req: Request, ctx: { params: Promise<{ url: string }> }) {
  const { url: encodedUrl } = await ctx.params;
  return handleProxyRequest(req, decodePathTarget(encodedUrl));
}
