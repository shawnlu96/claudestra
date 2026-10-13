/**
 * Evidence recovery of manual cards (RECBASE1): the proof contract and its mechanism dispatch. A mechanism only judges — it returns
 * a candidate proof or a refusal and never writes a mode. The one writer stays `ledger scheduler-manual-resume` (now with
 * `--mechanism`): the leased CLI reads the external evidence, proves, and scheduler-recovery-write.ts re-proves inside the
 * transaction (card facts, switch, fingerprint) before resumeCore hands the card back. Production registers one mechanism, UIRES1's
 * uiManualResume (manual-recovery-ui.ts); MAN2 (manual-resume.ts) stays its own path. Modes: manual-recovery-policy.ts. tests/manual-recovery-contract*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getTask, LedgerError, listEvents } from "./ledger-store.js";
import { ciLedgerGap, ciManualResume } from "./manual-recovery-ci.js";
import { extensionBlock, factsFingerprint, lastFactSeq, manualBase, type ManualBase } from "./manual-recovery-facts.js";
import { extensionMode, type ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { uiManualResume } from "./manual-recovery-ui.js";
import { fixLocalSwapManual } from "./recovery-fix-local-swap-manual.js";
import { manualEntry, type ManualReasonCode } from "./manual-reason.js";
import type { RecoveryKey } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

/** What the leased CLI read outside the ledger; only its digest enters the fingerprint. */
export interface ExternalSnapshot { source: string; digest: string; readAt: number }

/** One candidate hand-back, bound to every fact it stood on. */
export interface RecoveryProof {
  mechanism: string; episodeId: string;
  taskId: string; taskRev: number; workflowRev: number; head: string | null; specRev: number; round: number;
  reason: ManualReasonCode; subreason: string;
  /** the cancelled merge intent this hand-back releases for retry; null = none */
  cancelIntentId: string | null;
  /** the card event the evidence stands on, and the card's last fact when proved (the CLI pins it across its evidence read) */
  evidenceSeq: number; factSeq: number;
  external: ExternalSnapshot | null;
  next: string;
  fingerprint: string;
}
export type ProofVerdict = { kind: "candidate"; proof: RecoveryProof } | { kind: "refused"; why: string };

interface MechanismInput { db: Database; task: LedgerTask; workflow: TaskWorkflow; events: readonly LedgerEvent[]; entrySeq: number; external: ExternalSnapshot | null }
type MechanismJudgement =
  | { ok: true; episodeId: string; subreason: string; cancelIntentId: string | null; evidenceSeq: number; next: string }
  | { ok: false; why: string };

export interface ManualRecoveryMechanism {
  id: string;
  /** its own policy key; the umbrella manualRecovery is read as well */
  key: RecoveryKey;
  /** the manual reason codes it may lift; sticky codes are refused whatever it says */
  codes: readonly ManualReasonCode[];
  /** may it bind a cancelled merge intent (mergeRetryReleased then accepts exactly that one) */
  releasesCancel?: boolean;
  /** run by the leased CLI only, before its transaction; throwing refuses the card */
  readEvidence?(task: LedgerTask): Promise<ExternalSnapshot>;
  judge(input: MechanismInput): MechanismJudgement;
}

const REGISTRY = new Map<string, ManualRecoveryMechanism>();
const PART = /^[\w.:@/-]{1,120}$/;
REGISTRY.set(uiManualResume.id, uiManualResume); // UIRES1: the one production mechanism (manual-recovery-ui.ts)
REGISTRY.set(fixLocalSwapManual.id, fixLocalSwapManual); // GATESWAP1: manual fix cards past the owner threshold (recovery-fix-local-swap-manual.ts)
REGISTRY.set(ciManualResume.id, ciManualResume); // CIRES1: reads GitHub through the leased CLI (manual-recovery-ci.ts)

/** Registers a mechanism (tests and future cards); returns its removal. A duplicate id is a programming error. */
export function registerManualRecovery(m: ManualRecoveryMechanism): () => void {
  if (!PART.test(m.id) || REGISTRY.has(m.id)) throw new Error(`恢复机制 id 不合法或已登记：${m.id}`);
  REGISTRY.set(m.id, m);
  return () => { if (REGISTRY.get(m.id) === m) REGISTRY.delete(m.id); };
}
export const manualRecoveryMechanism = (id: string): ManualRecoveryMechanism | undefined => REGISTRY.get(id);

