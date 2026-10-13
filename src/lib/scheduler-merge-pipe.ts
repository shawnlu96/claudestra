/**
 * merge-arch-MRGPIPE1 · with mergeDirect on, a merge run that holds the project slot while it waits on its own CI (await_ci,
 * some required check without a verdict) lends the slot to a card that can merge right now: green, CLEAN / BEHIND, and with no
 * changed file (old rename paths included) in common, so the holder only ends up behind main, which a direct merge accepts.
 * No new slot mechanism: the holder yields through the same-phase SLOT_YIELD merge step (turnMergeSlot: rev CAS, drift check),
 * the auto tick plans the borrower as usual (the ledger checks the slot and its review), mergeNow merges it in this pass, and
 * the holder takes the slot back the existing ways (mergeSlotTurn on a free slot, MTR1 reclaimLentSlots after the deploy).
 * While the slot is free between the yield and the plan, every other merge card waits on mergePipeHold.
 * Recovery key mergePipe (default observe): off = nothing, no PR read. observe = judge and note "would lend" once. on = lend.
 * The pass runs mergePipeStep after manual.claim and before the observe / auto ticks; at most one lend per project and pass.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask } from "./ledger-store.js";
import { blocksTrain, manualTurn, trainSignal } from "./manual-merge-queue.js";
import { requestSeqOf } from "./manual-merge-queue-facts.js";
import { peerPrHold } from "./peer-pr-hold.js";
import { recoveryPolicy, type RecoveryKey, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { mainCiGateOf, mainCiTrainPaused } from "./scheduler-main-ci-wiring-gate.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import { getMergeRun, mergeRunDrift, type MergeRun } from "./scheduler-merge.js";
import { mergeFirst } from "./scheduler-merge-order.js";
import { lenders } from "./scheduler-merge-reclaim.js";
import { SLOT_YIELD, trainHolds } from "./scheduler-merge-train-hold.js";
import { defaultTrainStore, mergeSlotHold } from "./scheduler-merge-train-hold-slot.js";
import { guardedCommand, trainContext, type TrainContext } from "./scheduler-merge-train-tick.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { borrowerReady, filesDisjoint, holderRefusal, holderWaits, MERGE_PIPE_KEY, PIPE_CANDIDATES, PIPE_TAG, pipeBorrower, pipeReceipt,
  projectRefusal } from "./scheduler-merge-pipe-judge.js";
import { planScheduler } from "./scheduler-plan.js";
import { paceCards, type TickPace } from "./scheduler-yield.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Project = SchedulerConfig["projects"][string];
export interface MergePipeIo {
  manager: Manager;
  /** The pass's merge external: its inspect is the PR read (guarded gh in the service, the fake GitHub in tests). */
  external: (project: Project) => MergeExternal;
  active: () => void;
  /** The pass's train context (tests); absent = the default store and the guarded train gh (none in a test process). */
  train?: TrainContext;
  policy?: RecoveryPolicyPort;
  pace?: TickPace;
  /** Cards that got the slot after this pass's mergeTick (reclaimed / manually claimed): mergeNow drives them first. */
  late?: readonly string[];
}
export interface MergePipeResult { lent: string[]; failed: { taskId: string; error: string }[] }
/** The PR reads; tests swap them with useMergePipeReads to count or fail them. */
export interface MergePipeReads { inspect(project: Project, prRef: string): Promise<PrSnapshot>; files(prRef: string, head: string): Promise<string[] | null> }

let override: Partial<MergePipeReads> = {};
export function useMergePipeReads(over: Partial<MergePipeReads>): Disposable {
  const before = override;
  override = { ...before, ...over };
  return { [Symbol.dispose]: () => { override = before; } };
}
/** One try per holder run and borrower head (lent or noted); a refused yield (conflict) is tried again next pass. */
const tried = new Set<string>();
const triedKey = (run: MergeRun, t: LedgerTask) => `${run.intentId} ${run.prRef} ${t.id} ${t.pr} ${t.headSHA}`;
/** File lists per PR head for the process (GitHub's list for a head never changes). */
const filesSeen = new Map<string, string[] | null>();
const remember = <K, V>(m: Map<K, V> | Set<K>, k: K, v?: V) => {
  if (m.size >= 500) m.clear();
  if (m instanceof Map) m.set(k, v as V); else m.add(k);
};

