/**
 * 出借 worker 的健康判定（i28-R5a）：lend-drive 对 started 的单每轮调一次，这里只做判定与 journal meta 记账，停 worker 由 lend-drive 执行。
 * - 存活：一次否定只记下（meta `alive:<orderId>`，带 agent / session / leaseGen，重启不丢），隔 ≥ MISS_GAP_MS 的下一轮、同一身份仍否定才判死；
 *   running / unknown 清零，身份变了按第一次算。
 *   一次读失败曾让正在审查的 worker 被当成「窗口没了」杀掉（ledger/reviews/i28-R5a-rootcause.md），所以单次否定不算数。
 * - 回合失败（内容策略 / 请求被拒 / 上下文耗尽）：认 bridge 开的、属于本单当前回合的回合失败卡（lend-turn-failure.ts），同额度 / 登录一样停单，不暂停借单。
 * - 撞额度 / 登录失败：认 bridge 为这个 worker 开的 Codex 运行时卡（scheduler-auto-ports codexFailure 同一信号）；撞额度的同时
 *   本机暂停借单（meta `pause:codex`），启动失败也认报错中的重置时刻，均读不到就 PAUSE_FALLBACK_MS；之后观测到每个窗口都明确不满才提前恢复。
 * tests/lend-health.test.ts、tests/lend-loop.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { InventoryQuota } from "./ai-quota.js";
import { getMeta, setMeta, type LendRow } from "./lend-journal.js";
import type { WorkerLiveness } from "./worker-liveness.js";
import { classifyAirFailure } from "./acp/failures.js";
import { lendQuotaResetAt } from "./lend-quota-reset.js";
import { isCyberPolicy } from "./agent-supervisor-policy.js";

export type WorkerDown = "no_window" | "no_host";
export const MISS_GAP_MS = 5_000;
export const PAUSE_FALLBACK_MS = 3600_000;

/** 两种判死各一句（journal reason 与 A 侧 release detail 都用它） */
export const DOWN_REASON: Record<WorkerDown, string> = {
  no_window: "worker 窗口不在了（连续两次探测），没交结论",
  no_host: "worker 窗口还在，但 ACP 宿主已经退出（连续两次探测），没交结论",
};
const LABEL: Record<WorkerDown, string> = { no_window: "窗口不在", no_host: "窗口在、宿主不在" };

const aliveKey = (orderId: string) => `alive:${orderId}`;

function readJson<T>(db: Database, key: string): T | null {
  const v = getMeta(db, key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; /* 坏值按没有：最坏多等一轮 / 少暂停一次，不会误判死 */ }
}

interface Miss { at: number; kind: WorkerDown; agent: string | null; sessionId: string | null; leaseGen: number | null }

/** 记一次存活探测；返回确认判死的种类（同一身份连续第二次否定），否则 null。每次否定、每次判死都打一行日志 */
export function noteLiveness(db: Database, row: LendRow, v: WorkerLiveness, now: number, log: (m: string) => void): WorkerDown | null {
  const key = aliveKey(row.orderId);
  const id = { agent: row.agent ?? null, sessionId: row.sessionId ?? null, leaseGen: row.leaseGen ?? null };
  const last = readJson<Miss>(db, key);
  // 上次否定记的是别的 worker / 会话 / 租约代：不是同一个东西的第二次，按第一次算（i28-R5a r1 P2-1）
  const prev = last && last.agent === id.agent && last.sessionId === id.sessionId && last.leaseGen === id.leaseGen ? last : null;
  const who = `agent ${id.agent ?? "?"}，session ${id.sessionId ?? "?"}，gen ${id.leaseGen}`;
  if (v === "running" || v === "unknown") {
    if (last) setMeta(db, key, ""), log(`${row.orderId} 存活探测恢复（${v === "running" ? "宿主在" : "读不到，按不知道"}），清掉上次的否定（${who}）`);
    return null;
  }
  if (!prev) {
    setMeta(db, key, JSON.stringify({ at: now, kind: v, ...id } satisfies Miss));
    log(`${row.orderId} 存活探测否定 1/2：${LABEL[v]}，下一轮再看（${who}）`);
    return null;
  }
  if (now - prev.at < MISS_GAP_MS) return null; // 同一轮连着问两次不算两次
  setMeta(db, key, "");
  log(`${row.orderId} 存活探测否定 2/2：${LABEL[v]}，判定 worker 已停（${who}）`);
  return v;
}

export interface CodexFailureSeen { kind: "quota" | "auth"; askId: string; message: string }
/** 加上回合失败卡（bridge/acp-link.ts，extra.failure = error）：回合已停、不会自己续跑，停单交回 A */
export type LendWorkerFailure = CodexFailureSeen | { kind: "error"; askId: string; message: string };

/**
 * journal reason 与给 A 的 release detail 都用它。回合失败写明 B 不重试，由 A 决定撤单还是重派；只给固定类别，
 * 不带原文：提供方的报错可能带本机路径 / 凭据，detailOf 只截长度不脱敏（原文只进本机证据，lend-drive keepEvidence）
 */
