/**
 * VERIFYBIND1 · peerPrVerifyBind (permission, default observe): the peer PR verify gate binds the exact key and retries back off.
 * - Gate: a formal scheduler verify of a peer card needs exactly its current peerPrVerifyKey (intake / delivery / live / specRev /
 *   head) and peerPrAutoVerify still on, rechecked inside recordVerify's transaction; no key, a forged or stale key never borrows
 *   the deploy branch. `--dry-run` goes through schedulerCanDryRunVerify, never "no key".
 * - Retry: attempts per binding key wait 10, 20, 40, 80 minutes, at most five; 160 minutes after the fifth one PM todo, then
 *   nothing. The count lives in the ledger's attempt notes (a restart keeps it); a new head / live episode is a new key.
 * on: the above. observe: the old verdicts stand; only a refusal or a back-off the old rules would not make is recorded, once.
 * off: the old behaviour. peerPrAutoVerify's own mode is never changed here. tests/peer-pr-verify-bind.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getTask } from "./ledger-store.js";
import { setSchedulerVerifyGate } from "./ledger-write.js";
import { recordPmTodo } from "./pm-todo-note.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { peerPrVerifyKey, schedulerCanDryRunVerify, schedulerCanVerify } from "./scheduler-verify-gate.js";

const VERIFY_BIND_KEY = "peerPrVerifyBind" as const;
export const ATTEMPT_OP = "peer_pr_verify_attempt";
const MIN = 60_000;
/** Wait after the n-th attempt; the last entry is the wait after the fifth before the PM todo. */
export const BACKOFF_MS = [10, 20, 40, 80, 160].map((m) => m * MIN);
export const MAX_ATTEMPTS = 5;
const LEGACY_RETRY_MS = 10 * MIN;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Read right before each use; a read that throws answers off (the baseline). */
function verifyBindMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    const m = policy(project, VERIFY_BIND_KEY).mode;
    return m === "on" || m === "observe" ? m : "off";
  } catch {
    return "off";
  }
}

/**
 * The scheduler's verify permission under the bind mode. dryRun never writes. Under observe the baseline answer stands; with
 * `record` (only the recheck inside recordVerify's transaction, so a run that writes nothing stays write-free) a refusal strict
 * binding would make is recorded once.
 */
export function schedulerVerifyAllowed(db: Database, taskId: string, dedupKey: string | undefined,
  opts: { dryRun?: boolean; record?: boolean; now: number; policy?: RecoveryPolicyPort }): boolean {
  const t = getTask(db, taskId);
  const mode = t ? verifyBindMode(t.project, opts.policy) : "off";
  if (opts.dryRun) return mode === "on" ? schedulerCanDryRunVerify(db, taskId, dedupKey) : schedulerCanVerify(db, taskId, dedupKey);
  const baseline = schedulerCanVerify(db, taskId, dedupKey);
  if (!t || mode === "off") return baseline;
  const autoVerifyOn = (opts.policy ?? recoveryPolicy)(t.project, "peerPrAutoVerify").mode === "on";
  const strict = schedulerCanVerify(db, taskId, dedupKey, { autoVerifyOn });
  if (mode === "on") return strict;
  if (baseline && !strict && opts.record) {
    const current = peerPrVerifyKey(db, taskId);
    const why = !current ? "lineage" : dedupKey === undefined ? "no_key" : dedupKey !== current ? "stale_key" : "auto_verify_off";
    recordObserved(db, { project: t.project, mechanism: "peerPrVerifyBind", target: taskId,
      actionKey: `refuse:${why}:${hash(JSON.stringify([dedupKey ?? null, current])).slice(0, 16)}`,
      action: "拒绝不带当前绑定键（或 peerPrAutoVerify 不是 on）的 peer PR 正式核对", data: { why, head: t.headSHA } }, opts.now);
  }
  return baseline;
}

// recordVerify's own transactional recheck: the writer enforces the bind mode whoever calls it
setSchedulerVerifyGate((db, taskId, dedupKey, now) => schedulerVerifyAllowed(db, taskId, dedupKey, { record: true, now }));

type Attempts = { count: number; last: number | null; anyLast: number | null };
function attempts(db: Database, project: string, taskId: string, key: string): Attempts {
  const r = db.query(`SELECT COUNT(CASE WHEN json_extract(data,'$.key')=?2 THEN 1 END) AS count,
      MAX(CASE WHEN json_extract(data,'$.key')=?2 THEN ts END) AS last, MAX(ts) AS anyLast
    FROM events WHERE project=?1 AND target=?3 AND kind='note' AND actor='scheduler' AND json_extract(data,'$.op')=?4`)
    .get(project, key, taskId, ATTEMPT_OP) as Attempts;
  return r;
}

export type RetryDecision = { go: false } | { go: true; dedupKey: string };

/**
 * Called inside the auto-verify claim transaction once peerPrAutoVerify is on. go: write the attempt note with the returned
 * dedup key (the attempt number under on, so concurrent claims of one attempt collapse to one event).
 */
export function decideRetry(db: Database, t: { id: string; project: string; headSHA: string | null }, key: string,
  now: number, policy?: RecoveryPolicyPort): RetryDecision {
  const mode = verifyBindMode(t.project, policy);
  const a = attempts(db, t.project, t.id, key), h = hash(key);
  const baseline: RetryDecision = a.anyLast !== null && now - a.anyLast < LEGACY_RETRY_MS ? { go: false }
    : { go: true, dedupKey: `peer-pr-verify-attempt:${h}:${now}` };
  if (mode === "off") return baseline;
  const exhausted = a.count >= MAX_ATTEMPTS;
  const waiting = a.last !== null && now - a.last < BACKOFF_MS[Math.min(a.count, MAX_ATTEMPTS) - 1]!;
  if (mode === "observe") {
    if (baseline.go && (exhausted || waiting)) {
      recordObserved(db, { project: t.project, mechanism: "peerPrVerifyBind", target: t.id,
        actionKey: exhausted ? `exhausted:${h.slice(0, 16)}` : `backoff:${h.slice(0, 16)}:${a.count}`,
        action: exhausted ? `已试 ${MAX_ATTEMPTS} 次，停止自动核对并转 PM 待办` : `第 ${a.count} 次核对后退避，暂不再试`,
        data: { attempts: a.count, head: t.headSHA } }, now);
    }
    return baseline;
  }
  if (waiting) return { go: false };
  if (exhausted) {
    recordPmTodo(db, { actor: "scheduler", now }, { project: t.project, target: t.id, kind: "peer_pr_verify_exhausted",
      text: `peer PR 卡 ${t.id}（head ${t.headSHA ?? "?"}）自动上线核对已试 ${MAX_ATTEMPTS} 次仍未通过，停止自动重试：请人工 ledger verify 或处理`,
      dedupKey: `peer-pr-verify-exhausted:${h}` });
    return { go: false };
  }
  return { go: true, dedupKey: `peer-pr-verify-attempt:${h}:${a.count + 1}` };
}
