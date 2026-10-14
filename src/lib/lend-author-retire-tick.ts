/** Candidate-only preflight before planning; query_only service reads, leased writer commits. */
import { createHash } from "node:crypto";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { lendAuthorBasis, lendAuthorFence, proveLendAuthorRetire } from "./lend-author-retire-proof.js";
import { readLendAuthorHead, sampleLendAuthor, type ReadLendHead } from "./lend-author-retire-read.js";
import { lendAuthorAction } from "./lend-author-retire-write.js";
import { whileOwned, SchedulerStopped } from "./scheduler-maintenance.js";
import type { LocalAuthorEnv } from "./scheduler-local-author.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";

export interface LendAuthorDeps { policy?: RecoveryPolicyPort; readHead?: ReadLendHead; now?: () => number; timeoutMs?: number; start?: LocalStartOptions }
const attempts = new WeakMap<LocalAuthorEnv["db"], Map<string, number>>();
const WINDOW = 600_000;

async function prepare(env: LocalAuthorEnv, task: LedgerTask, deps: LendAuthorDeps = {}): Promise<LedgerTask> {
  if (task.stage !== "fix") return task;
  const wf = getWorkflow(env.db, task.id), s = getSchedulerSession(env.db, task.id, "author");
  if (wf?.mode !== "auto" || !s || s.transport !== "peer" || s.state === "retired" || env.registryRow(s.agent)) return task;
  const policy = (deps.policy ?? recoveryPolicy)(task.project, "lendAuthorRebuild");
  if (policy.mode === "off") return task;
  const f = { ...lendAuthorFence(task, s), basis: lendAuthorBasis(env.db, task.id), heads: [] }, proof = proveLendAuthorRetire(env.db, f, true);
  if (policy.mode === "observe") {
    if (proof.ok) {
      const a = lendAuthorAction(f);
      await whileOwned(env.active, () => env.ledger("ledger", "scheduler-recovery-observe", task.id, "--mechanism", a.mechanism,
        "--action-key", a.actionKey, "--action", a.action, "--data", JSON.stringify(a.data)));
    }
    return task;
  }
  const key = createHash("sha256").update(`${task.id}:${task.rev}:${s.sessionId}`).digest("hex");
  const now = (deps.now ?? Date.now)(), seen = attempts.get(env.db) ?? new Map<string, number>(); attempts.set(env.db, seen);
  const persisted = listEvents(env.db, { target: task.id }).findLast(e => e.data.op === "lend_author_blocked" &&
    e.data.sessionId === s.sessionId && e.data.rev === task.rev);
  if (now - (seen.get(key) ?? persisted?.ts ?? -Infinity) < WINDOW) return task;
  seen.set(key, now);
  const sample = proof.ok ? await whileOwned(env.active, () => sampleLendAuthor(env.db, task.id, deps.readHead ?? readLendAuthorHead, deps.policy, deps.timeoutMs)) : f;
  if (!sample) return task;
  await whileOwned(env.active, () => env.ledger("ledger", "scheduler-lend-author-retire", task.id, "--rev", String(sample.rev), "--spec-rev", String(sample.specRev),
      "--head", sample.head ?? "-", "--session", sample.sessionId, "--basis", sample.basis, "--heads", JSON.stringify(sample.heads)));
  return getTask(env.db, task.id) ?? task;
}

export async function prepareLendAuthor(env: LocalAuthorEnv, task: LedgerTask, deps: LendAuthorDeps = {}): Promise<LedgerTask> {
  try { return await prepare(env, task, deps); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.warn(`lend author prepare failed; preserve peer binding: ${(e as Error).message}`);
    return task;
  }
}
