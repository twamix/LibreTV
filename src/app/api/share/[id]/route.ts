import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { getShareText } from '@/lib/share-store';

export const runtime = 'nodejs';

/**
 * 本站直链快照读取：`GET /api/share/<id>` 直接返回发布时存下的文本。
 *
 * 无登录态——TVBOX 客户端没有本站 cookie，id 本身就是凭证（128 位随机）。
 * id 不在内存里（重启丢失 / 从未存在）时统一 404 提示重新发布，不区分原因。
 */

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  void _req;
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{32,64}$/i.test(id)) {
    return NextResponse.json({ error: '无效的分享链接' }, { status: 400 });
  }

  const limited = checkRateLimit(`share:${id.toLowerCase()}`, 120, 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: '请求过于频繁，请稍后再试' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 60000) / 1000)) } }
    );
  }

  const text = getShareText(id);
  if (text === null) {
    return NextResponse.json({ error: '该分享已失效（服务重启后需重新发布）' }, { status: 404 });
  }
  return new NextResponse(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}