const modeOf = (policy: RecoveryPolicyPort, project: string, key: RecoveryKey): RecoveryMode => {
  try { const p = policy(project, key); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
};
const hasMerges = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get();
const slotHolder = (db: Database, project: string) => db.query("SELECT intentId, taskId FROM scheduler_resources WHERE project = ? AND resource = ?")
  .get(project, `merge:${project}`) as { intentId: string; taskId: string } | null;
const lastSlotReceipt = (db: Database, run: MergeRun): string | null => (db.query(`SELECT json_extract(data, '$.receipt') AS r FROM events
  WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = 'merge_slot' AND json_extract(data, '$.intentId') = ? ORDER BY seq DESC LIMIT 1`)
  .get(run.taskId, run.intentId) as { r: string | null } | null)?.r ?? null;
const pipeLends = (db: Database, run: MergeRun): number => (db.query(`SELECT COUNT(*) AS n FROM events WHERE target = ? AND kind = 'scheduler'
  AND json_extract(data, '$.op') = 'merge_slot' AND json_extract(data, '$.intentId') = ? AND json_extract(data, '$.turn') = 'yield'
  AND json_extract(data, '$.receipt') LIKE ?`).get(run.taskId, run.intentId, `${SLOT_YIELD}${PIPE_TAG}%`) as { n: number }).n;

/**
 * The auto tick asks right before it plans a merge (after mergeSlotHold): while the project slot is free because its holder lent
 * it through the pipe to another card, this card waits, so the borrower (not the first merge card in line) takes the slot.
 */
export function mergePipeHold(db: Database, task: Pick<LedgerTask, "id" | "project">): string | null {
  if (!hasMerges(db) || slotHolder(db, task.project)) return null;
  for (const run of lenders(db, task.project)) {
    const to = pipeBorrower(lastSlotReceipt(db, run));
    if (to && to !== task.id) return `${run.taskId} 等 CI 时把合并槽借给 ${to} 先合（MRGPIPE），本卡等它计划后再申请`;
  }
  return null;
}

export async function mergePipeStep(db: Database, config: SchedulerConfig, io: MergePipeIo): Promise<MergePipeResult> {
  const out: MergePipeResult = { lent: [], failed: [] };
  if (!hasMerges(db)) return out;
  const policy = io.policy ?? recoveryPolicy;
  for (const [project, cfg] of Object.entries(config.projects)) {
    if (cfg.mergeHandoff || modeOf(policy, project, MERGE_PIPE_KEY) === "off") continue; // off: no read at all
    try {
      const lent = await projectStep(db, config, project, cfg, io, policy);
      if (lent) out.lent.push(lent);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId: `merge-pipe ${project}`, error: (e as Error).message.replace(/\s+/g, " ").slice(0, 300) });
    }
  }
  return out;
}

function loadStore(io: MergePipeIo, project: string): { store: TrainStore | null; holds: boolean } {
  const store = io.train ? io.train.store : defaultTrainStore();
  try {
    const s = store?.load(project) ?? null;
    return { store, holds: !!s && trainHolds(s, Date.now()) };
  } catch { return { store: null, holds: false }; } // a corrupt train file lends nothing
}

/** One project's turn: the gates, the holder, up to PIPE_CANDIDATES borrowers; returns the borrower lent to (or noted). */
async function projectStep(db: Database, config: SchedulerConfig, project: string, cfg: Project, io: MergePipeIo,
  policy: RecoveryPolicyPort): Promise<string | null> {
  const now = Date.now(), { store, holds } = loadStore(io, project), gate = mainCiGateOf(db);
  const mode = modeOf(policy, project, MERGE_PIPE_KEY);
  const refused = projectRefusal({ mode, direct: modeOf(policy, project, "mergeDirect") === "on", autoDispatch: config.autoDispatch === true,
    store: !!store, trainHolds: holds, frozen: getMeta(db, project).queueFrozen.frozen, ciCoverageOn: modeOf(policy, project, "ciCoverageGate") === "on",
    manualBlocks: !!store && db.transaction(() => blocksTrain(manualTurn(db, project, trainSignal(store, project, now), now)))(),
    mainCiPaused: modeOf(policy, project, "mainCiPause") === "on" && (!gate || mainCiTrainPaused(gate, project)) });
  const holder = refused ? null : slotHolder(db, project);
  const run = holder && getMergeRun(db, holder.intentId);
  if (!run) return null;
  const intent = db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(run.intentId) as { status: string } | null;
  if (holderRefusal({ manual: requestSeqOf(run.intentId) !== null, intentStatus: intent?.status ?? null, phase: run.phase,
    drift: run.phase === "await_ci" ? mergeRunDrift(db, run, now) : null, lends: pipeLends(db, run), late: !!io.late?.includes(run.taskId),
    skip: !!io.pace?.skipTask?.(run.taskId) })) return null;
  const cards = candidates(db, project, cfg, run, io, store);
  if (!cards.length) return null; // nobody could take the slot: not even the holder's PR is read
  const reads = readsOf(io);
  const pr = await reads.inspect(cfg, run.prRef);
  io.active();
  if (holderWaits(run, pr)) return null;
  const borrower = await pickBorrower(cards, cfg, run, reads, io);
  if (!borrower) return null;
  const key = triedKey(run, borrower);
  if (mode === "observe") return note(io.manager, run, borrower, key);
  const r = await io.manager("ledger", "scheduler-merge-step", run.intentId, "--from", "await_ci", "--to", "await_ci", "--rev", String(run.rev),
    "--receipt", pipeReceipt(borrower.id));
  if (r.ok === true) { remember(tried, key); return borrower.id; }
  if (r.code === "conflict") return null; // the run moved or the slot turned meanwhile: look again next pass
  throw new Error(`借出合并槽：${String(r.error ?? "manager failed")}`);
}

