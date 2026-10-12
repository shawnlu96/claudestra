/**
 * 外部通知渠道的设置（「设置 · 连接与集成 · 通知」，docs/design-notify-channels.md）：
 *   GET  /api/v1/notify        { channels: 视图（密钥只露尾四位）, openUrl, linkBase（自动探测的打开地址）, recent: {渠道 id: 最近结果} }
 *   PUT  /api/v1/notify        { channels, openUrl? } 整份替换；密钥字段不传 = 沿用同 id 的旧值，空串 = 清除
 *   POST /api/v1/notify/test   { id } 测已保存的渠道，或 { channel } 测还没保存的草稿（密钥缺的按 id 取旧值）
 * 三个都要全权：配置里有 topic / device key / webhook 地址，读也只给 owner（同「连接与集成」整页）。
 * 沙箱里测试发送直接拒：外部渠道在沙箱不建（push/init.ts），出站闸门拦下时的日志还会带上完整的 webhook 地址。
 */
import { canManage } from "../../lib/devices.js";
import { instanceKeySync, keyFingerprint } from "../../lib/instance-key.js";
import { channelView, normalizeChannel, normalizeFile, type NotifyFile } from "../../lib/notify-channels.js";
import { readNotifyFile, writeNotifyFile } from "../../lib/notify-store.js";
import type { Principal } from "../../lib/principals.js";
import { isSandbox } from "../../lib/sandbox.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { notifyLinkBase } from "../notify/link-base.js";
import { recentResults, sendTest } from "../notify/sink.js";
import type { Lookup } from "../notify/transport.js";

const MANAGE_MSG = "notification channels require a credential with manage grant";

interface Io {
  read: () => NotifyFile;
  write: (f: NotifyFile) => void;
  linkBase: () => string | null;
  sandboxed: () => boolean;
  fetch?: typeof fetch;
  lookup?: Lookup;
}
const realIo: Io = { read: () => readNotifyFile(), write: (f) => writeNotifyFile(f), linkBase: notifyLinkBase, sandboxed: () => isSandbox() };
let io = realIo;
/** 单测换成内存配置 / 假 fetch；生产不调 */
export function setNotifyIoForTest(p: Partial<Io> | undefined): void {
  io = p ? { ...realIo, ...p } : realIo;
}

function view(f: NotifyFile): Record<string, unknown> {
  return { ok: true, channels: f.channels.map(channelView), openUrl: f.openUrl ?? "", linkBase: io.linkBase(), recent: recentResults() };
}

const fpOf = (): string | undefined => {
  const k = instanceKeySync();
  return k ? keyFingerprint(k.publicKey) : undefined;
};

export async function handleNotifyApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/notify" && path !== "/notify/test") return null;
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  if (path === "/notify" && req.method === "GET") return apiJson(200, view(io.read()));
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  if (path === "/notify" && req.method === "PUT") {
    const next = normalizeFile(body, io.read());
    if (typeof next === "string") return apiJson(400, { ok: false, error: next });
    io.write(next);
    return apiJson(200, view(next));
  }
  if (path === "/notify/test" && req.method === "POST") {
    if (io.sandboxed()) return apiJson(409, { ok: false, code: "sandbox", error: "the sandbox does not send external notifications" });
    const b = (body ?? {}) as { id?: unknown; channel?: unknown };
    const file = io.read();
    const draftId = (b.channel as { id?: unknown } | undefined)?.id;
    const prev = file.channels.find((c) => c.id === (b.channel ? draftId : b.id));
    const ch = b.channel ? normalizeChannel(b.channel, prev) : (prev ?? "unknown channel id");
    if (typeof ch === "string") return apiJson(400, { ok: false, error: ch });
    const fp = fpOf();
    const deps = { read: () => file, linkBase: io.linkBase, ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.lookup ? { lookup: io.lookup } : {}), ...(fp ? { fp } : {}), retryDelayMs: 500 };
    const result = await sendTest(ch, deps, !!b.channel); // 带了草稿配置就算草稿：借已保存的 id 换个地址也一样
    return apiJson(200, { ok: true, result });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}
