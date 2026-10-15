/**
 * Facts every manual recovery stands on (RECBASE1), shared by MAN2 (manual-resume.ts) and the evidence mechanisms
 * (manual-recovery-release.ts): the card-side refusals, the manual entry it must still match and the authorization fingerprint.
 * Read-only; nothing here writes or decides a mode. Moving a check out of here changes both paths at once, which is the point.
 * tests/manual-resume*.test.ts, tests/manual-recovery-contract*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getFeature } from "./ledger-feature.js";
import type { TaskWorkflow } from "./ledger-scheduler.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getMeta, listEvents } from "./ledger-store.js";
import { listRequests, revokeOf, intentOf } from "./manual-merge-queue-facts.js";
import { manualEntry, type ManualEntry, type ManualReasonCode, type ManualReasonRecord } from "./manual-reason.js";
import { readSwitch, switchOff } from "./scheduler-autostart.js";
import { strayPoolOrders } from "./scheduler-pool-facts.js";
import { openSafetyHold } from "./scheduler-review-swap.js";

/** recordObserved's note op: observe notes never move a fingerprint, else every observe would void its own authorization. */
const OBSERVE_OP = "recovery_observe";
/** A person decides these (manual-reason.ts sticky); no evidence mechanism may ever lift them. */
const STICKY_CODES: readonly ManualReasonCode[] = ["safety_refusal", "owner_hold", "pm_hold", "pm_takeover", "foreign_repo"];

const uiDigest = (t: LedgerTask): string | null => (typeof t.extra.screenshotsDigest === "string" ? t.extra.screenshotsDigest : null);

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
  // a deploy journal still claimed / running / unknown is settled only by resolveDeployRun, never by cancelling the intent or unfreezing
  const deploys = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()
    ? db.query("SELECT intentId, phase FROM scheduler_deploys WHERE taskId = ? AND phase NOT IN ('deployed','resolved')").all(task.id) as
      { intentId: string; phase: string }[] : [];
  if (deploys.length) return `部署未正式结清（${deploys.map((d) => `${d.intentId}:${d.phase}`).join("、")}）`;
  const stray = strayPoolOrders(db, task.id);
  if (stray.length) return `池单还在外面（${stray.map((o) => o.orderId).join("、")}）`;
  const fake = events.find((e) => e.seq > entrySeq && e.kind === "review"
    && ((e.data.witness as { mismatch?: unknown[] } | undefined)?.mismatch?.length ?? 0) > 0);
  return fake ? `审查旁证对不上 #${fake.seq}` : null;
}

export type ManualBase = { ok: true; events: LedgerEvent[]; entry: ManualEntry & { record: ManualReasonRecord } } | { ok: false; why: string };

/**
 * The manual card as it entered: not terminal, still manual, a structured MAN1 entry that `admit` accepts, and no drift of spec /
 * head / UI since, with no card-side refusal. `admit` runs before the drift checks so a code nobody lifts says so first.
 */
export function manualBase(db: Database, task: LedgerTask, wf: TaskWorkflow | null, admit: (rec: ManualReasonRecord) => string | null, entryHead?: (task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number, rec: ManualReasonRecord) => string | null): ManualBase {
  if (TERMINAL_STAGES.includes(task.stage)) return { ok: false, why: `卡已 ${task.stage}` };
  if (wf?.mode !== "manual") return { ok: false, why: "workflow 不是 manual" };
  const events = listEvents(db, { project: task.project, target: task.id });
  const entry = manualEntry(events);
  if (!entry?.record) return { ok: false, why: entry ? "进 manual 时没有结构化理由（MAN1 之前的旧记录），交 PM" : "找不到进 manual 的事件" };
  const rec = entry.record;
  const refused = admit(rec);
  if (refused) return { ok: false, why: refused };
  if (rec.specRev !== task.specRev) return { ok: false, why: `规格已变（specRev ${rec.specRev}→${task.specRev}）` };
  if ((rec.head ?? null) !== (entryHead?.(task, events, entry.event.seq, rec) ?? task.headSHA ?? null)) return { ok: false, why: "head 已变" }; // PEERHEAD1：机制担保的 entry head
  if ((rec.uiDigest ?? null) !== uiDigest(task)) return { ok: false, why: "UI 截图摘要已变" };
  const block = cardBlock(db, task, events, entry.event.seq);
  return block ? { ok: false, why: block } : { ok: true, events, entry: { ...entry, record: rec } };
}

/**
 * Extra refusals for evidence mechanisms (MAN2 keeps its own narrower set): a PM / owner hold entry, a sticky code, or a manual merge
 * request still live (not revoked, no intent yet) — the request belongs to its own queue and recovery never takes it over.
 */
export function extensionBlock(db: Database, task: LedgerTask, entry: ManualEntry & { record: ManualReasonRecord }): string | null {
  if (entry.event.data.hold !== undefined) return `进 manual 的是 hold（#${entry.event.seq}），只由 PM 交回`;
  if (STICKY_CODES.includes(entry.record.code)) return `${entry.record.label}（${entry.record.code}）只由人解除`;
  const live = listRequests(db, task.project, task.id).filter((r) => !intentOf(db, r) && !revokeOf(db, r));
  return live.length ? `有活的人工合并请求（#${live.map((r) => r.seq).join("、#")}），不抢人工` : null;
}

/** Last fact seq on the card; observe notes do not count. */
export const lastFactSeq = (events: readonly LedgerEvent[]): number => events.findLast((e) => !(e.kind === "note" && e.data.op === OBSERVE_OP))?.seq ?? 0;

/**
 * Authorization: every fact the decision stood on; any drift (task / workflow rev, spec, head, round, UI, entry, new event) voids it.
 * `tail` carries the mechanism's own facts; MAN2 passes [deps], so its fingerprints stay byte-identical to before the extraction.
 */
export function factsFingerprint(task: LedgerTask, wf: TaskWorkflow, entrySeq: number, code: ManualReasonCode, events: readonly LedgerEvent[], tail: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([task.id, task.rev, wf.rev, task.specRev, task.headSHA ?? null, task.round,
    uiDigest(task), entrySeq, code, lastFactSeq(events), ...tail])).digest("hex").slice(0, 16);
}
