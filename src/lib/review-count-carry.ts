/**
 * merge-arch-CARRYCNT1 · the merge driver's count carry: when update-branch's pure-main proof refused a moved head in `updating`
 * (scheduler-merge-driver.ts movedHead), ask whether the new head is the reviewed head plus only EFFAUTO1's count commit
 * (review-count-carry-proof.ts) and, if so, carry the review to it (the ledger re-checks: review-count-carry-ledger.ts).
 * Recovery key effCountCarry (default observe): off = null at once, no git read (the old re-review, receipt unchanged).
 * observe = run the proof and, once H1 is a count commit at all (a and b), note would / wouldnot with why, then null.
 * on = a holding proof steps to await_ci with the count receipt (a draft PR waits for the next pass); a refused proof is null;
 * the ledger refusing it goes back to review with that reason (noted as failed), never to unknown. mergeState / CI on the new head
 * are the next pass's await_ci road, unchanged. tests/review-count-carry*.test.ts.
 */
import type { RecoveryMode } from "./recovery-policy.js";
import { countCarryProof, type CountProof, type CountProofInput } from "./review-count-carry-proof.js";
import { countCarryMode, countCarryReceipt, EFF_COUNT_CARRY_KEY } from "./review-count-carry-ledger.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PrSnapshot, ReviewCarry } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

type Step = (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface CountCarryNote { taskId: string; actionKey: string; action: string; data: Record<string, unknown> }

/** Everything the step reaches outside itself; tests swap parts with useCountCarryPorts. */
export interface CountCarryPorts {
  mode(project: string): RecoveryMode;
  repoDir(project: string): string | null;
  prove(input: CountProofInput): Promise<CountProof>;
  note(note: CountCarryNote): Promise<void>;
}

let writer: Manager | null = null;
const DEFAULT_PORTS: CountCarryPorts = {
  mode: (project) => countCarryMode(project), // read every pass, never throws: an unreadable policy is off (the old re-review)
  repoDir: (project) => readSchedulerConfig().projects[project]?.repoDir ?? null,
  prove: (input) => countCarryProof(input),
  note: async (n) => {
    if (!writer) throw new Error("合并 tick 没有绑定台账写口");
    const r = await writer("ledger", "scheduler-recovery-observe", n.taskId, "--mechanism", EFF_COUNT_CARRY_KEY, "--action-key", n.actionKey,
      "--action", n.action, "--data", JSON.stringify(n.data));
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
  },
};
let ports: CountCarryPorts = DEFAULT_PORTS;

/** One merge tick's ledger writer (`using` in mergeTick), cleared when the tick ends so no later driver writes through it. */
export function bindCountCarrySink(manager: Manager, assertActive: () => void): Disposable {
  const mine: Manager = async (...args) => { assertActive(); return manager(...args); };
  writer = mine;
  return { [Symbol.dispose]: () => { if (writer === mine) writer = null; } };
}
/** Tests: replace some ports until disposed. */
export function useCountCarryPorts(over: Partial<CountCarryPorts>): Disposable {
  const before = ports;
  ports = { ...before, ...over };
  return { [Symbol.dispose]: () => { ports = before; } };
}

const short = (s: string) => s.slice(0, 12);
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

/** A note never changes the merge path: a failed write is only logged (a lost lease stops the pass at the driver's next step). */
async function note(run: MergeRun, kind: string, action: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ports.note({ taskId: run.taskId, actionKey: `${kind}.${short(run.reviewedHead)}`, action, data });
  } catch (e) {
    console.error(`⚠️ [count-carry] ${run.taskId} 观察记录失败（不影响合并队列原路径）：${(e as Error).message.slice(0, 200)}`);
  }
}

/**
 * null = the caller's old `back(carry)`, receipt unchanged; a run = carried to await_ci, waited (draft) or, the ledger having
 * refused the carry, sent back to review with that reason.
 */
export async function countCarryStep(run: MergeRun, pr: PrSnapshot, step: Step, back: (c: ReviewCarry) => Promise<MergeRun>): Promise<MergeRun | null> {
  if (run.phase !== "updating") return null;
  const mode = ports.mode(run.project);
  if (mode === "off") return null;
  const repoDir = ports.repoDir(run.project), ref = PR.exec(run.prRef), oldHead = run.reviewedHead.toLowerCase(), newHead = pr.head.toLowerCase();
  if (!repoDir || !ref) return null;
  const proof = await ports.prove({ repoDir, repository: ref[1]!, prNumber: ref[2]!, oldHead, newHead });
  if (proof.kind === "none") return null;
  const facts: Record<string, unknown> = { mode, oldHead, newHead, ...(proof.kind === "refused" ? { reason: proof.reason } : {}),
    blobFrom: proof.blobFrom ?? null, blobTo: proof.blobTo ?? null, entries: proof.entries ?? [] };
  if (mode === "observe") {
    await note(run, proof.kind === "ok" ? "would" : "wouldnot", proof.kind === "ok"
      ? `本可沿用审查：${short(newHead)} 只比审过的 ${short(oldHead)} 多一个效果点计数提交，不回审` : `不可沿用，照旧回审：${proof.reason}`, facts);
    return null;
  }
  if (proof.kind !== "ok") return null;
  if (pr.draft) return run; // re-proved next pass on the same evidence
  try {
    return await step("await_ci", countCarryReceipt({ oldHead, newHead, blobFrom: proof.blobFrom, blobTo: proof.blobTo }), undefined, pr.head);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 200);
    await note(run, "failed", `计数沿用被台账拒绝，照旧回审：${why}`, facts);
    return back({ ok: false, reason: `计数沿用被台账拒绝：${why}` });
  }
}
