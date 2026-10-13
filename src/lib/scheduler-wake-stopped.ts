/**
 * dispatch-recovery-WAKESTOP1: the lifecycle stops idle workers to free memory (status "stopped", agent-kill.ts) while the
 * ledger binding stays active with the same session id; the bridge then refuses the frame as "not in registry" and the
 * scheduler re-sends to the same stopped worker forever. Right before sendVia's frame, a stopped binding is woken through
 * `manager resume <agent> <sessionId> <cwd>` under the recovery key wakeStopped:
 * - off: as before. observe: no resume, one recordObserved note per card and (agent, sessionId). on: resume, then the frame.
 * Only a tmux worker whose registry row is stopped, carries the bound session and has a cwd is woken; ACP has its own launch.
 * resume names the row's runtime and tmux explicitly: manager resume picks its adapter from --runtime (default Claude Code) and
 * would migrate a tmux worker to ACP by default, so without them a stopped Codex worker would be "resumed" by the wrong runtime.
 * A failed / timed-out resume refuses the frame as not delivered (receipt names the reason); WAKE_GIVE_UP_AFTER consecutive
 * failures on the same binding make wakeGaveUp answer manual, so the tick's existing manual + PM notice path takes it.
 * tests/scheduler-wake-stopped*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryDecision, type RecoveryPolicyPort } from "./recovery-policy.js";
import { agentRuntime, type RegistryAgent } from "./registry.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
const WAKE_STOPPED_KEY = "wakeStopped" as const;
export const WAKE_FAILED = "绑定 worker 已停止，唤醒失败";
const WAKE_GIVE_UP_AFTER = 3;
const WAKE_TIMEOUT_MS = 180_000;

export interface WakeStoppedDeps {
  db: Database;
  /** The service's plain manager (not the ledger identity): only `resume` is called. */
  manager: Manager;
  /** Tests only: policy reader (default recovery-policy.json) / clock / resume deadline. */
  policy?: RecoveryPolicyPort;
  now?: () => number;
  timeoutMs?: number;
}

/** A row the scheduler may wake: stopped, still on the bound session, not ACP, with a directory to resume in. */
const wakeable = (row: RegistryAgent | undefined, sessionId: string): row is RegistryAgent & { cwd: string } =>
  !!row && row.status === "stopped" && row.sessionId === sessionId && row.transport !== "acp" && !!row.cwd;

/** Stopped tmux worker on the bound session: the refusal says so instead of the bridge's misleading "not in registry". */
export const isStoppedBinding = (row: RegistryAgent | undefined, sessionId: string): boolean =>
  !!row && row.status === "stopped" && row.sessionId === sessionId && row.transport !== "acp";
export const stoppedRefusal = (agent: string): string => `绑定 worker ${agent} 已停止（registry status=stopped），bridge 没有投递`;

const oneLine = (s: string, max = 300): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const binding = (agent: string, sessionId: string): string => `${agent}/${sessionId}`;
/**
 * observe dedup key for one binding: recordObserved only takes 1..120 ASCII [\w.:@/-], while agent names may be Unicode
 * (e.g. Chinese) and session ids are free-form, so the pair is hashed; the readable names stay in action / data.
 */
const observeKey = (agent: string, sessionId: string): string =>
  `wake:${createHash("sha256").update(JSON.stringify([agent, sessionId]), "utf8").digest("hex").slice(0, 32)}`;

function decide(d: WakeStoppedDeps, project: string): RecoveryDecision {
  return decideRecovery((d.policy ?? recoveryPolicy)(project, WAKE_STOPPED_KEY));
}

/** The order's project, via its intent (sendVia's key is the intent id). null = not a ledger order: nothing to decide on. */
function projectOfIntent(db: Database, intentId: string): { project: string; taskId: string } | null {
  const intent = getIntent(db, intentId);
  const task = intent ? getTask(db, intent.taskId) : null;
  return task ? { project: task.project, taskId: task.id } : null;
}

/** `manager resume` argv for a wakeable row: the bound runtime and the tmux transport it was stopped on, never the CLI defaults. */
const resumeArgs = (row: RegistryAgent & { cwd: string }, sessionId: string): string[] =>
  ["resume", row.name, sessionId, row.cwd, "--runtime", agentRuntime(row), "--transport", "tmux"];

