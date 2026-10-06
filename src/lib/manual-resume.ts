/**
 * Controlled automatic recovery of manual cards (dispatch-recovery-MAN2). A manual card whose MAN1 reason is bound to a release node
 * that has really happened goes back to auto through the existing `ledger workflow-resume` only (resumeCore, its CAS, pool / intent
 * checks and event); this file adds no second writer. Liftable today: deps_not_live, released only when every predecessor is really
 * verified (code: verified, or done after verified; ops / investigate: done) — planned, CI green, merge, live, cancelled or a PM-pinned
 * edge state never count — and only for the nodes bound to the manual entry: its edges at entry (a removed one needs a new
 * authorization) and a custom `解除：` that names nothing but those ids; any other condition in it (an owner go-ahead, …) stays manual.
 * Safety refusals, owner / PM holds, questionnaires, materials and every other code stay with people.
 * Mode comes from CFG's one RecoveryPolicyPort (key manualStall): off = old behaviour, observe = one would-resume note per state
 * version (recordObserved), on = the scheduler identity runs the workflow-resume transaction with an authorization fingerprint, which
 * re-runs the whole check and the same port inside it (manualResumeGate) and refuses a drifted one; CAS + that re-check make two
 * passes or a restart resume once. In-process like ensureDeliverScope: the `ledger` CLI keeps workflow-resume PM-only for the
 * scheduler identity (shared-ledger-gate-cli-services.ts). tests/manual-resume*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask, LedgerError, listDeps, listEvents } from "./ledger-store.js";
import { manualEntry, manualReasonRecord, type ManualReasonCode, type ManualReasonRecord } from "./manual-reason.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSwitch, switchOff } from "./scheduler-autostart.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { strayPoolOrders } from "./scheduler-pool-facts.js";
import { openSafetyHold } from "./scheduler-review-swap.js";

/** Codes MAN2 may lift; anything else (sticky or without a provable release node) is never resumed automatically. */
const LIFTABLE: readonly ManualReasonCode[] = ["deps_not_live"];
const AUTH = /授权\s*([0-9a-f]{16})/;
const OBSERVE_OP = "recovery_observe";

export interface ManualResumeFacts {
  code: ManualReasonCode; entrySeq: number; deps: { id: string; stage: string }[];
  /** authorization: every fact the decision stood on; any drift (head, specRev, round, UI, reason, revs, new event) voids it */
  fingerprint: string;
}
export type ManualResumeVerdict = { ok: true; facts: ManualResumeFacts } | { ok: false; why: string };
const no = (why: string): ManualResumeVerdict => ({ ok: false, why });

const uiDigest = (t: LedgerTask): string | null => (typeof t.extra.screenshotsDigest === "string" ? t.extra.screenshotsDigest : null);

/** Really verified: a code predecessor must have reached verified (done alone may be a PM close); ops / investigate only have done. */
function reallyVerified(db: Database, t: LedgerTask): boolean {
  if (t.kind !== "code") return t.stage === "done";
  if (t.stage === "verified") return true;
  return t.stage === "done" && listEvents(db, { project: t.project, target: t.id }).some((e) => e.kind === "stage" && e.data.to === "verified");
}

/** The card's incoming edges as of the manual entry, replayed from its own dep events (add / set / rm, all targeted at the card). */
function edgesAtEntry(events: readonly LedgerEvent[], entrySeq: number): Map<string, string> {
  const edges = new Map<string, string>();
  for (const e of events) {
    if (e.seq >= entrySeq) break;
    if (e.kind !== "dep" || typeof e.data.from !== "string") continue;
    if (e.data.op === "rm") edges.delete(e.data.from);
    else if (e.data.op === "add" || e.data.op === "set") edges.set(e.data.from, String(e.data.kind));
  }
  return edges;
}

/** Task ids joined by 、/，/和/与/及/and, optionally followed by verified / 上线 and 后 — nothing else is a checkable release. */
const RELEASE_IDS = /^([A-Za-z0-9][\w.-]*(?:\s*(?:、|,|，|和|与|及|以及|and|&)\s*[A-Za-z0-9][\w.-]*)*)\s*(?:都|均|全部)?\s*(?:已|真实)?\s*(?:main\s*\/\s*verified|verified|上线)?\s*(?:后)?$/i;

