import { NextResponse } from 'next/server';
import { handleProxyRequest, readTargetFromQuery } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';

/**
 * 点播/图片代理（查询串形式）：`/api/proxy?url=<encodeURIComponent(target)>`
 *
 * 采用查询串而非路径段承载目标地址：路径段里的 `%2F` 等编码会被 EdgeOne 等
 * 网关在归一化时解码/重编码，导致路由参数与原编码不一致、解出非法地址。
 * 旧路径形式 `/api/proxy/<encoded>` 仍保留可用（见 [url]/route.ts）。
 */
export async function GET(req: Request) {
  const targetUrl = readTargetFromQuery(req);
  if (!targetUrl) {
    return new NextResponse('缺少 url 参数', { status: 400 });
  }
  return handleProxyRequest(req, targetUrl);
}
