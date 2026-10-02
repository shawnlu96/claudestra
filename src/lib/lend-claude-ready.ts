/**
 * 出借方本机 Claude 的就绪结论跨进程共享。hello 和兜底轮询在常驻的出借循环（调度服务）里算，缓存是热的；推送收单是 bridge 每次新起的
 * `manager lend inbox` 子进程，缓存永远是空的。两边各算各的，就会 hello 报有位、推送却一律 no_slot。
 * 办法：结论放进出借 journal 的 meta（READY_KEY），两边取 at 较新的那份对齐——循环每轮同步一次，收单进程先读、不新鲜就当场探一次再写回。
 * 收单闸（lib/lend-inbox.ts admitOrders）照旧用 claudeLendSlots 判名额，判为不可用时由它打带原因的那行 stderr。tests/lend-claude-ready.test.ts。
 */
import type { Database } from "bun:sqlite";
import {
  cachedClaudeReadiness, claudeAuthStatus, claudeQuota, claudeReadinessOneShot, freshClaudeReadiness, noteClaudeReadiness, probeClaudeLend, type ClaudeReadiness,
} from "./lend-claude-worker-capacity.js";
import type { LendDeps } from "./lend-drive.js";
import { liveGrant } from "./lend-grant.js";
import { LENDER_IDLE_MS, TICK_KEY } from "./lend-inbox.js";
import { getMeta, setMeta } from "./lend-journal.js";

export const READY_KEY = "claudeReady";
/** 收单子进程里当场探测的上限：bridge 只给这个子进程 15 秒（local-api/lend-inbox.ts），探测卡住也得在那之前回 no_slot + 原因，不能被强杀成 unavailable */
export const INBOX_PROBE_MS = 8_000;

/** 当场探测的桩与时限（测试注入）；不设 = 真跑 claude auth status、INBOX_PROBE_MS 封顶 */
export interface InboxClaude { probe?: () => Promise<string | null>; budgetMs?: number }

/** meta 里的结论；没写过、写坏了、自相矛盾（ready 却带原因 / 不 ready 却没原因）都当没有，调用方会当场重探 */
export function sharedClaudeReadiness(db: Database): ClaudeReadiness | null {
  let v: Partial<ClaudeReadiness> | null;
  try { v = JSON.parse(getMeta(db, READY_KEY) ?? "null") as Partial<ClaudeReadiness> | null; } catch { return null; /* 坏值等于没写：重探一次就会被覆盖 */ }
  if (!v || typeof v.ready !== "boolean" || !Number.isFinite(v.at)) return null;
  if (v.ready ? v.reason !== null : typeof v.reason !== "string" || !v.reason) return null;
  return { ready: v.ready, reason: v.reason ?? null, at: v.at as number };
}

/** 进程里的结论和 meta 里的取较新的一份：meta 新就记进本进程缓存，本进程新就写进 meta。两边一样 = 什么都不做 */
export function syncClaudeReadiness(db: Database): void {
  const mine = cachedClaudeReadiness();
  const theirs = sharedClaudeReadiness(db);
  if (theirs && (!mine || theirs.at > mine.at)) noteClaudeReadiness(theirs);
  else if (mine && (!theirs || mine.at > theirs.at)) setMeta(db, READY_KEY, JSON.stringify(mine));
}

/** 限时探测：到点就给「超时」结论（记成不可用）；真跑的 auth status 再晚 1 秒被强杀，卡住的子进程拖不住收单进程退出 */
export function probeWithin(ms: number, probe = () => probeClaudeLend({ status: () => claudeAuthStatus(process.env, ms + 1000), quota: claudeQuota })): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((done) => { timer = setTimeout(() => done(`核对本机 Claude 登录超时（${ms / 1000} 秒）`), ms); });
  return Promise.race([probe(), late]).finally(() => clearTimeout(timer));
}

/**
 * 推送收单进程在收单闸之前把 Claude 结论定下来（进程是一次性的，先关掉后台刷新）。这批没有 Claude 单、出借方停摆（反正整批 lender_idle）、
 * 调用方指纹对不上或授权里没有 Claude 位，都不探、不加延迟；否则先认 meta 里 60 秒内的结论，
 * 没有或过期就当场探一次（INBOX_PROBE_MS 封顶，超时 = 不可用）并写回 meta。
 * 授权在这里只是「值不值得探」的预判，真正的判定仍在 admitOrders 里重读 lend.json 之后做。
 */
export async function primeInboxClaude(d: Pick<LendDeps, "db" | "now" | "readLend" | "context" | "writeOpen">, caller: { peer: string; fp: string | null },
  orders: readonly { family: string }[], opts: InboxClaude = {}): Promise<void> {
  claudeReadinessOneShot();
  if (!orders.some((o) => o.family === "claude") || caller.fp === null) return;
  if (d.now() - Number(getMeta(d.db, TICK_KEY) ?? 0) > LENDER_IDLE_MS) return;
  const g = await liveGrant(caller, d);
  if (!g.ok || g.entry.fp !== caller.fp || !(g.entry.families.claude ?? 0)) return;
  syncClaudeReadiness(d.db);
  await freshClaudeReadiness(Date.now(), () => probeWithin(opts.budgetMs ?? INBOX_PROBE_MS, opts.probe)); // 结论的 at 都按 Date.now() 记，新鲜度也按它算
  syncClaudeReadiness(d.db);
}
