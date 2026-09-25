import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES } from '@/lib/source-list';
import { MAX_PUBLISH_BYTES, publishSourceList } from '@/lib/source-list-publish';
import { buildTvboxConfig } from '@/lib/tvbox-export';
import { parseSubscriptionPayload } from '@/lib/tvbox-parser';

export const runtime = 'nodejs';

/** 发布格式：默认 LibreTV-SourceList；tvbox 即 TVBOX 客户端可直接订阅的 sites/lives 配置 */
const FORMATS = ['libretv', 'tvbox'] as const;
type PublishFormat = (typeof FORMATS)[number];

/** 单个字段长度上限：源名与地址再长也不该超过这个量级 */
const MAX_FIELD_LEN = 2048;

interface VodOut {
  name: string;
  url: string;
}

interface LiveOut {
  name: string;
  url: string;
  epg?: string;
}

/**
 * 只抽取已知字段并重新序列化。
 * 本接口的语义是「发布源列表」，不是通用上传通道：白名单式取字段 + 条数上限，
 * 避免它被当作任意内容的中转（服务端会向固定第三方域名 POST，这一点必须守住）。
 */
function normalizePayload(raw: unknown): { name?: string; sources: VodOut[]; liveSources: LiveOut[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const text = (v: unknown, max = MAX_FIELD_LEN) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const url = (v: unknown) => {
    const s = text(v);
    return /^https?:\/\//i.test(s) ? s : '';
  };

  const sources = (Array.isArray(record.sources) ? record.sources : [])
    .slice(0, MAX_VOD_SOURCES)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return { name: text(o.name, 128), url: url(o.url) };
    })
    .filter((s) => s.url);

  const liveSources = (Array.isArray(record.liveSources) ? record.liveSources : [])
    .slice(0, MAX_LIVE_SOURCES)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const epg = url(o.epg);
      return { name: text(o.name, 128), url: url(o.url), ...(epg ? { epg } : {}) };
    })
    .filter((s) => s.url);

  if (sources.length === 0 && liveSources.length === 0) return null;
  return { name: text(record.name, 64) || undefined, sources, liveSources };
}

/** 把当前源列表发布到第三方粘贴板，返回可直接填入订阅框的 URL */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: '请求内容不是合法 JSON' }, { status: 400 });
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const format: PublishFormat = record.format === 'tvbox' ? 'tvbox' : 'libretv';

  const normalized = normalizePayload(raw);
  if (!normalized) {
    return NextResponse.json({ error: '没有可发布的源（当前没有已勾选启用的点播源或直播源）' }, { status: 400 });
  }

  const payload =
    format === 'tvbox'
      ? // TVBOX 导出：sites/lives 结构，TVBOX 客户端可直接订阅；
        // 复用本站的订阅入口解析器做一次往返校验，导出的东西必须本站自己认得回来
        tvboxPayload(normalized)
      : // 与「导出数据源」保持同一种格式，发布出去的链接可以直接被本站或他人订阅
        JSON.stringify(
          {
            name: normalized.name ?? 'LibreTV-SourceList',
            version: 2,
            exportedAt: Date.now(),
            sources: normalized.sources,
            liveSources: normalized.liveSources,
          },
          null,
          2
        );

  if (payload === null) {
    return NextResponse.json({ error: 'TVBOX 导出内容无法被本站订阅入口识别，请重试' }, { status: 500 });
  }

  if (Buffer.byteLength(payload, 'utf8') > MAX_PUBLISH_BYTES) {
    return NextResponse.json({ error: '源列表体积超出公开粘贴板的限制，无法发布' }, { status: 413 });
  }

  try {
    const { url, provider } = await publishSourceList(payload);
    return NextResponse.json({
      url,
      provider,
      format,
      sources: normalized.sources.length,
      liveSources: normalized.liveSources.length,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '发布失败' }, { status: 502 });
  }
}

/**
 * 生成 TVBOX 配置文本。返回 null 表示往返校验失败——正常不会发生，
 * 一旦发生说明导出与导入两端的映射脱钩，宁可报错也不发布半残配置。
 */
function tvboxPayload(normalized: { sources: VodOut[]; liveSources: LiveOut[] }): string | null {
  const config = buildTvboxConfig(normalized.sources, normalized.liveSources);
  try {
    const roundTrip = parseSubscriptionPayload(config);
    if (roundTrip.sources.length === 0 && roundTrip.liveSources.length === 0) return null;
    // 往返不丢源：转换过程中被解析器跳过的条目数不得超过截断容忍（正常为 0）
    if (
      roundTrip.sources.length < normalized.sources.length ||
      roundTrip.liveSources.length < normalized.liveSources.length
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return JSON.stringify(config, null, 2);
}