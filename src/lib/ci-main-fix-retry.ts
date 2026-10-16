/**
 * merge-arch-CIUNREL1 item 3 · retry once after main fixed a test the PR never touched. Shared, read-only pieces:
 * - the registration (op ci_wait_main_fix, written by ci-main-fix-retry-decision.ts when CIF2 refused only because main had not
 *   changed the failing test files yet) and when it still stands;
 * - the sentence the fix order gets (bounceWork, scheduler-merge-conflict.ts): a peer PR card is retried by the scheduler, a local
 *   card's author merges origin/main and delivers again — in both cases no code change for this red;
 * - judge(): whether the tick (ci-main-fix-retry-tick.ts) may retry a registration now.
 * Switch ciMainFixRetry (new key, default on by OBSGATE1): off = no registration, no retry (the path as it was); observe = registration
 * + a "would retry" sample, never update-branch; on = the same, and for a peer PR card one update-branch pinned to the registered
 * head (expected_head_sha), after which PEERHEAD1 takes the new head. Duplicates are prevented by that head binding: once the PR head
 * differs from the registered one the registration is spent or void (the author pushed). 24 hours old = skipped, nothing written.
 * docs/architecture/ci-main-fix-retry.md; tests/ci-main-fix-retry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeRun } from "./scheduler-merge.js";

export const CI_MAIN_FIX_RETRY_KEY = "ciMainFixRetry";
export const WAIT_OP = "ci_wait_main_fix";
/** A registration nothing triggered within this is skipped (read-only: no expiry note). */
export const WAIT_TTL_MS = 24 * 60 * 60_000;
const OBSERVE_OP = "recovery_observe";
/** A peer PR card (another instance's author, PEERHEAD1's cards): peer-pr-ledger.ts peerPrOf's own test, without importing it. */
export const isPeerPrCard = (task: Pick<LedgerTask, "assigneeKind"> & { extra?: Record<string, unknown> | null }): boolean =>
  task.assigneeKind === "peer_agent" && !!task.extra?.peerPr && typeof task.extra.peerPr === "object";

let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Tests inject a fake policy; null restores the file-backed one. */
export function configureRetryPolicy(port: RecoveryPolicyPort | null): void { policyPort = port ?? recoveryPolicy; }

