/**
 * merge-arch-CAND1 · what a train member that boarded through the unified candidates carries, and the three thin questions the old
 * files ask about it. A ui or manual candidate boards with a `unified` binding (its source, the ui flag, the manual request's seq);
 * formTrain copies candidates into the train state as they are, so the binding is saved with the member and every later check
 * reads the protocol the member boarded under, never the switch as it is now (a switch back to observe / off stops new unified
 * candidates only). A plain auto member has no binding and keeps the old checks.
 * - the train tick: unifiedTrainCandidates (this pass's candidates), memberCheck (why a bound member left) and formingSave (the
 *   train being saved, handed to the form fence on its save closure);
 * - the manual queue: ridingRequests (requests whose member the settling train is ready to merge: they may claim under a live train);
 * - the pass (manual-merge-queue-pass.ts) opens the pass's ports here, found by the ledger connection or its file.
 * No import of the train tick, the manual queue or the queue facts: all three import this file. tests/merge-queue-candidates*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { intentOf, manualQueueMode, requestAt, requestRefusal } from "./manual-merge-queue-facts.js";
import { ridesTrain } from "./scheduler-merge-train-hold.js";
import { formTrain, type TrainCandidate, type TrainState, type TrainStore } from "./scheduler-merge-train.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export interface UnifiedBinding { v: 1; source: "auto" | "manual"; ui: boolean; requestSeq: number | null }
export interface UnifiedCandidate extends TrainCandidate { unified?: UnifiedBinding }
type Files = (c: TrainCandidate) => Promise<string[] | null>;

/** What the pass hands the train tick and the claim for one ledger connection (manual-merge-queue-pass.ts opens it every pass). */
export interface UnifiedPass {
  /** on: the unified candidates in queue order; observe / off: `old` as it is */
  candidates(project: string, old: readonly TrainCandidate[], now: number): TrainCandidate[];
}
const passes = new WeakMap<Database, UnifiedPass>();
/** The train store of a ledger file: the claim runs on another connection (a child process outside tests) of the same ledger. */
const stores = new Map<string, TrainStore | null>();
const fileReads = new WeakMap<Database, Files>();
const onDisk = (db: Database): string | null => (db.filename && db.filename !== ":memory:" ? db.filename : null);

export function openUnifiedPass(db: Database, pass: UnifiedPass, trains: TrainStore | null): void {
  passes.set(db, pass);
  const file = onDisk(db);
  if (!file) return;
  if (stores.size >= 50 && !stores.has(file)) stores.clear();
  stores.set(file, trains);
}

/** The train tick's candidates; outside a pass that opened the ports (tests driving the tick alone) the old ones. */
export const unifiedTrainCandidates = (db: Database, project: string, old: readonly TrainCandidate[], now: number): TrainCandidate[] =>
  passes.get(db)?.candidates(project, old, now) ?? [...old];

/** The tick's cached PR file reader of this pass, for the observe prediction made after the tick (same reads on would make). */
export function unifiedFiles(db: Database, files?: Files): Files | null {
  if (files) fileReads.set(db, files);
  return fileReads.get(db) ?? null;
}

export const bindingOf = (m: TrainCandidate): UnifiedBinding | null => (m as UnifiedCandidate).unified ?? null;
const memberOf = (s: TrainState | null, taskId: string, head: string): TrainCandidate | null =>
  s?.members.find((m) => m.taskId === taskId && m.head.toLowerCase() === head.toLowerCase()) ?? null;

/**
 * Why a manual member's request no longer lets it merge, or null. Its own claimed run is not "another open intent"; before the
 * claim the manual queue must still be on (nobody would claim it otherwise and the train would wait for it until its deadline).
 */