/**
 * The release nodes the manual entry is bound to. The code's default release binds the entry's own blocks edges; a custom
 * `解除：…` must be nothing but entry-edge task ids (+ verified / 上线), else it carries a condition this file cannot check (an
 * owner go-ahead, a date, …) and stays with people.
 */
function releaseNodes(db: Database, task: LedgerTask, rec: ManualReasonRecord, atEntry: Map<string, string>):
  { ok: true; ids: string[] } | { ok: false; why: string } {
  const bound = [...atEntry.keys()];
  if (rec.release === manualReasonRecord(db, task, `${rec.code}: -`, []).release) return { ok: true, ids: bound };
  const m = RELEASE_IDS.exec(rec.release.trim());
  if (!m) return { ok: false, why: `自定义解除条件「${rec.release}」含无法结构化核验的条件，留人工` };
  const ids = m[1].split(/\s*(?:、|,|，|和|与|以及|及|and|&)\s*/i).filter(Boolean);
  const stray = ids.filter((id) => !atEntry.has(id));
  if (stray.length) return { ok: false, why: `解除条件点名的 ${stray.join("、")} 进 manual 时不是本卡前置，交 PM 核对` };
  return { ok: true, ids };
}

/**
 * Bound to the manual entry: every edge the card had at entry must still be there (a removed / replaced predecessor needs a new
 * authorization, it never shifts the old reason onto the rest), every release node it names must be really verified, and every
 * current incoming edge must be a blocks edge whose predecessor is really verified and whose effective state is not pinned back.
 */
function depsReleased(db: Database, task: LedgerTask, rec: ManualReasonRecord, events: readonly LedgerEvent[], entrySeq: number):
  { ok: true; deps: ManualResumeFacts["deps"] } | { ok: false; why: string } {
  const atEntry = edgesAtEntry(events, entrySeq);
  if (!atEntry.size) return { ok: false, why: "进 manual 时没有前置边（依赖理由却无依赖，交 PM 核对）" };
  const nodes = releaseNodes(db, task, rec, atEntry);
  if (!nodes.ok) return nodes;
  const edges = listDeps(db, task.project).filter((d) => d.to === task.id);
  const gone = [...atEntry.keys()].filter((id) => !edges.some((e) => e.from === id));
  if (gone.length) return { ok: false, why: `进 manual 时的前置 ${gone.join("、")} 已被删边 / 替换，旧理由不再授权，需 PM 重新授权` };
  for (const id of nodes.ids) {
    const n = getTask(db, id);
    if (!n || !reallyVerified(db, n)) return { ok: false, why: `解除节点 ${id} 在 ${n?.stage ?? "台账外"}，还没真实 main/verified` };
  }
  const deps: ManualResumeFacts["deps"] = [];
  for (const e of edges) {
    if (e.kind !== "blocks") return { ok: false, why: `${e.from} 是分叉边，走哪条由 PM 选` };
    if (e.state !== null && e.state !== "done") return { ok: false, why: `PM 把 ${e.from} 的依赖定为 ${e.state}` };
    const from = getTask(db, e.from);
    if (!from) return { ok: false, why: `前置 ${e.from} 不在台账` };
    if (!reallyVerified(db, from)) return { ok: false, why: `前置 ${e.from} 在 ${from.stage}，还没真实 main/verified` };
    deps.push({ id: from.id, stage: from.stage });
  }
  return { ok: true, deps };
}

