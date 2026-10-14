/**
 * UIOWNCARRY1: on an ownerVisual card the owner's screenshot approval survives the scheduler's own update-branch carry (review_carry)
 * under the same conditions as PM's acceptance does in UIR1 (scheduler-ui-review-carry.ts): the approval is the card's newest
 * scheduler screenshot ask, answered by the authenticated owner, unexpired, approve button, bind intact and bound to the card's
 * specRev / digest; it sits on the carry's `from` or reaches it through earlier owner carries; the render inputs (renderInputs, read in
 * the temp repo where uiCarryPlan re-ran the canonical proof) of the approved, old and new heads are identical. The trusted record is
 * the scheduler's `ui_review_carry` at carrySeq + 2 (right after the carry's merge_phase, uiReviewCarryKey) with `ask` = the ask id,
 * `approvedHead` = the head it is bound to, `approvalSeq: null` (so PM's reader reviewCarryPaired never takes it) and
 * mechanism uiOwnerCarry. The planner (projectUiGate) and the merge write (uiMergeRefusal) both accept it only through ownerCarriedAsk.
 * PM's manual update-branch or an executor push writes no review_carry, so it breaks the chain. Switch `uiOwnerCarry` (recovery-keys.ts):
 * on = write + gate, observe = as off plus one observation per carry, off = as before. tests/scheduler-ui-owner-carry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, ownerAnswered, type Ask } from "./ledger-asks.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { insertEvent } from "./ledger-tx.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { GitRead } from "./scheduler-ui-carry-proof.js";
import { renderInputs, uiReviewCarryKey } from "./scheduler-ui-review-carry.js";
import type { CarryEvidence } from "./scheduler-merge.js";

const KEY = "uiOwnerCarry";
const CARRY_OP = "ui_review_carry"; // the one trusted carry record (scheduler-ui-review-carry.ts), told apart by `ask` / mechanism
const UI_ASK_ACTION = "scheduler_ui_screenshot"; // scheduler-ui-merge-refusal.ts UI_ASK_ACTION (that leaf imports this one)
/** The merge_phase note prefix of a refused owner carry; uiMergeBlock quotes it in merge_ui_unapproved. */
const OWNER_CARRY_REFUSED = "owner 截图批准不沿用：";
const OWNER_RESHOOT = "要 PM 在新 head 重拍截图，再由调度器请 owner 看";

/** Read every time; an unreadable file / unknown key / throwing port is off. */
export function uiOwnerCarryMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}

const own = (e: LedgerEvent | undefined, op: string): e is LedgerEvent => e?.kind === "scheduler" && e.actor === "scheduler" && e.data.op === op;
const boundOf = (a: Ask): Record<string, unknown> => (a.bind?.params && typeof a.bind.params === "object" ? a.bind.params : {}) as Record<string, unknown>;

