import { randomBytes } from 'node:crypto';

/**
 * 本站直链快照存储：发布内容只存在自己服务器内存里，不再经过第三方粘贴板。
 *
 * 背景：之前发布走 paste.rs / 0x0.st，电视上的 TVBOX 要先从粘贴板拉配置，
 * 一旦这些域名被墙或服务波动，家里电视就开不了——发布链路不该依赖第三方可用性。
 * 现在 /api/publish 直接把文本存这里，返回 `${origin}/api/share/<id>`，
 * TVBOX / 本站订阅都直接回源拉取。
 *
 * 安全模型：id 即凭证（128 位随机，不可猜）；读取接口公开但 id 不可枚举，
 * 与之前的粘贴板短链接思路一致，只是内容落在自己服务器上。
 * 代价：纯内存（挂 globalThis 保证同进程各路由共用一份），服务重启后快照丢失，
 * 需重新发布——家人用场景单实例部署可接受，UI 文案里已明确告知。
 */

interface ShareEntry {
  text: string;
  createdAt: number;
}

/**
 * 内存 Map 必须挂在 globalThis 上，不能是模块顶层变量：
 * Next dev 按路由懒编译、生产构建按路由分 chunk，模块实例可能有多份，
 * /api/publish 存、/api/share 读必须看到同一份 Map，同进程内只有 globalThis 能保证。
 * （多进程/多实例部署下各进程仍独立——单实例家人用场景可接受，文案已告知重启需重发。）
 */
const globalStore = globalThis as unknown as { __libretvShares?: Map<string, ShareEntry> };
function shares(): Map<string, ShareEntry> {
  if (!globalStore.__libretvShares) globalStore.__libretvShares = new Map();
  return globalStore.__libretvShares;
}

/** 内存快照上限：源列表正常只有几 KB，500 份绰绰有余，超了淘汰最早的 */
const MAX_SHARES = 500;

/** 单次发布体积上限（沿用之前粘贴板时代的限制，防内存被单次发布撑爆） */
export const MAX_PUBLISH_BYTES = 256 * 1024;

/** 存一份文本，返回不可猜的分享 id */
export function saveShare(text: string): string {
  const store = shares();
  if (store.size >= MAX_SHARES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  const id = randomBytes(16).toString('hex');
  store.set(id, { text, createdAt: Date.now() });
  return id;
}

/** 取回快照文本，不存在返回 null（过期丢失与从未存在不区分，调用方统一提示重发） */
export function getShareText(id: string): string | null {
  return shares().get(id)?.text ?? null;
}

/**
 * 从 list 参数反解分享 id，支持两种形状：
 * - 裸 id（`abc123…` 32 位以上 hex）；
 * - 完整的本站分享 URL（`https://本站/api/share/<id>`，TVBOX 配置里存的就是这种）。
 * 非本站链接返回 null，调用方走原来的出网拉取（兼容以前已发布的粘贴板链接）。
 */
export function extractShareId(listUrl: string): string | null {
  const trimmed = listUrl.trim();
  if (/^[0-9a-f]{32,64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const path = new URL(trimmed).pathname;
    const m = /^\/api\/share\/([0-9a-f]{32,64})\/?$/i.exec(path);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 仅供单测清理状态 */
export function clearShares(): void {
  shares().clear();
}
