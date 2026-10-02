/**
 * 出借方本机 Claude 的就绪结论跨进程共享。hello 和兜底轮询在常驻的出借循环（调度服务）里算；推送收单是 bridge 每次新起的
 * `manager lend inbox` 子进程，进程里没有结论。两边各算各的，就会 hello 报有位、推送却一律 no_slot。
 * 办法：结论放进出借 journal 的 meta（READY_KEY），只按 at 往新里写；两个进程都在用结论之前先和它对齐，不新鲜就当场探一次、先写回再用，
 * 而且都不后台刷新（claudeReadinessManual），一轮 / 一次收单里结论只在开头变一次。
 * 收单闸（lib/lend-inbox.ts admitOrders）照旧用 claudeLendSlots 判名额，判为不可用时由它打带原因的那行 stderr。tests/lend-claude-ready*.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LendEntry } from "./lend-config.js";
import {
  cachedClaudeReadiness, claudeAuthStatus, claudeQuota, claudeReadinessManual, CLAUDE_REASONS, freshClaudeReadiness, isClaudeReason, noteClaudeReadiness,
  probeClaudeLend, type ClaudeReadiness,
} from "./lend-claude-worker-capacity.js";
import type { LendDeps } from "./lend-drive.js";
import { liveGrant } from "./lend-grant.js";
import { LENDER_IDLE_MS, TICK_KEY } from "./lend-inbox.js";
import { getMeta, setMeta } from "./lend-journal.js";

export const READY_KEY = "claudeReady";
/** 当场探测的上限：bridge 只给收单子进程 15 秒（local-api/lend-inbox.ts），卡住也得在那之前回 no_slot + 原因，不能被强杀成 unavailable；出借循环同用 */
export const CLAUDE_PROBE_MS = 8_000;

/** 当场探测的桩与时限（测试注入）；不设 = 真跑 claude auth status、CLAUDE_PROBE_MS 封顶 */
export interface InboxClaude { probe?: () => Promise<string | null>; budgetMs?: number }

/** meta 里的结论；没写过、写坏了、自相矛盾、原因不在固定分类里，都当没有（调用方会重探，条件写也会覆盖它） */
export function sharedClaudeReadiness(db: Database): ClaudeReadiness | null {
  let v: Partial<ClaudeReadiness> | null;
  try { v = JSON.parse(getMeta(db, READY_KEY) ?? "null") as Partial<ClaudeReadiness> | null; } catch { return null; /* 坏值等于没写：重探一次就会被覆盖 */ }
  if (!v || typeof v.ready !== "boolean" || !Number.isFinite(v.at)) return null;
  if (v.ready ? v.reason !== null : !isClaudeReason(v.reason)) return null;
  return { ready: v.ready, reason: v.reason ?? null, at: v.at as number };
}

/** 条件写：只在 r 比库里的新（或库里没有 / 无效）时写。比较和写在同一个 BEGIN IMMEDIATE 写事务里，别的进程插不进中间；写守卫照旧经 setMeta */
export function publishClaudeReadiness(db: Database, r: ClaudeReadiness): boolean {
  return db.transaction((): boolean => {
    const cur = sharedClaudeReadiness(db);
    if (cur && cur.at >= r.at) return false;
    setMeta(db, READY_KEY, JSON.stringify(r));
    return true;
  }).immediate();
}

/** 本进程的结论条件写进 meta，再认 meta 里更新的那份（别的进程刚写的）。两边 at 一样 = 什么都不变 */
export function syncClaudeReadiness(db: Database): void {
  const mine = cachedClaudeReadiness();
  if (mine) publishClaudeReadiness(db, mine);
  const theirs = sharedClaudeReadiness(db);
  if (theirs && (!mine || theirs.at > mine.at)) noteClaudeReadiness(theirs);
}

/** 限时探测：到点就给「核对超时」（记成不可用）；真跑的 auth status 再晚 1 秒被强杀，卡住的子进程拖不住进程退出 */
export function probeWithin(ms: number, probe = () => probeClaudeLend({ status: () => claudeAuthStatus(process.env, ms + 1000), quota: claudeQuota })): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((done) => { timer = setTimeout(() => done(CLAUDE_REASONS.timeout), ms); });
  return Promise.race([probe(), late]).finally(() => clearTimeout(timer));
}

/** 对齐 meta；wanted 时结论不新鲜就当场探一次，探完先写回 meta 再返回（调用方随后才用它） */
async function settle(db: Database, wanted: boolean, o: InboxClaude): Promise<void> {
  claudeReadinessManual();
  syncClaudeReadiness(db);
  if (!wanted) return;
  await freshClaudeReadiness(Date.now(), () => probeWithin(o.budgetMs ?? CLAUDE_PROBE_MS, o.probe)); // 结论的 at 都按 Date.now() 记，新鲜度也按它算
  syncClaudeReadiness(db);
}

/** 常驻出借循环每轮在组 hello / 判容量之前调：本轮 hello、poll 容量、轮询收单、领单用的都是写进 meta 的那一份。没有 Claude 授权就不探 */
export const loopClaudeReadiness = (db: Database, lend: readonly LendEntry[], probe?: () => Promise<string | null>): Promise<void> =>
  settle(db, lend.some((e) => (e.families.claude ?? 0) > 0), { probe });

/**
 * 推送收单进程在收单闸之前把 Claude 结论定下来。这批没有 Claude 单、出借方停摆（反正整批 lender_idle）、调用方指纹对不上、
 * 授权里没有 Claude 位，都不探、不加延迟（这时也不写 meta）。
 * 授权在这里只是「值不值得探」的预判，真正的判定仍在 admitOrders 重读 lend.json 之后做。
 */
export async function primeInboxClaude(d: Pick<LendDeps, "db" | "now" | "readLend" | "context" | "writeOpen">, caller: { peer: string; fp: string | null },
  orders: readonly { family: string }[], opts: InboxClaude = {}): Promise<void> {
  claudeReadinessManual();
  if (!orders.some((o) => o.family === "claude") || caller.fp === null) return;
  if (d.now() - Number(getMeta(d.db, TICK_KEY) ?? 0) > LENDER_IDLE_MS) return;
  const g = await liveGrant(caller, d);
  if (!g.ok || g.entry.fp !== caller.fp || !(g.entry.families.claude ?? 0)) return;
  await settle(d.db, true, opts);
}