/** The card's newest scheduler screenshot ask (projectUiGate's order), superseded ones skipped. */
function newestAsk(db: Database, task: LedgerTask): Ask | null {
  const ids = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' AND fromAgent = 'scheduler'
    ORDER BY createdAt DESC, id DESC`).all(task.id) as { id: string }[];
  for (const { id } of ids) {
    const a = getAsk(db, id);
    if (a?.bind?.action === UI_ASK_ACTION && a.state !== "superseded" && boundOf(a).task === task.id) return a;
  }
  return null;
}

/** The head the owner approved, or why the approval does not hold now (expired / rejected / not the owner / other specRev or digest). */
function approvedHead(a: Ask | null, task: LedgerTask, now: number): { head: string } | { why: string } {
  if (!a) return { why: "没有调度器发的 owner 截图 ask" };
  const p = boundOf(a), digest = task.extra.screenshotsDigest;
  if (a.state !== "answered") return { why: `最新 owner 截图 ask 是 ${a.state}` };
  if (!ownerAnswered(a.answer)) return { why: "最新截图 ask 的答复不是已认证的 owner" };
  const check = checkAsk(a, bindHash(a.bind!, "scheduler"), "scheduler", now);
  if (!check.ok) return { why: `owner 截图 ask 不算批准（${check.reason.slice(0, 120)}）` };
  if (p.specRev !== task.specRev || typeof digest !== "string" || p.screenshotsDigest !== digest) return { why: "owner 批准没绑在本规格 / 卡上摘要" };
  return typeof p.head === "string" && /^[a-f0-9]{40}$/.test(p.head) ? { head: p.head } : { why: "owner 截图 ask 没绑完整 head" };
}

/** The scheduler's owner carry record for carry `c`, bound to that very carry and to ask `a` on `head`. */
function paired(c: LedgerEvent, bySeq: Map<number, LedgerEvent>, task: LedgerTask, a: Ask, head: string): boolean {
  const phase = bySeq.get(c.seq + 1), u = bySeq.get(c.seq + 2), d = u?.data;
  return own(u, CARRY_OP) && own(phase, "merge_phase") && phase.data.carrySeq === c.seq && phase.data.intentId === c.data.intentId &&
    u.dedupKey === uiReviewCarryKey(String(c.data.intentId), c.seq) && d!.mechanism === KEY && d!.carrySeq === c.seq &&
    d!.intentId === c.data.intentId && d!.from === c.data.from && d!.to === c.data.to && d!.mainParent === c.data.mainParent &&
    d!.mainHead === c.data.mainHead && d!.diffHash === c.data.diffHash && d!.specRev === c.data.specRev && d!.specRev === task.specRev &&
    d!.digest === task.extra.screenshotsDigest && d!.ask === a.id && d!.approvedHead === head && d!.approvalSeq === null &&
    typeof d!.renderInputs === "string" && /^[a-f0-9]{64}$/.test(d!.renderInputs);
}

/** From the approved head, hop along the scheduler's review_carry events that each carry their paired owner record. */
function chainEnd(task: LedgerTask, events: readonly LedgerEvent[], a: Ask, head: string): string {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  let at = head;
  for (const c of events) if (own(c, "review_carry") && c.data.from === at && paired(c, bySeq, task, a, head)) at = String(c.data.to);
  return at;
}

/**
 * THE pairing function, shared by the planner (scheduler-ui-gate.ts projectUiGate) and the merge write (scheduler-ui-merge-refusal.ts
 * uiMergeRefusal): the owner-approved newest scheduler ask whose approval still holds now and was carried, hop by hop, by the
 * scheduler's own update-branch to the card's current head. Only while uiOwnerCarry is on; ownerVisual is the caller's to check.
 */
export function ownerCarriedAsk(db: Database, task: LedgerTask, events: readonly LedgerEvent[], now: number, policy?: RecoveryPolicyPort): Ask | null {
  if (uiOwnerCarryMode(task.project, policy) !== "on" || !task.headSHA) return null;
  const a = newestAsk(db, task), held = approvedHead(a, task, now);
  if (!a || !("head" in held) || held.head === task.headSHA) return null;
  return chainEnd(task, events, a, held.head) === task.headSHA ? a : null;
}

export interface OwnerCarryInput { task: LedgerTask; intentId: string; ev: CarryEvidence; ownerVisual: boolean; events: readonly LedgerEvent[];
  read: (() => GitRead) | string; now: number }
/** carried: on and every condition holds (uiCarryPlan then drops the other layers' notes and commits this first, at carrySeq + 2). */
export interface OwnerCarryPlan { carried: boolean; note: string | null; commit: (carrySeq: number) => void }
const NONE: OwnerCarryPlan = { carried: false, note: null, commit: () => {} };

/** Judged inside the carry's transaction before the head moves, in uiCarryPlan's temp repo. Never throws. Not ownerVisual: NONE. */
export function uiOwnerCarryPlan(db: Database, x: OwnerCarryInput, policy?: RecoveryPolicyPort): OwnerCarryPlan {
  const mode = uiOwnerCarryMode(x.task.project, policy);
  if (mode === "off" || !x.ownerVisual) return NONE;
  const { task, ev } = x, a = newestAsk(db, task), held = approvedHead(a, task, x.now);
  const base = { intentId: x.intentId, from: ev.oldHead, to: ev.newHead, specRev: task.specRev, ask: a?.id ?? null,
    approvedHead: "head" in held ? held.head : null };
  const observe = (carried: boolean, action: string, data: Record<string, unknown>): OwnerCarryPlan => ({ carried: false, note: null,
    commit: () => void recordObserved(db, { project: task.project, mechanism: KEY, target: task.id, actionKey: `ui-owner-carry:${ev.newHead}`,
      action, data: { ...base, ...data, carried } }, x.now) });
  const refuse = (why: string, renderSame: boolean | null = null): OwnerCarryPlan => {
    const note = `${OWNER_CARRY_REFUSED}${why}，${OWNER_RESHOOT}（新 head ${ev.newHead.slice(0, 12)}）`.slice(0, 500);
    return mode === "on" ? { carried: false, note, commit: () => {} } : observe(false, `不沿用 owner 截图批准：${why}`, { renderSame, why });
  };
  if (!a || !("head" in held)) return refuse("why" in held ? held.why : "没有 owner 批准");
  if (held.head !== ev.oldHead && chainEnd(task, x.events, a, held.head) !== ev.oldHead) {
    return refuse("owner 批准的 head 到原 head 之间不是调度器的可信沿用链（PM 手动更新分支或执行者推了新提交）");
  }
  const globs = task.extra.fileGlobs ?? [];
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return refuse("卡上 fileGlobs 不是字符串列表");
  let inputs: { approved: string; from: string; to: string; count: number };
  try {
    if (typeof x.read === "string") throw new Error(x.read);
    const read = x.read(), at = (h: string) => renderInputs(read, h, globs as string[]);
    const approved = at(held.head), from = held.head === ev.oldHead ? approved : at(ev.oldHead), to = at(ev.newHead);
    inputs = { approved: approved.digest, from: from.digest, to: to.digest, count: to.count };
  } catch (e) { return refuse(`渲染输入核不了（${(e as Error).message.split("\n")[0]!.slice(0, 160)}）`); }
  if (inputs.approved !== inputs.to || inputs.from !== inputs.to) return refuse("main 改了界面输入（web/、资源、依赖与构建配置或本卡 fileGlobs）", false);
  const data = { ...base, approvalSeq: null, mechanism: KEY, round: task.round, digest: task.extra.screenshotsDigest, renderInputs: inputs.to,
    renderCount: inputs.count, mainParent: ev.mainParent, mainHead: ev.mainHead, diffHash: ev.diffHash };
  if (mode === "observe") return observe(true, `沿用 owner 截图批准到 ${ev.newHead.slice(0, 12)}（渲染输入 ${inputs.count} 项与批准时一致）`, { ...data, renderSame: true });
  return { carried: true, note: null, commit: (carrySeq) => void insertEvent(db, { actor: "scheduler", now: x.now, dedupKey: uiReviewCarryKey(x.intentId, carrySeq) }, {
    project: task.project, target: task.id, kind: "scheduler", text: `沿用 owner 截图批准到新 head ${ev.newHead.slice(0, 12)}（渲染输入与批准时一致）`,
    data: { op: CARRY_OP, ...data, carrySeq } }, true) };
}

/**
 * uiMergeBlock's reason under on, for an ownerVisual card whose owner approval sits on an older head: the newest carry's refusal note
 * (render inputs changed, ask expired …) when there is one. Null = the reason as before.
 */
export function ownerCarryBlock(task: LedgerTask, events: readonly LedgerEvent[], gate: { state: string; head?: string; ownerVerified?: boolean },
  policy?: RecoveryPolicyPort): string | null {
  if (gate.state !== "approved" || gate.ownerVerified !== true || !gate.head || gate.head === task.headSHA) return null;
  if (uiOwnerCarryMode(task.project, policy) !== "on") return null;
  const note = events.findLast((e) => own(e, "merge_phase") && typeof e.data.carrySeq === "number")?.data.note;
  const hit = typeof note === "string" ? note.split("；").find((n) => n.startsWith(OWNER_CARRY_REFUSED)) : undefined;
  return hit ?? `${OWNER_CARRY_REFUSED}owner 批准绑在旧 head ${gate.head.slice(0, 12)}，没有调度器可信沿用到当前 head，${OWNER_RESHOOT}`;
}
