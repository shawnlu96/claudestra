/**
 * 投递幂等（T48 P2-1）：发送方给一次投递带稳定的标识（统一派单用「派单编号 + 轮次」，重发不变），
 * 接收端按「谁发的 + 标识」记一笔；同一个标识再来就不再投递、不再建 thread，回第一次的 thread。
 * 覆盖两个入口：peer / API 的 POST /agents/:name/messages（bridge/api-routes.ts），本机派单的 ws dispatch_to_agent（bridge/dispatch-route.ts）。
 * 落盘（重试可能跨 bridge 重启，退避最长 1 小时）；保留 7 天、最多 2000 条，满了挤掉最旧的——挤掉的标识再来会当成新消息，
 * 只可能多投一次，不会丢消息。tests/ledger-step-dispatch.test.ts「复审修复」。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const FILE = statePath("delivery-dedup.json");
const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 2000;
/** 标识只认普通字符：它进日志和状态文件，不许夹带换行或控制字符 */
const KEY_RE = /^[\w.:@/-]{1,160}$/;

type Store = Record<string, { threadId: string; at: number }>;

/** 请求里带的标识；不合法就当没带（照常投递，只是没有幂等） */
export function dedupKeyOf(raw: unknown): string | null {
  return typeof raw === "string" && KEY_RE.test(raw) ? raw : null;
}

function load(file: string, now: number): Store {
  const r = readJsonStateSync(file);
  const s = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Store) : {};
  const out: Store = {};
  for (const [k, v] of Object.entries(s)) if (v && typeof v.at === "number" && now - v.at < TTL_MS && typeof v.threadId === "string") out[k] = v;
  return out;
}

/** 这个发送方的这个标识投过没有；投过返回当时的 threadId */
export function seenDelivery(sender: string, key: string, now = Date.now(), file = FILE): string | null {
  return load(file, now)[`${sender}|${key}`]?.threadId ?? null;
}

/** 投递成功后记一笔（调用方在 deliver 返回 sent 之后调） */
export function noteDelivery(sender: string, key: string, threadId: string, now = Date.now(), file = FILE): void {
  const s = load(file, now);
  s[`${sender}|${key}`] = { threadId, at: now };
  const keys = Object.keys(s).sort((a, b) => s[a]!.at - s[b]!.at);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete s[k];
  try {
    writeJsonAtomicSync(file, s);
  } catch (e) {
    // 记不下只影响「重发会不会再投一次」，这次投递已经成功，不能因此报失败
    console.warn(`[delivery-dedup] 写 ${file} 失败，这条的重发不再去重: ${(e as Error).message}`);
  }
}
