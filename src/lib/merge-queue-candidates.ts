/**
 * merge-arch-CAND1 · the existing train's candidates picked from the unified queue (QUEUE1 merge-queue-facts.ts): next to the auto
 * code cards the train always carried, a ui card whose screenshot acceptance holds and a manual card whose PM request is valid with
 * every gate passing (bound to that request's seq). Batch limits, the file-conflict pick and requiredChecks stay formTrain's.
 * Switch `mergeUnifiedCandidates` (CFG's RecoveryPolicyPort, unset = observe, unreadable = off):
 * - off: the old candidates, the old fence, nothing computed or recorded;
 * - observe: the same old returns everywhere; after the pass's manual claim the full pick, the batch on would form and whether the
 *   due manual head would ride it are recorded as recovery_observe notes (one per fact, classes ui / manual / rejected / batch);
 * - on: the pick feeds the train tick; a due manual head that rides the forming train no longer fences it (one that does not ride
 *   keeps the old fairness: no train, it is claimed first). After a green train a manual member merges through its own manual intent.
 * Dependency tiers (asked per card class, on and observe alike): QUEUE1 readable (unifiedMergeQueue not off), a ui card needs
 * mergeContentUi on (UI1), a manual card manualMergeQueue on (MQ1). A class below its tier takes the old path and is not recorded.
 * Members already aboard keep the protocol they boarded under (merge-queue-candidates-member.ts). tests/merge-queue-candidates*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { manualTurn, type Turn } from "./manual-merge-queue.js";
import { manualQueueMode } from "./manual-merge-queue-facts.js";
import { mergeContentUiMode } from "./merge-content-ui.js";
import { mergeQueueFacts, unifiedQueueMode, type QueueEntry, type QueueFactsPorts } from "./merge-queue-facts.js";
import { bindingOf, formingTrain, openUnifiedPass, predictBatch, unifiedFiles, type UnifiedCandidate } from "./merge-queue-candidates-member.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { nextSkip, type TrainCandidate, type TrainStore } from "./scheduler-merge-train.js";
import { trainMode } from "./scheduler-merge-train-switch.js";
import { mergeCandidates } from "./scheduler-merge-train-tick.js";
import { schedulerV2Unskipped } from "./scheduler-v2-skip.js";

export const UNIFIED_CANDIDATES_KEY = "mergeUnifiedCandidates";

/** Read right before each use; a read that throws is off. */
export function unifiedCandidatesMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { return policy(project, UNIFIED_CANDIDATES_KEY).mode; }
  catch (e) {
    console.error(`⚠️ [merge-candidates] ${project} 读恢复策略失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

/** The capabilities a card class needs before it may board (tests inject them); the file-backed switches by default. */
export interface UnifiedCaps { queue(project: string): boolean; ui(project: string): boolean; manual(project: string): boolean }
const unifiedCaps = (policy: RecoveryPolicyPort = recoveryPolicy): UnifiedCaps => ({
  queue: (p) => unifiedQueueMode(p, policy) !== "off",
  ui: (p) => mergeContentUiMode(p) === "on",
  manual: (p) => manualQueueMode(p, policy) === "on",
});

interface Rejected { taskId: string; head: string | null; requestSeq: number | null; code: string; why: string }
export interface UnifiedPick { candidates: UnifiedCandidate[]; rejected: Rejected[] }

/** Entries that are nobody's candidate question any more: already merged, an ended request, a second request of the same card. */
const SETTLED: readonly string[] = ["landed", "manual_ended", "duplicate_request"];

/**
 * The unified pick in QUEUE1 order. An auto code card is a candidate exactly when the old filter lists it (`old`, passed in so the
 * train's own list is never re-judged). A ui card: listed by the auto gate's filter with ui (mergeCandidates, screenshot acceptance
 * included) and neither blocked nor excluded in the queue. A manual card: its request's entry is ready. Admission itself is never
 * decided here.
 */
export function unifiedPick(db: Database, project: string, now: number, old: readonly TrainCandidate[], caps: UnifiedCaps = unifiedCaps(),
  ports: QueueFactsPorts = {}): UnifiedPick {
  if (!caps.queue(project)) return { candidates: [...old], rejected: [] };
  const plain = new Map(old.map((c) => [c.taskId, c])), withUi = new Map(mergeCandidates(db, project, { now }).map((c) => [c.taskId, c]));
  const out: UnifiedPick = { candidates: [], rejected: [] };
  const reject = (e: QueueEntry, code: string, why: string) =>
    out.rejected.push({ taskId: e.taskId, head: e.head, requestSeq: e.manualRequestSeq, code, why });
  for (const e of mergeQueueFacts(db, project, now, ports)) {
    const refused = e.reason && !SETTLED.includes(e.reason.code) ? e.reason : null;
    if (e.source === "manual") {
      if (!caps.manual(project) || (e.ui.template && !caps.ui(project))) continue; // below its tier: the old manual queue alone
      if (e.state === "ready" && e.manualRequestSeq !== null && e.pr && e.head) {
        out.candidates.push({ taskId: e.taskId, prRef: e.pr, head: e.head, unified: { v: 1, source: "manual", ui: e.ui.template, requestSeq: e.manualRequestSeq } });
      } else if (refused) reject(e, refused.code, refused.why);
    } else if (!e.ui.template) {
      const c = plain.get(e.taskId);
      if (c && plain.delete(e.taskId)) out.candidates.push(c);
    } else if (caps.ui(project)) {
      const c = withUi.get(e.taskId);
      if (c && (e.state === "ready" || e.state === "running")) out.candidates.push({ ...c, unified: { v: 1, source: "auto", ui: true, requestSeq: null } });
      else if (refused) reject(e, refused.code, refused.why);
    }
  }
  out.candidates.push(...plain.values()); // an old candidate the queue view did not list is never lost
  return out;
}

/** blocks' exception under on: the due head is itself a candidate, so the train tick may try to form with it (formFence decides). */
export function headMayRide(db: Database, project: string, turn: Turn, now: number, policy: RecoveryPolicyPort = recoveryPolicy): boolean {
  if (turn.kind !== "due" || unifiedCandidatesMode(project, policy) !== "on") return false;
  return unifiedPick(db, project, now, [], unifiedCaps(policy)).candidates.some((c) => bindingOf(c)?.requestSeq === turn.req.seq);
}

/**
 * formFence's admission check of a forming train, in the save's own ledger snapshot: the pick was made before formTrain's awaits
 * (PR files, main head), so a member bound then boards only if the switch is still on and the same pick, made again now, still
 * lists it with the same head and binding (a frozen queue, a revoked / held request, a lost ui acceptance, a tier switched off).
 * null = save; a reason = no train this pass (the next pass picks again). Plain auto members keep the old admission, unchecked here.
 */
export function boardingRefusal(db: Database, project: string, save: () => void, now: number, policy: RecoveryPolicyPort = recoveryPolicy): string | null {
  const bound = (formingTrain(save)?.members ?? []).filter((m) => bindingOf(m));
  if (!bound.length) return null;
  const mode = unifiedCandidatesMode(project, policy);
  if (mode !== "on") return `统一候选开关已是 ${mode}，不再接新的统一成员`;
  const picked = unifiedPick(db, project, now, [], unifiedCaps(policy)).candidates;
  for (const m of bound) {
    const b = bindingOf(m)!;
    const same = picked.some((c) => c.taskId === m.taskId && c.head.toLowerCase() === m.head.toLowerCase()
      && bindingOf(c)?.source === b.source && bindingOf(c)?.ui === b.ui && bindingOf(c)?.requestSeq === b.requestSeq);
    if (!same) return `${m.taskId} @ ${short(m.head)} 落盘前已不是统一候选`;
  }
  return null;
}

/** Opens the pass's ports for the train tick and the claim (manual-merge-queue-pass.ts, once per pass). */
export function openUnifiedCandidates(db: Database, trains: TrainStore | null, policy: RecoveryPolicyPort = recoveryPolicy): void {
  openUnifiedPass(db, {
    candidates: (project, old, now) => (unifiedCandidatesMode(project, policy) === "on" ? unifiedPick(db, project, now, old, unifiedCaps(policy)).candidates : [...old]),
  }, trains);
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
interface Note { taskId: string; key: string; action: string; data: Record<string, unknown> }
/** Notes this process already wrote: one ledger child per new fact, not one per pass (the ledger's dedup key covers a restart). */
const noted = new Set<string>();
const short = (s: string | null) => (s ?? "").slice(0, 12) || "-";

function pickNotes(pick: UnifiedPick): Note[] {
  const notes: Note[] = [];
  for (const c of pick.candidates) {
    const b = bindingOf(c);
    if (!b) continue;
    const cls = b.source === "manual" ? "manual" : "ui";
    notes.push({ taskId: c.taskId, key: `cand:${cls}:${short(c.head)}:${b.requestSeq ?? "-"}`,
      action: `把${cls === "manual" ? `人工合并请求 #${b.requestSeq} 的卡` : " ui 卡"} ${c.taskId} @ ${short(c.head)} 列为列车候选`,
      data: { class: cls, head: c.head, requestSeq: b.requestSeq, ui: b.ui } });
  }
  for (const r of pick.rejected) {
    notes.push({ taskId: r.taskId, key: `rej:${r.code}:${short(r.head)}:${r.requestSeq ?? "-"}`,
      action: `不把 ${r.taskId} 列为列车候选（${r.code}）：${r.why}`.slice(0, 500),
      data: { class: "rejected", code: r.code, head: r.head, requestSeq: r.requestSeq } });
  }
  return notes;
}

/** The batch on would form now and the due manual head's way through it; none while a train is live or the tick read no files. */
async function batchNote(db: Database, project: string, pick: UnifiedPick, trains: TrainStore | null, policy: RecoveryPolicyPort, now: number): Promise<Note | null> {
  const files = unifiedFiles(db), live = trains?.load(project) ?? null;
  if (!files || (live && live.phase !== "done") || trainMode(project) !== "on") return null;
  const batch = await predictBatch(project, schedulerV2Unskipped(db, pick.candidates), files, nextSkip(live), () => now);
  if (!batch.length) return null;
  const turn = manualQueueMode(project, policy) === "on" ? manualTurn(db, project, "none", now) : { kind: "none" as const };
  const head = turn.kind === "due" ? turn.req.seq : null, rides = head !== null && batch.some((m) => bindingOf(m)?.requestSeq === head);
  const yields = turn.kind === "active" ? `人工合并 ${turn.req.taskId} 在跑，不组车`
    : head === null ? "没有到期的人工队首，不涉及让路"
    : rides ? `到期人工队首 #${head} 入车，formFence 不再挡这辆车` : `到期人工队首 #${head} 未入车，按旧规则先服务它，不组车`;
  const members = batch.map((m) => ({ taskId: m.taskId, head: m.head, source: bindingOf(m)?.source ?? "auto", ui: bindingOf(m)?.ui ?? false,
    requestSeq: bindingOf(m)?.requestSeq ?? null }));
  return { taskId: batch[0]!.taskId, key: `batch:${Bun.hash(members.map((m) => `${m.taskId}:${m.head}:${m.requestSeq}`).join(",") + `|${head}`).toString(36)}`,
    action: `组车 ${batch.length} 张：${batch.map((m) => m.taskId).join("、")}；${yields}`.slice(0, 500),
    data: { class: "batch", members, manualHead: head, headRides: rides, wouldForm: turn.kind !== "active" && (head === null || rides) } };
}

/**
 * observe's record, after the pass's manual claim step (the ledger child is the pass manager: lease-guarded, skip cards held).
 * Nothing here changes what the pass does or reports: a note the ledger refuses (a project without auto dispatch) or a
 * prediction that could not be computed is logged once and not asked again by this process.
 */
export async function observeUnifiedCandidates(db: Database, manager: Manager, project: string, trains: TrainStore | null,
  policy: RecoveryPolicyPort = recoveryPolicy, now: number = Date.now()): Promise<void> {
  if (unifiedCandidatesMode(project, policy) !== "observe") return;
  try {
    const pick = db.transaction(() => unifiedPick(db, project, now, mergeCandidates(db, project, null), unifiedCaps(policy)))();
    const batch = await batchNote(db, project, pick, trains, policy, now);
    for (const n of [...pickNotes(pick), ...(batch ? [batch] : [])]) {
      const seen = `${db.filename}\0${project}\0${n.taskId}\0${n.key}`;
      if (noted.has(seen)) continue;
      const r = await manager("ledger", "scheduler-recovery-observe", n.taskId, "--mechanism", UNIFIED_CANDIDATES_KEY, "--action-key", n.key,
        "--action", n.action, "--data", JSON.stringify(n.data));
      if (r.held === true) continue; // a skip / paused card: nothing written, asked again next pass
      if (r.ok !== true) console.error(`⚠️ [merge-candidates] ${project} ${n.taskId} 的观察记录没写上（不再重试，不影响本轮）：${String(r.error ?? "manager failed")}`);
      if (noted.size >= 2000) noted.clear();
      noted.add(seen);
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass
    console.error(`⚠️ [merge-candidates] ${project} 统一候选观察没算完（不影响本轮合并）：${(e as Error).message}`);
  }
}