async function note(manager: Manager, run: MergeRun, borrower: LedgerTask, key: string): Promise<string> {
  const r = await manager("ledger", "scheduler-recovery-observe", run.taskId, "--mechanism", MERGE_PIPE_KEY,
    "--action-key", `lend:${run.intentId}:${borrower.id}@${borrower.headSHA!.slice(0, 12)}`,
    "--action", `等 CI 时会把合并槽借给 ${borrower.id}（已绿、改动不相交）先合`,
    "--data", JSON.stringify({ holder: run.taskId, holderHead: run.reviewedHead, borrower: borrower.id, borrowerHead: borrower.headSHA }));
  if (r.ok !== true) throw new Error(`mergePipe 观察记录：${String(r.error ?? "manager failed")}`);
  remember(tried, key);
  return borrower.id;
}

function readsOf(io: MergePipeIo): MergePipeReads {
  let gh: TrainContext["gh"] | null | undefined;
  const files = async (prRef: string, head: string) => {
    const k = `${prRef} ${head}`;
    if (filesSeen.has(k)) return filesSeen.get(k)!;
    gh ??= io.train ? io.train.gh : trainContext(guardedCommand(io.active))?.gh ?? null;
    if (!gh) return null; // no GitHub port: an unread list overlaps
    const list = await gh.prFiles(prRef);
    io.active();
    remember(filesSeen, k, list);
    return list;
  };
  return { inspect: (cfg, prRef) => io.external(cfg).inspect(prRef), files, ...override };
}

/** The first PIPE_CANDIDATES auto merge cards in merge-queue order the auto tick would plan a merge for now (ledger only). */
function candidates(db: Database, project: string, cfg: Project, run: MergeRun, io: MergePipeIo, store: TrainStore | null): LedgerTask[] {
  const out: LedgerTask[] = [];
  for (const { taskId } of mergeFirst(db, paceCards(db, { [project]: cfg }, "auto", io.pace))) {
    if (out.length >= PIPE_CANDIDATES) break;
    const t = getTask(db, taskId);
    if (!t || t.stage !== "merge" || t.id === run.taskId || !t.headSHA || !t.pr || tried.has(triedKey(run, t))) continue;
    if (plannable(db, t, cfg, store)) out.push(t);
  }
  return out;
}

/** One PR read per candidate, in order; the first green one whose files are disjoint from the holder's is it. */
async function pickBorrower(cards: readonly LedgerTask[], cfg: Project, run: MergeRun, reads: MergePipeReads, io: MergePipeIo): Promise<LedgerTask | null> {
  for (const task of cards) {
    const pr = await reads.inspect(cfg, task.pr!);
    io.active();
    if (borrowerReady(task, cfg.requiredChecks.join(","), pr)) continue;
    if (filesDisjoint(await reads.files(run.prRef, run.reviewedHead), await reads.files(task.pr!, task.headSHA!))) return task;
  }
  return null;
}

/** The auto tick's own pre-plan holds, then the same planner: only a card it would plan a merge for now. */
function plannable(db: Database, task: LedgerTask, cfg: Project, store: TrainStore | null): boolean {
  if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").get(task.id)) return false;
  if (peerPrHold(db, task) || mergeSlotHold(task, store)) return false;
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: cfg.maxActiveWorkers, now: Date.now() }));
  return plan.kind === "intent" && plan.action === "merge";
}