/** The card as the mechanism may see it: MAN1 entry it lists, no drift, no shared or extension refusal. */
function recoveryBase(db: Database, task: LedgerTask, wf: TaskWorkflow | null, m: ManualRecoveryMechanism): ManualBase {
  const base = manualBase(db, task, wf, (rec) => (m.codes.includes(rec.code) ? null : `${rec.code} 不归机制 ${m.id}`));
  if (!base.ok) return base;
  const block = extensionBlock(db, task, base.entry);
  return block ? { ok: false, why: block } : base;
}

/** Before the CLI reads external evidence: is the card a candidate at all, and its last fact (a proof must stand on the same one). */
export function recoveryMark(db: Database, task: LedgerTask, wf: TaskWorkflow | null, mechanism: string): { ok: true; factSeq: number } | { ok: false; why: string } {
  const m = REGISTRY.get(mechanism);
  if (!m) return { ok: false, why: `没有登记的恢复机制 ${mechanism}` };
  const base = recoveryBase(db, task, wf, m);
  return base.ok ? { ok: true, factSeq: lastFactSeq(base.events) } : base;
}

function cancelRefusal(db: Database, task: LedgerTask, m: ManualRecoveryMechanism, id: string | null): string | null {
  if (id === null) return null;
  if (!m.releasesCancel) return `机制 ${m.id} 不能绑定取消意图`;
  const i = getIntent(db, id);
  if (!i || i.taskId !== task.id || i.action !== "merge" || i.status !== "cancelled" || i.specRev !== task.specRev) return `取消意图 ${id} 不是本卡本规格已取消的合并`;
  return null;
}

/** Read-only proof; the same call runs in the CLI and again inside the write transaction with the same snapshot. */
export function proveRecovery(db: Database, task: LedgerTask, wf: TaskWorkflow | null, mechanism: string, external: ExternalSnapshot | null): ProofVerdict {
  const m = REGISTRY.get(mechanism);
  if (!m) return { kind: "refused", why: `没有登记的恢复机制 ${mechanism}` };
  if (!!m.readEvidence !== !!external) return { kind: "refused", why: external ? "机制不读外部证据，却带了快照" : "缺外部证据快照" };
  const base = recoveryBase(db, task, wf, m);
  if (!base.ok) return { kind: "refused", why: base.why };
  const { events, entry } = base;
  const j = m.judge({ db, task, workflow: wf!, events, entrySeq: entry.event.seq, external });
  if (!j.ok) return { kind: "refused", why: j.why };
  if (![j.episodeId, j.subreason, j.next].every((s) => PART.test(s))) return { kind: "refused", why: "证明的 episode / subreason / next 不合法" };
  if (!events.some((e) => e.seq === j.evidenceSeq)) return { kind: "refused", why: `证据 #${j.evidenceSeq} 不在本卡` };
  const cancel = cancelRefusal(db, task, m, j.cancelIntentId);
  if (cancel) return { kind: "refused", why: cancel };
  const own = { mechanism: m.id, episodeId: j.episodeId, subreason: j.subreason, cancelIntentId: j.cancelIntentId, evidenceSeq: j.evidenceSeq,
    external, next: j.next };
  const fingerprint = factsFingerprint(task, wf!, entry.event.seq, entry.record.code, events, [own]);
  return { kind: "candidate", proof: { ...own, taskId: task.id, taskRev: task.rev, workflowRev: wf!.rev, head: task.headSHA ?? null,
    specRev: task.specRev, round: task.round, reason: entry.record.code, factSeq: lastFactSeq(events), fingerprint } };
}

export const PROOF_OP = "manual_recovery_proof";
/** One proof episode hands a card back at most once, across ticks and restarts. */
export const proofKey = (p: Pick<RecoveryProof, "mechanism" | "taskId" | "episodeId">): string => `scheduler:manual-recovery:${p.mechanism}:${p.taskId}:${p.episodeId}`;
export const proofReason = (p: RecoveryProof): string => `manual 扩展恢复（${p.mechanism}）证明 ${p.fingerprint}：${p.reason}/${p.subreason}，证据 #${p.evidenceSeq}` +
  `${p.cancelIntentId ? `，绑定取消 ${p.cancelIntentId}` : ""}，下一步 ${p.next}`;