async function resume(d: WakeStoppedDeps, row: RegistryAgent & { cwd: string }, sessionId: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = d.timeoutMs ?? WAKE_TIMEOUT_MS;
  const timeout = new Promise<string>((res) => { timer = setTimeout(() => res(`resume 超过 ${Math.round(deadline / 1000)}s 没返回`), deadline); });
  try {
    const call = d.manager(...resumeArgs(row, sessionId))
      .catch((e: unknown): Record<string, unknown> => ({ ok: false, error: (e as Error)?.message ?? String(e) }));
    const r = await Promise.race([call, timeout]);
    if (typeof r === "string") return r;
    if (r.ok !== true) return `resume 失败：${oneLine(String(r.error ?? "manager 没说原因"), 160)}`;
    return r.ready === false ? "resume 返回了但会话没就绪（ready=false）" : null;
  } finally { clearTimeout(timer); }
}

export type WakeOutcome = { send: true } | { send: false; reason: string };

/**
 * Called by sendVia before the frame. Anything that is not a wakeable stopped binding, or whose policy is off, is passed
 * through unchanged. observe records once and passes through; on resumes and passes only when resume answered ready.
 */
export async function wakeBeforeSend(d: WakeStoppedDeps, row: RegistryAgent | undefined, sessionId: string, intentId: string,
  stillActive: () => boolean): Promise<WakeOutcome> {
  if (!wakeable(row, sessionId)) return { send: true };
  const order = projectOfIntent(d.db, intentId);
  if (!order) return { send: true };
  const decision = decide(d, order.project);
  if (decision.kind === "skip") return { send: true };
  if (decision.kind === "observe") {
    try {
      recordObserved(d.db, { project: order.project, mechanism: WAKE_STOPPED_KEY, target: order.taskId, actionKey: observeKey(row.name, sessionId),
        action: `resume 已停止的绑定 worker ${binding(row.name, sessionId)}（${row.cwd}）后再派单`, data: { agent: row.name, sessionId, intentId } }, (d.now ?? Date.now)());
    } catch (e) { console.error(`⚠️ [scheduler] wakeStopped 观察没记上：${(e as Error).message}`); }
    return { send: true };
  }
  if (!stillActive()) return { send: false, reason: `绑定 worker ${row.name} 已停止；调度器已不在岗，没有唤醒` };
  const failed = await resume(d, row, sessionId);
  return failed ? { send: false, reason: `${WAKE_FAILED}：${failed}（${binding(row.name, sessionId)}）` } : { send: true };
}

/**
 * The tick's worker gate: under on, a binding still stopped whose last WAKE_GIVE_UP_AFTER orders on this card were all refused
 * (the open one being dispatched not counted) for a failed wake goes to PM (manual) instead of spinning on backoff. A worker brought back by hand is no longer stopped,
 * so the old failures stop counting.
 */
export function wakeGaveUp(d: Pick<WakeStoppedDeps, "db" | "policy">, ref: { taskId: string; agent: string; sessionId: string },
  row: RegistryAgent | undefined): { manual: string } | null {
  if (!wakeable(row, ref.sessionId)) return null;
  const task = getTask(d.db, ref.taskId);
  if (!task || decide(d as WakeStoppedDeps, task.project).kind !== "act") return null;
  const recent = d.db.query(`SELECT status, receipt FROM scheduler_intents WHERE taskId = ? AND action IN ('dispatch','review')
    AND status NOT IN ('pending','submitted') ORDER BY eventSeq DESC LIMIT ?`).all(ref.taskId, WAKE_GIVE_UP_AFTER) as { status: string; receipt: string | null }[];
  const mark = binding(ref.agent, ref.sessionId);
  const failed = (i: { status: string; receipt: string | null }) => i.status === "cancelled" && !!i.receipt?.includes(WAKE_FAILED) && i.receipt.includes(mark);
  if (recent.length < WAKE_GIVE_UP_AFTER || !recent.every(failed)) return null;
  return { manual: `${WAKE_FAILED}，连续 ${WAKE_GIVE_UP_AFTER} 次（${mark}），不再空转，交 PM：${oneLine(recent[0].receipt ?? "", 200)}` };
}
