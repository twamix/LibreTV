import { NextResponse } from 'next/server';
import {
  ADULT_COOKIE,
  adultFromCookieHeader,
  checkAdultPassword,
  checkRateLimit,
  clearRateLimit,
  isAdultPasswordConfigured,
  signSession,
} from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * 成人内容源解锁。
 * - 部署者在环境变量 ADULT_PASSWORD 中设置密码（docker-compose / .env）；
 * - 前端在「设置 → 点播源」底部输入该密码，验证通过后下发签名 cookie（ltv_adult）；
 * - 与主登录独立的 httpOnly cookie，解锁状态只作用于本浏览器。
 */
function secureFrom(req: Request): boolean {
  return process.env.COOKIE_SECURE === 'true'
    ? true
    : process.env.COOKIE_SECURE === 'false'
      ? false
      : (req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http') === 'https';
}

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

/** GET：查询部署者是否配置成人密码、当前浏览器是否已解锁 */
export async function GET(req: Request) {
  const configured = isAdultPasswordConfigured();
  return NextResponse.json({
    configured,
    unlocked: configured && adultFromCookieHeader(req.headers.get('cookie')),
  });
}

/** POST：用 ADULT_PASSWORD 解锁成人内容源 */
export async function POST(req: Request) {
  if (!isAdultPasswordConfigured()) {
    return NextResponse.json({ configured: false, error: '服务器未配置 ADULT_PASSWORD 环境变量' }, { status: 400 });
  }

  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: '尝试次数过多，请 10 分钟后再试' }, { status: 429 });
  }

  let password = '';
  try {
    const body = (await req.json()) as { password?: string };
    password = String(body.password ?? '');
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  // 用 403 而非 401：401 会触发前端全局登录框，成人解锁失败应只在设置内提示
  if (!checkAdultPassword(password)) {
    return NextResponse.json({ error: '密码错误' }, { status: 403 });
  }

  clearRateLimit(ip);
  const { token, expiresAt } = signSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADULT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureFrom(req),
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
    path: '/',
  });
  return res;
}

/** DELETE：锁定成人内容源（清除解锁 cookie） */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADULT_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' });
  return res;
}