function requestGone(db: Database, seq: number, now: number): string | null {
  const req = requestAt(db, seq);
  if (!req) return `人工合并请求 #${seq} 缺失`;
  const intent = intentOf(db, req);
  if (intent && intent.status !== "pending" && intent.status !== "submitted") return `人工合并请求 #${seq} 的运行已 ${intent.status}`;
  const r = requestRefusal(db, req, now, !!intent);
  if (r) return `人工合并请求 #${seq} 已失效：${r.why}`;
  const mode = intent ? "on" : manualQueueMode(req.project);
  return mode === "on" ? null : `人工合并排队策略已是 ${mode}，请求 #${seq} 不会被认领`;
}

/**
 * memberStatusOf's last question for a member bound at boarding (after merged / head / stage): a manual member answers with its
 * request (still valid, every gate still passing), a ui member with the auto mode plus the screenshot gate. null = not a bound
 * member, the old `mode = auto` rule applies. Whatever the switch says now.
 */
export function memberCheck(db: Database, s: TrainState | null, taskId: string, head: string, now: number): ((task: LedgerTask) => string | null) | null {
  const m = memberOf(s, taskId, head), b = m && bindingOf(m);
  if (!b) return null;
  if (b.requestSeq !== null) { const seq = b.requestSeq; return () => requestGone(db, seq, now); }
  return (task) => {
    const mode = getWorkflow(db, taskId)?.mode;
    if (mode !== "auto") return `流程改为 ${mode ?? "缺流程"}`;
    const ui = b.ui ? uiMergeRefusal(db, task, now) : null;
    return ui ? `UI 验收：${ui}` : null;
  };
}

type Save = () => void;
type FormingSave = Save & { forming?: TrainState };
/** The save closure of a train being formed, carrying that train: wrappers of the fence pass the closure on untouched. */
export const formingSave = (state: TrainState, save: Save): Save => Object.assign(() => save(), { forming: state });
/** Whether the train behind this save carries the manual request `seq` as a bound member. */
export const formingCarries = (save: Save, seq: number): boolean =>
  !!(save as FormingSave).forming?.members.some((m) => bindingOf(m)?.requestSeq === seq);

/**
 * Requests whose member the project's train is ready to merge or bounce (settling, cleared or pinned): the train is their turn, so
 * the claim neither waits for it nor for the auto turn owed after a manual run. A train file that cannot be read rides no one (the
 * old path's `corrupt` signal waits). `fallback` = the store of a process the pass did not open (the claim's child).
 */
export function ridingRequests(db: Database, project: string, fallback: () => TrainStore | null): Set<number> {
  const file = onDisk(db), store = file && stores.has(file) ? stores.get(file)! : fallback();
  let s: TrainState | null = null;
  try { s = store?.load(project) ?? null; } catch { return new Set(); } // unreadable train file: no member is known, the old wait stands
  if (!s || s.phase !== "settling") return new Set();
  const state = s;
  return new Set(state.members.filter((m) => ridesTrain(state, m.taskId, m.head)).map((m) => bindingOf(m)?.requestSeq ?? null)
    .filter((seq): seq is number => seq !== null));
}

/**
 * The batch on would form from these candidates, by the train's own formTrain (same limits, same file-conflict pick) run against a
 * recorder: nothing is saved, no branch, no notice, and the only GitHub reads are the PR file lists the tick caches. The project
 * name is a recorder key so the train switch's own observe dedup (observeBatch) never sees this dry run.
 */
export async function predictBatch(project: string, cands: readonly TrainCandidate[], files: Files, skipped: readonly string[],
  now: () => number): Promise<UnifiedCandidate[]> {
  let formed: TrainState | null = null;
  const store: TrainStore = { load: () => null, all: () => [], save: (s) => { formed = s; }, event: () => {}, nextSeq: () => 0 };
  const gh = { mainHead: async () => "0".repeat(40) } as unknown as Parameters<typeof formTrain>[2]["gh"];
  await formTrain(`unified-observe:${project}`, cands, { gh, store, now, requiredChecks: [], memberStatus: () => ({ kind: "waiting" }), notify: async () => {} },
    files, skipped);
  return (formed as TrainState | null)?.members ?? [];
}