/** Read right before each use; unreadable = off (the path as it was). */
export function retryMode(project: string, policy: RecoveryPolicyPort = policyPort): RecoveryMode {
  try {
    return policy(project, CI_MAIN_FIX_RETRY_KEY).mode;
  } catch (e) {
    console.error(`⚠️ [merge] ${project} 读恢复策略 ${CI_MAIN_FIX_RETRY_KEY} 失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

export const sameFiles = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((f, i) => f === [...b].sort()[i]);

/** The retry sample's action key: one per registration (card + head + run). */
export const retryActionKey = (reg: Pick<Registration, "prHead" | "runId">): string => `retry:${reg.prHead}:${reg.runId}`;

const json = (raw: unknown): Record<string, unknown> => {
  try { return typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
};
/** File sets this card was already retried for (an executed retry sample): such a set is not registered again. */
export function retriedFiles(db: Database, taskId: string): string[][] {
  const rows = db.query(`SELECT data FROM events WHERE target=? AND kind='note' AND json_extract(data,'$.op')=? AND json_extract(data,'$.mechanism')=?`)
    .all(taskId, OBSERVE_OP, CI_MAIN_FIX_RETRY_KEY) as { data: string }[];
  return rows.map((r) => json(r.data)).filter((d) => d.executed === true && Array.isArray(d.files)).map((d) => d.files as string[]);
}
/** Whether this registration already has its retry sample (observe: "would retry" written; on: retried). */
export const retrySampled = (db: Database, taskId: string, reg: Registration): boolean => !!db.query(`SELECT 1 FROM events WHERE target=? AND kind='note'
  AND json_extract(data,'$.op')=? AND json_extract(data,'$.mechanism')=? AND json_extract(data,'$.actionKey')=? LIMIT 1`)
  .get(taskId, OBSERVE_OP, CI_MAIN_FIX_RETRY_KEY, retryActionKey(reg));

export interface Registration { seq: number; ts: number; taskId: string; project: string; pr: string; prHead: string; run: string; runId: string;
  files: string[]; mainHead: string; peer: boolean; mode: string }
const SHA = /^[a-f0-9]{40}$/;
const RUN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/(\d+)$/;

/** The scheduler's own registration, complete; anything else is none. */
function registrationOf(e: Pick<LedgerEvent, "seq" | "ts" | "kind" | "actor" | "project" | "target" | "data">): Registration | null {
  const d = e.data;
  if (e.kind !== "note" || e.actor !== "scheduler" || d.op !== WAIT_OP) return null;
  const run = typeof d.run === "string" ? RUN.exec(d.run) : null;
  if (!run || typeof d.pr !== "string" || typeof d.prHead !== "string" || !SHA.test(d.prHead) || typeof d.mainHead !== "string" || !SHA.test(d.mainHead) ||
    !Array.isArray(d.files) || !d.files.length || !d.files.every((f) => typeof f === "string" && f)) return null;
  return { seq: e.seq, ts: e.ts, taskId: e.target, project: e.project, pr: d.pr, prHead: d.prHead, run: d.run as string, runId: run[1]!,
    files: d.files as string[], mainHead: d.mainHead, peer: d.peer === true, mode: typeof d.mode === "string" ? d.mode : "" };
}

/** Each card's newest registration younger than WAIT_TTL_MS in these projects (an older one is skipped, nothing written). */
export function liveRegistrations(db: Database, projects: readonly string[], now: number): Registration[] {
  if (!projects.length) return [];
  const rows = db.query(`SELECT seq, ts, kind, actor, project, target, data FROM events WHERE kind='note' AND actor='scheduler'
    AND json_extract(data,'$.op')=? AND ts > ? AND project IN (${projects.map(() => "?").join(",")}) ORDER BY seq`)
    .all(WAIT_OP, now - WAIT_TTL_MS, ...projects) as { seq: number; ts: number; kind: string; actor: string; project: string; target: string; data: string }[];
  const latest = new Map<string, Registration>();
  for (const r of rows) {
    const reg = registrationOf({ ...r, kind: r.kind as LedgerEvent["kind"], data: json(r.data) });
    if (reg) latest.set(reg.taskId, reg);
  }
  return [...latest.values()];
}

/** The ledger facts of judge(); GitHub facts are read only after these pass. */
export type LedgerVerdict = { ok: true } | { ok: false; why: string };
export function ledgerJudge(task: Pick<LedgerTask, "stage" | "headSHA"> | null, reg: Registration, block: string | null, sampled: boolean): LedgerVerdict {
  if (!task) return { ok: false, why: "卡不存在" };
  if (task.stage !== "fix") return { ok: false, why: `卡在 ${task.stage}，不在 fix` };
  if ((task.headSHA ?? "").toLowerCase() !== reg.prHead) return { ok: false, why: "台账 head 已变，登记作废" };
  if (block) return { ok: false, why: block };
  if (sampled) return { ok: false, why: "这条登记已重试过（或已记过本会重试）" };
  return { ok: true };
}

/** What the tick does with a registration whose ledger facts passed, given GitHub's PR head and main's commits on the failing files. */
export type RetryPlan = { kind: "void"; why: string } | { kind: "wait" } | { kind: "update"; commits: Record<string, string[]> } | { kind: "sample"; commits: Record<string, string[]> };
export function retryPlan(reg: Registration, mode: RecoveryMode, peer: boolean, prHead: string, fixes: Record<string, string[]>): RetryPlan {
  if (prHead.toLowerCase() !== reg.prHead) return { kind: "void", why: "PR head 已不是登记的 head（已重试过，或作者推了新提交）" };
  if (!Object.values(fixes).some((c) => c.length)) return { kind: "wait" };
  return mode === "on" && peer ? { kind: "update", commits: fixes } : { kind: "sample", commits: fixes };
}

const PEER_LINE = "失败测试不在你的改动里，main 修好后系统会自动重试，你不用为这条改代码";
const LOCAL_LINE = "失败测试不在你的改动里，main 修好后 merge origin/main 重新交付即可，不用为这条改代码";
/** bounceWork's extra input line for a ci_fail bounce that registered a wait (markWaitMain); none otherwise. */
export const waitMainLine = (b: Pick<MergeBounce, "waitMain">): string[] => b.waitMain === "peer" ? [PEER_LINE] : b.waitMain === "local" ? [LOCAL_LINE] : [];

/**
 * closeMergeRun, right before a ci_fail bounce goes to fix: the registration this run's red just wrote (same card + head) marks the
 * bounce, so the fix order says the red is not the author's. Only a peer card under on is told the scheduler retries itself.
 */
export function markWaitMain(db: Database, row: MergeRun, b: MergeBounce): void {
  if (b.cause !== "ci_fail") return;
  const r = db.query(`SELECT data FROM events WHERE target=? AND kind='note' AND actor='scheduler' AND json_extract(data,'$.op')=?
    AND json_extract(data,'$.prHead')=? ORDER BY seq DESC LIMIT 1`).get(row.taskId, WAIT_OP, b.prHead.toLowerCase()) as { data: string } | null;
  if (!r) return;
  const d = json(r.data);
  b.waitMain = d.peer === true && d.mode === "on" ? "peer" : "local";
}