/** Card-side refusals shared by every code: holds, waits, open orders and side effects whose outcome is not formally settled. */
function cardBlock(db: Database, task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number): string | null {
  const hold = openSafetyHold(events);
  if (hold) return `安全拒绝留证 #${hold.seq} 未处置`;
  if (getMeta(db, task.project).queueFrozen.frozen) return "项目合并队列冻结";
  const feature = task.featureId ? getFeature(db, task.featureId) : null;
  if (feature?.status === "paused") return `feature ${feature.id} 已暂停`;
  const sw = switchOff(readSwitch(db, task.project), task.featureId ?? null);
  if (sw) return sw;
  const asks = db.query("SELECT id FROM asks WHERE taskId = ? AND state = 'open'").all(task.id) as { id: string }[];
  if (asks.length) return `有未答的 ask（${asks.map((a) => a.id).join("、")}），不代答`;
  const intents = db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").all(task.id) as
    { id: string; status: string }[];
  if (intents.length) return `还有未结意图（${intents.map((i) => `${i.id}:${i.status}`).join("、")}）`;
  const merges = db.query("SELECT intentId, phase FROM scheduler_merges WHERE taskId = ? AND phase NOT IN ('merged','resolved')").all(task.id) as
    { intentId: string; phase: string }[];
  if (merges.length) return `合并未正式结清（${merges.map((m) => `${m.intentId}:${m.phase}`).join("、")}）`;
  const stray = strayPoolOrders(db, task.id);
  if (stray.length) return `池单还在外面（${stray.map((o) => o.orderId).join("、")}）`;
  const fake = events.find((e) => e.seq > entrySeq && e.kind === "review"
    && ((e.data.witness as { mismatch?: unknown[] } | undefined)?.mismatch?.length ?? 0) > 0);
  return fake ? `审查旁证对不上 #${fake.seq}` : null;
}

/** Read-only: may this manual card go back to auto now. Used by the tick and again inside the ledger transaction. */
export function manualResumeVerdict(db: Database, task: LedgerTask, wf: TaskWorkflow | null): ManualResumeVerdict {
  if (TERMINAL_STAGES.includes(task.stage)) return no(`卡已 ${task.stage}`);
  if (wf?.mode !== "manual") return no("workflow 不是 manual");
  const events = listEvents(db, { project: task.project, target: task.id });
  const entry = manualEntry(events);
  if (!entry?.record) return no(entry ? "进 manual 时没有结构化理由（MAN1 之前的旧记录），交 PM" : "找不到进 manual 的事件");
  const rec = entry.record;
  if (!LIFTABLE.includes(rec.code)) return no(`${rec.label}（${rec.code}）不由自动恢复解除`);
  if (rec.specRev !== task.specRev) return no(`规格已变（specRev ${rec.specRev}→${task.specRev}）`);
  if ((rec.head ?? null) !== (task.headSHA ?? null)) return no("head 已变");
  if ((rec.uiDigest ?? null) !== uiDigest(task)) return no("UI 截图摘要已变");
  const block = cardBlock(db, task, events, entry.event.seq);
  if (block) return no(block);
  const deps = depsReleased(db, task, rec, events, entry.event.seq);
  if (!deps.ok) return no(deps.why);
  const last = events.findLast((e) => !(e.kind === "note" && e.data.op === OBSERVE_OP))?.seq ?? 0;
  const fingerprint = createHash("sha256").update(JSON.stringify([task.id, task.rev, wf.rev, task.specRev, task.headSHA ?? null, task.round,
    uiDigest(task), entry.event.seq, rec.code, last, deps.deps])).digest("hex").slice(0, 16);
  return { ok: true, facts: { code: rec.code, entrySeq: entry.event.seq, deps: deps.deps, fingerprint } };
}

/** The reason the scheduler hands workflow-resume; it carries the authorization the gate re-checks. */
export function manualResumeReason(f: ManualResumeFacts): string {
  return `manual 自动恢复 授权 ${f.fingerprint}：${f.code} 解除条件已满足（前置 ${f.deps.map((d) => `${d.id}@${d.stage}`).join("、")}，进 manual #${f.entrySeq}）`;
}

/**
 * Inside resumeAutoWorkflow's transaction, for the scheduler identity only: the policy must say on right now and the verdict must hold
 * with the exact authorization the caller read. Throws (nothing written) otherwise; returns the event mark.
 */