export function failureReason(f: LendWorkerFailure, note?: string): string {
  if (f.kind === "error") {
    const why = isCyberPolicy(f.message) ? "内容策略拦截" : "回合出错，如请求被拒 / 上下文耗尽";
    return `worker 回合失败（${why}；出借方不自动重试、不换家族${note ? `；${note}` : ""}），没交结论；报错原文只留在出借方本机`;
  }
  return f.kind === "quota" ? `worker 撞了 Codex 额度，没交结论：${f.message}` : `worker 的 Codex 没登录或登录失效，没交结论：${f.message}`;
}

/** Codex 额度此刻的样子：full = 有窗口用满且没过重置时刻；false = 每个窗口都明确没满；null = 不知道 */
export interface QuotaView { observedAt: number | null; full: boolean | null; resetsAt: number | null }

/**
 * 顶层 known 只说明至少一个窗口有数（ai-quota fromEntry），别的窗口可能没数。没数的窗口可能正是挡住我们的那个，
 * 所以没有已知满窗时，只要有窗口没数（且没过重置时刻）就给 null，不能当成「不满」提前恢复借单（i28-R5a r1 P1-2）。
 */
export function quotaViewOf(q: InventoryQuota): QuotaView {
  if (q.status !== "known" || !q.windows.length) return { observedAt: q.observedAt, full: null, resetsAt: null };
  const full = q.windows.filter((w) => w.usedPct !== null && w.usedPct >= 100 && !w.resetPassed);
  const resets = full.map((w) => w.resetsAtMs).filter((t): t is number => t !== null);
  if (full.length) return { observedAt: q.observedAt, full: true, resetsAt: resets.length ? Math.max(...resets) : null };
  const unknown = q.windows.some((w) => w.usedPct === null && !w.resetPassed);
  return { observedAt: q.observedAt, full: unknown ? null : false, resetsAt: null };
}

interface Pause { at: number; until: number; orderId: string }
const PAUSE_KEY = "pause:codex";

/** 本机 worker 撞了 Codex 额度：暂停借单到重置时刻（读不到就按兜底时长） */
export function pauseForQuota(db: Database, orderId: string, q: QuotaView | null, now: number, log: (m: string) => void): void {
  const until = q?.full && q.resetsAt !== null && q.resetsAt > now ? q.resetsAt : now + PAUSE_FALLBACK_MS;
  setMeta(db, PAUSE_KEY, JSON.stringify({ at: now, until, orderId } satisfies Pause));
  log(`${orderId} 撞 Codex 额度：本机暂停借单到 ${new Date(until).toISOString()}${q?.resetsAt ? "（额度重置时刻）" : "（读不到重置时刻，按兜底时长）"}`);
}

/** 暂停中的截止时刻；没有暂停 / 已过期 = null（只读，恢复的记账在 refreshPause） */
export function pausedUntil(db: Database, now: number): number | null {
  const p = readJson<Pause>(db, PAUSE_KEY);
  return p && now < p.until ? p.until : null;
}

/** create 只保留错误正文：借用 ACP 的正文判定，普通失败不能冻结整个 Codex 家族。 */
export async function pauseForStartFailure(db: Database, row: LendRow, error: string,
  quota: () => Promise<QuotaView | null>, now: number, log: (m: string) => void): Promise<void> {
  if (row.family !== "codex") return;
  // retry 阻止 AIR 的无动作 limit 兜底，只让已有 usage-limit 正文规则认额度。
  const limit = classifyAirFailure({ id: row.orderId, revision: 1, category: "limit", severity: "error", title: error, actions: ["retry"] });
  if (limit.kind !== "quota") return;
  const q = await quota().catch((e) => { log(`起 worker 失败后读 Codex 额度失败，按报错判断暂停：${String(e)}`); return null; });
  const reset = q?.resetsAt != null && q.resetsAt > now ? null : lendQuotaResetAt(error, now);
  pauseForQuota(db, row.orderId, reset === null ? q : { observedAt: now, full: true, resetsAt: reset }, now, log);
}

/** 领单前先处理旧暂停，再看明确已满的读数；保留旧截止，避免未知重置时每轮延长兜底。 */
export async function refreshQuotaPause(db: Database, quota: () => Promise<QuotaView | null>, now: number,
  log: (m: string) => void): Promise<number | null> {
  const q = await quota().catch((e) => { log(`领单前读 Codex 额度失败，按未知处理：${String(e)}`); return null; });
  const until = await refreshPause(db, async () => q, now, log);
  if (until === null && q?.full === true && (q.resetsAt === null || q.resetsAt > now)) pauseForQuota(db, "quota_observation", q, now, log);
  return pausedUntil(db, now);
}

/** 每轮开头：到点了，或暂停之后又观测到额度不满，就解除暂停 */
async function refreshPause(db: Database, quota: () => Promise<QuotaView | null>, now: number, log: (m: string) => void): Promise<number | null> {
  const p = readJson<Pause>(db, PAUSE_KEY);
  if (!p) return null;
  if (now >= p.until) return setMeta(db, PAUSE_KEY, ""), log("Codex 额度暂停到点，恢复借单"), null;
  const q = await quota().catch(() => null);
  if (q && q.full === false && q.observedAt !== null && q.observedAt > p.at) return setMeta(db, PAUSE_KEY, ""), log("观测到 Codex 额度已不满，恢复借单"), null;
  return p.until;
}
