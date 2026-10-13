import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionFromCookieHeader } from './auth';

/**
 * 设置类 API 的共享守卫：未配置密码返回 503，未解锁返回 401。
 *
 * 语义边界（重要）：本站的**浏览**功能（搜索/详情/推荐/直播列表与节目单）不再需要密码，
 * 因此搜索、详情、豆瓣、Bangumi、热榜、直播列表与 EPG 等路由**不要**加这个守卫；
 * 只有「设置」抽屉会用到的接口才用——发布订阅快照（publish）、源探活（source/test）、
 * 订阅拉取（source-list）、直播测活（live/probe）。
 * 前端在设置按钮与抽屉入口处校验解锁状态，这里的 401/503 只是服务端兜底。
 */
export function guardSettingsRequest(req: Request): NextResponse | null {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: '服务器未设置 PASSWORD 环境变量' },
      { status: 503 }
    );
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return NextResponse.json({ error: '设置未解锁' }, { status: 401 });
  }
  return null;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