export function manualResumeGate(db: Database, input: { taskId: string; reason: string }, policy: RecoveryPolicyPort = recoveryPolicy): Record<string, unknown> {
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  let mode: string;
  try { mode = decideRecovery(policy(task.project, "manualStall")).kind; } catch (e) { mode = `读不了（${(e as Error).message}）`; }
  if (mode !== "act") throw new LedgerError("forbidden", `manual 自动恢复只在恢复策略 manualStall 为 on 时执行（现在：${mode}）`);
  const auth = AUTH.exec(input.reason)?.[1];
  if (!auth) throw new LedgerError("forbidden", "调度身份交回自动要带 manual 自动恢复授权（manualResumeReason）");
  const v = manualResumeVerdict(db, task, getWorkflow(db, task.id));
  if (!v.ok) throw new LedgerError("conflict", `manual 自动恢复条件不再成立：${v.why}`);
  if (v.facts.fingerprint !== auth) throw new LedgerError("conflict", "manual 自动恢复授权已失效（卡在读和交回之间变过），下一轮重读");
  return { auto: true, manualResume: { code: v.facts.code, entrySeq: v.facts.entrySeq, deps: v.facts.deps, fingerprint: v.facts.fingerprint } };
}

/** ledger-scheduler-resume.ts resumeAutoWorkflow, injected by the wiring (it imports this file's gate). */
type ResumeWorkflow = (db: Database, ctx: { actor: string; now: number },
  input: { taskId: string; taskRev: number; workflowRev: number; reason: string; maxWorkers: number }, policy: RecoveryPolicyPort) => unknown;

export interface ManualResumeDeps {
  /** The existing workflow-resume transaction; the scheduler identity passes manualResumeGate inside it. */
  resume: ResumeWorkflow;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  now(): number;
  policy?: RecoveryPolicyPort;
  yieldNow?(): boolean;
}
export interface ManualResumeOutcome { project: string; taskId?: string; mode: "on" | "observe" | "off"; action: string; why: string }

/** One pass before the auto tick: off reads nothing, observe records would-resume once per state version, on resumes via the CLI. */
export async function manualResumeTick(db: Database, projects: Record<string, { maxActiveWorkers: number }>, d: ManualResumeDeps): Promise<ManualResumeOutcome[]> {
  const out: ManualResumeOutcome[] = [];
  for (const [project, cfg] of Object.entries(projects)) {
    let decision: ReturnType<typeof decideRecovery>;
    const port = d.policy ?? recoveryPolicy;
    try { decision = decideRecovery(port(project, "manualStall")); }
    catch (e) { decision = { kind: "skip", reason: `读恢复策略失败，按 off：${(e as Error).message}` }; }
    if (decision.kind === "skip") { out.push({ project, mode: "off", action: "none", why: decision.reason }); continue; }
    const mode = decision.kind === "act" ? "on" : "observe";
    const ids = db.query("SELECT taskId FROM task_workflows WHERE project = ? AND mode = 'manual' ORDER BY taskId").all(project) as { taskId: string }[];
    for (const { taskId } of ids) {
      if (d.yieldNow?.()) return out;
      const task = getTask(db, taskId), wf = getWorkflow(db, taskId);
      if (!task || !wf) continue;
      const v = manualResumeVerdict(db, task, wf);
      if (!v.ok) { out.push({ project, taskId, mode, action: "none", why: v.why }); continue; }
      const reason = manualResumeReason(v.facts);
      if (mode === "observe") {
        const r = recordObserved(db, { project, mechanism: "manualStall", target: taskId, actionKey: `resume.${v.facts.fingerprint}`,
          action: `把 ${taskId} 交回自动：${reason}`, data: { manualResume: v.facts } }, d.now());
        out.push({ project, taskId, mode, action: r.recorded ? "would_resume" : "observed_before", why: reason });
        continue;
      }
      try {
        d.resume(db, { actor: "scheduler", now: d.now() }, { taskId, taskRev: task.rev, workflowRev: wf.rev, reason, maxWorkers: cfg.maxActiveWorkers }, port);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        out.push({ project, taskId, mode, action: "refused", why: e.message });
        continue;
      }
      out.push({ project, taskId, mode, action: "resumed", why: reason });
      await d.notifyPm(task, `[manual 自动恢复] ${taskId} 已交回自动：${reason}`).catch((e) => {
        if (e instanceof SchedulerStopped) throw e;
        console.error(`⚠️ [scheduler] manual 自动恢复通知没发出去（台账已记 workflow_resume，不重发）：${(e as Error).message}`);
      });
    }
  }
  return out;
}
