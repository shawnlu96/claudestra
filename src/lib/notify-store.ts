/**
 * 外部通知渠道的配置文件 ~/.claude-orchestrator/notify-channels.json（lib/notify-channels.ts 定形状）。
 * 里面有 ntfy token、Bark device key、Webhook 地址与签名密钥，所以权限 0600、只由 bridge 读写；网页只拿到尾四位。
 * 读坏了不抛：按「没配渠道」继续（通知发不出去不能让 bridge 起不来），坏在哪一条打日志。
 */
import { join } from "node:path";
import { normalizeChannel, type NotifyChannel, type NotifyFile } from "./notify-channels.js";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const NOTIFY_FILE = join(STATE_DIR, "notify-channels.json");
const EMPTY: NotifyFile = { channels: [] };

export function readNotifyFile(path = NOTIFY_FILE): NotifyFile {
  const r = readJsonStateSync(path, (d) => !!d && typeof d === "object" && Array.isArray((d as NotifyFile).channels));
  if (r.status === "missing") return EMPTY;
  if (r.status === "corrupt") {
    console.error(`⚠️ 通知渠道配置读不了（${r.error}），按没配渠道处理: ${path}`);
    return EMPTY;
  }
  const raw = r.data as { channels: unknown[]; openUrl?: unknown };
  const channels: NotifyChannel[] = [];
  for (const c of raw.channels) {
    const n = normalizeChannel(c);
    if (typeof n === "string") console.error(`⚠️ 通知渠道配置里有一条不合法，跳过（${n}）`);
    else channels.push(n);
  }
  return { channels, ...(typeof raw.openUrl === "string" && raw.openUrl ? { openUrl: raw.openUrl } : {}) };
}

export function writeNotifyFile(f: NotifyFile, path = NOTIFY_FILE): void {
  writeJsonAtomicSync(path, f, { mode: 0o600 });
}