const MODE_OPS = ["workflow", "workflow_resume", "fallback_manual"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * mergeRetryReleased's formal path: the card's current mode is a scheduler workflow_resume carrying a proof that is sealed by the
 * proof event written right after it in the same transaction, the mechanism is registered and may bind cancels, and the proof
 * names exactly this cancelled intent on today's head / spec / round. Notes, PM reasons and later cancellations never match.
 */
export function proofReleasesCancel(task: LedgerTask, events: readonly LedgerEvent[], cancelled: SchedulerIntent): boolean {
  const last = events.findLast((e) => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op)));
  const p = last?.data.recoveryProof;
  if (!last || last.data.op !== "workflow_resume" || last.actor !== "scheduler" || last.data.auto !== true || last.data.manual !== undefined || !isObj(p)) return false;
  const proof = p as unknown as RecoveryProof;
  const seal = events.find((e) => e.seq === last.seq + 1);
  if (!seal || seal.kind !== "scheduler" || seal.actor !== "scheduler" || seal.data.op !== PROOF_OP || seal.ts !== last.ts ||
    seal.dedupKey !== proofKey(proof) || seal.data.resumeSeq !== last.seq || seal.data.fingerprint !== proof.fingerprint) return false;
  if (!REGISTRY.get(proof.mechanism)?.releasesCancel) return false;
  const head = task.headSHA?.toLowerCase() ?? null;
  return proof.cancelIntentId === cancelled.id && proof.taskId === task.id && proof.head?.toLowerCase() === head && cancelled.head?.toLowerCase() === head &&
    proof.specRev === task.specRev && proof.round === task.round && last.data.workflowRev === proof.workflowRev + 1;
}

export interface RecoveryOutcome { project: string; taskId: string; mechanism: string; mode: "on" | "observe" | "off"; action: string; why: string }
export interface RecoveryTickDeps {
  policy?: ExplicitPolicyPort;
  /** the leased `scheduler-manual-resume --mechanism`; business refusals arrive as LedgerError */
  write(task: LedgerTask, mechanism: string, mode: "on" | "observe"): Promise<Record<string, unknown>>;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  yieldNow?(): boolean;
}

/** After MAN2: every manual card × every registered mechanism listing its entry code. off judges nothing; error refuses. */
export async function manualRecoveryTick(db: Database, projects: readonly string[], d: RecoveryTickDeps): Promise<RecoveryOutcome[]> {
  const out: RecoveryOutcome[] = [];
  if (!REGISTRY.size) return out;
  for (const project of projects) {
    const ids = db.query("SELECT taskId FROM task_workflows WHERE project = ? AND mode = 'manual' ORDER BY taskId").all(project) as { taskId: string }[];
    for (const { taskId } of ids) for (const m of REGISTRY.values()) {
      if (d.yieldNow?.()) return out;
      const task = getTask(db, taskId), wf = getWorkflow(db, taskId);
      if (!task || !wf || wf.mode !== "manual") continue;
      const code = manualEntry(listEvents(db, { project, target: taskId }))?.record?.code;
      if (!code || !m.codes.includes(code)) continue;
      const mode = extensionMode(project, m.key, d.policy);
      if (mode.mode === "off") continue;
      const row = { project, taskId, mechanism: m.id, mode: mode.mode === "error" ? "off" as const : mode.mode };
      if (mode.mode === "error") { out.push({ ...row, action: "refused", why: mode.why }); continue; }
      const base = recoveryBase(db, task, wf, m);
      if (!base.ok) { out.push({ ...row, action: "none", why: base.why }); continue; }
      const pre = m === uiManualResume ? proveRecovery(db, task, wf, m.id, null) : null; // UIRES1: judged in-process first, the leased CLI only for a candidate
      if (pre?.kind === "refused") { out.push({ ...row, action: "none", why: pre.why }); continue; }
      const ciGap = m === ciManualResume ? ciLedgerGap(db, task, wf, base.events, base.entry.event.seq) : null; // CIRES1: no GitHub read for a card the ledger rules out
      if (ciGap) { out.push({ ...row, action: "none", why: ciGap }); continue; }
      let r: Record<string, unknown>;
      try { r = await d.write(task, m.id, mode.mode); }
      catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        out.push({ ...row, action: "refused", why: e.message });
        continue;
      }
      const why = typeof r.reason === "string" ? r.reason : m.id;
      if (mode.mode === "observe") { out.push({ ...row, action: r.recorded === true ? "would_resume" : "observed_before", why }); continue; }
      out.push({ ...row, action: "resumed", why });
      await d.notifyPm(task, `[manual 扩展恢复] ${taskId} 已交回自动：${why}`).catch((e) => {
        if (e instanceof SchedulerStopped) throw e;
        console.error(`⚠️ [scheduler] manual 扩展恢复通知没发出去（台账已记 workflow_resume，不重发）：${(e as Error).message}`);
      });
    }
  }
  return out;
}
