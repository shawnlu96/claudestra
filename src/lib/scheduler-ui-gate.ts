/**
 * The before / after screenshot gate of a UI card. By default PM accepts it (`ledger ui-approve` / `ui-reject`, decision events);
 * a card marked ownerVisual (global look: palette, theme tokens, redesign) still needs the owner's authorized ask. Every record
 * counts only when bound to the card's current head / specRev / digest (PM's also to the round) and written by someone allowed
 * to: a manager other than the team dispatcher. Observe reads these without opening anything. Docs: docs/architecture/scheduler-ui-gate.md.
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, ownerAnswered } from "./ledger-asks.js";
import { isManager } from "./ledger-checks.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { projectPmUiGate, rejectFix, type PmUiGate, type UiFix } from "./ledger-ui-approve-verdict.js";
import { SRC_DIR } from "./repo-root.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { currentReviewFacts } from "./scheduler-review.js";

export const UI_ASK_ACTION = "scheduler_ui_screenshot";
/** Receipt prefix of an ask intent that notified PM instead of opening an owner ask. */
const PM_NOTICE_RECEIPT = "pm_notice";
export const DIGEST_RE = /^[a-f0-9]{64}$/i;

type UiGate = PlannerSnapshot["uiGate"];
type Planned = Extract<PlannerDecision, { kind: "intent" }>;

function boundTo(params: unknown): { task: unknown; head?: string; specRev?: number; screenshotsDigest?: string } {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  return { task: p.task, ...(typeof p.head === "string" ? { head: p.head } : {}),
    ...(typeof p.specRev === "number" ? { specRev: p.specRev } : {}),
    ...(typeof p.screenshotsDigest === "string" ? { screenshotsDigest: p.screenshotsDigest } : {}) };
}

/** The newest live screenshot ask decides; the planner then checks its head / specRev / digest against the card. */
export function projectUiGate(db: Database, task: LedgerTask, now: number): UiGate {
  const rows = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' ORDER BY createdAt DESC, id DESC LIMIT 20`)
    .all(task.id) as { id: string }[];
  for (const { id } of rows) {
    const ask = getAsk(db, id);
    const from = ask?.fromAgent;
    if (!ask?.bind || ask.bind.action !== UI_ASK_ACTION || !from || ask.state === "superseded") continue;
    if (from !== "scheduler" && !isManager(db, from, task)) continue;
    const { task: boundTask, ...bound } = boundTo(ask.bind.params);
    if (boundTask !== task.id) continue;
    if (ask.expiresAt <= now || (ask.state !== "open" && ask.state !== "answered")) return { state: "none" };
    if (ask.state === "open") return { state: "open", ...bound };
    const check = checkAsk(ask, bindHash(ask.bind, from), from, now);
    return check.ok ? { state: "approved", ...bound, ownerVerified: ownerAnswered(ask.answer) } : { state: "rejected", ...bound };
  }
  return { state: "none" };
}

/**
 * Whether the card needs the owner. The one persistent place is `extra.ownerVisual` (autostart claim, task-new / task-set,
 * `ui-owner-visual`), read from the task writes that name the key: an extra rewritten for other fields (new screenshots) leaves
 * it as it was. The scheduler and managers set it either way; anyone else (an executor's task-set) can raise it, never clear it.
 */
export function ownerVisualOf(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  let on = false;
  for (const e of events) {
    if (e.kind !== "task" || (e.data.op !== "new" && e.data.op !== "set")) continue;
    const extra = (e.data.patch as { extra?: unknown } | undefined)?.extra;
    if (!extra || typeof extra !== "object" || !("ownerVisual" in extra)) continue;
    const value = (extra as Record<string, unknown>).ownerVisual === true;
    on = e.actor === "scheduler" || actorMayConfigure(db, e.actor, task.project) ? value : on || value;
  }
  return on;
}

type Card = Pick<PlannerSnapshot, "task" | "screenshotsDigest">;
const ownerBound = (s: Card, g: UiGate): boolean =>
  g.head === s.task.headSHA && g.specRev === s.task.specRev && g.screenshotsDigest === s.screenshotsDigest;
const pmBound = (s: Card, g: PmUiGate | undefined): g is PmUiGate =>
  !!g && g.state !== "none" && g.head === s.task.headSHA && g.specRev === s.task.specRev && g.round === s.task.round &&
  g.screenshotsDigest === s.screenshotsDigest;

export type UiPassStep =
  | { kind: "merge" } | { kind: "ask_owner" } | { kind: "notify_pm" } | { kind: "fix"; note: string; seq: number }
  | { kind: "wait" | "escalate"; code: string; reason: string };

/** After a passing review of a UI card: who looks at the screenshots, and what their current answer means. */
export function uiPassStep(s: PlannerSnapshot, node: string, reviewSeq: number): UiPassStep {
  if (!s.screenshotsDigest || !DIGEST_RE.test(s.screenshotsDigest)) {
    return { kind: "escalate", code: "ui_missing_screenshots", reason: "前后截图摘要缺失，不能请人看旧图" };
  }
  const pm = pmBound(s, s.pmUiGate) ? s.pmUiGate : null;
  if (pm?.state === "rejected") return { kind: "fix", note: pm.note ?? "PM 未通过前后截图", seq: pm.seq ?? reviewSeq };
  const owner = s.uiGate;
  const asks = s.intents.filter((i) => i.node === node && i.action === "ask" && i.causalSeq >= reviewSeq);
  // A notice counts only for the head and screenshots PM was shown; new screenshots after the same pass get a new notice.
  const pmNoticed = asks.some((i) => i.status === "done" && i.head === s.task.headSHA && i.receipt?.startsWith(PM_NOTICE_RECEIPT) &&
    i.receipt.endsWith(noticeTag(s.screenshotsDigest as string)));
  if (s.ownerVisual) {
    if (owner.state !== "none" && !ownerBound(s, owner)) return { kind: "escalate", code: "ui_stale", reason: "截图许可绑定的 head/specRev 已过期" };
    if (owner.state === "rejected") return { kind: "escalate", code: "ui_rejected", reason: "owner 未批准前后截图" };
    if (owner.state === "open") return { kind: "wait", code: "owner_screenshot", reason: "等待 owner 看前后截图" };
    if (owner.state === "approved") {
      return owner.ownerVerified ? { kind: "merge" } : { kind: "escalate", code: "ui_unverified", reason: "截图许可缺已认证的 owner 答复" };
    }
    const sent = asks.findLast((i) => !i.receipt?.startsWith(PM_NOTICE_RECEIPT));
    return sent?.status === "done" ? { kind: "wait", code: "owner_screenshot", reason: "截图 ask 已发，等待 owner 答复入账" } : { kind: "ask_owner" };
  }
  // PM accepts. An owner ask opened before this rule still counts when the owner answers it; a stale or guest answer does not.
  if (ownerBound(s, owner) && owner.state === "rejected") return { kind: "escalate", code: "ui_rejected", reason: "owner 未批准前后截图" };
  if (ownerBound(s, owner) && owner.state === "approved" && owner.ownerVerified) return { kind: "merge" };
  if (pm?.state === "approved") return { kind: "merge" };
  return pmNoticed ? { kind: "wait", code: "pm_screenshot", reason: "等待 PM 看前后截图（ledger ui-approve / ui-reject）" } : { kind: "notify_pm" };
}

/** PM's rejection plus any code P1s as the fix package (take_order shares rejectFix through uiRejectFixFor). */
export const uiRejectFix = (s: PlannerSnapshot): UiFix | null =>
  rejectFix(s.task, s.workflow?.template, s.events, s.pmUiGate, currentReviewFacts(s.task, s.events));

/** Screenshot-only fixes need no code report; a combined fix must still pass the planner's P1 history / fallback rules. */
export function uiFixPackage(s: PlannerSnapshot, codeFix: () => NonNullable<Planned["workOrder"]> | PlannerDecision):
  NonNullable<Planned["workOrder"]> | PlannerDecision {
  const ui = uiRejectFix(s);
  if (!ui) return codeFix();
  if (!ui.codeReportPath) return ui;
  const code = codeFix();
  return "kind" in code ? code : { ...ui, fallbackWarning: code.fallbackWarning };
}

/** Planner side of the merge gate: why this UI card may not merge yet, or null. */
export function uiMergeBlock(s: PlannerSnapshot): string | null {
  if (!s.screenshotsDigest || !DIGEST_RE.test(s.screenshotsDigest)) return "前后截图摘要缺失";
  const owner = s.uiGate.state === "approved" && s.uiGate.ownerVerified === true && ownerBound(s, s.uiGate);
  if (s.ownerVisual) return owner ? null : "本卡要 owner 看截图：缺与当前 head/specRev/摘要相符的 owner 认证答复";
  return owner || (pmBound(s, s.pmUiGate) && s.pmUiGate.state === "approved") ? null : "缺与当前 head/specRev/轮次/摘要相符的 PM 截图验收";
}

/** The merge write's own check, inside its transaction: re-read from the ledger, never from the plan. Null = may merge. */
export function uiMergeRefusal(db: Database, task: LedgerTask, now: number): string | null {
  const digest = task.extra.screenshotsDigest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return "UI 前后截图摘要缺失";
  const params = { task: task.id, specRev: task.specRev, head: task.headSHA, screenshotsDigest: digest };
  const rows = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' AND state = 'answered'
    ORDER BY updatedAt DESC LIMIT 20`).all(task.id) as { id: string }[];
  const owner = rows.some(({ id }) => {
    const ask = getAsk(db, id);
    if (!ask || ask.fromAgent !== "scheduler" || ask.bind?.action !== UI_ASK_ACTION || !ownerAnswered(ask.answer)) return false;
    return checkAsk(ask, bindHash({ ...ask.bind, params }, "scheduler"), "scheduler", now).ok;
  });
  if (owner) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  if (ownerVisualOf(db, task, events)) return "缺同 head/specRev/摘要的 owner 截图授权（本卡要 owner 看截图）";
  const pm = projectPmUiGate(db, task, events);
  return pm.state === "approved" && pmBound({ task, screenshotsDigest: digest }, pm) ? null : "缺同 head/specRev/轮次/摘要的 PM 截图验收或 owner 截图授权";
}

type Settle = (from: "pending" | "submitted", to: "submitted" | "done", receipt: string) => Promise<boolean>;
const noticeTag = (digest: string): string => `；digest=${digest}`;
const LEDGER_CLI = `bun ${SRC_DIR}/manager.ts ledger`;

/** What PM gets instead of an owner ask: the images, the digest, and the two commands bound to this head. */
function pmUiNoticeText(task: LedgerTask, n: NonNullable<Planned["pmNotice"]>, refs: readonly string[]): string {
  return [`[调度引擎] ${task.id} 审查已通过，请看前后截图（ui 卡由 PM 验收；只有改整体观感的卡才问 owner）`,
    `head ${n.head}，规格第 ${n.specRev} 版，第 ${n.round} 轮`, "截图：", ...refs.map((r) => `- ${r}`), `截图摘要：${n.screenshotsDigest}`,
    `通过：${LEDGER_CLI} ui-approve ${task.id} --head ${n.head} --digest ${n.screenshotsDigest}`,
    `不通过：${LEDGER_CLI} ui-reject ${task.id} --text "<意见>"（卡退回 fix，意见进修复单）`].join("\n");
}

/**
 * The notice is the intent's effect: it settles only after a delivered send, so a failed send leaves it pending for the next pass.
 * Both receipts carry the digest PM was shown; the planner matches it against the card (a new screenshot set = a new notice).
 */
export async function pmUiNotice(task: LedgerTask, n: NonNullable<Planned["pmNotice"]>, refs: readonly string[],
  notify: (task: LedgerTask, text: string) => Promise<void>, settle: Settle): Promise<string> {
  try {
    await notify(task, pmUiNoticeText(task, n, refs));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `截图验收通知没发出去，下轮重发：${(e as Error).message}`;
  }
  const tag = noticeTag(n.screenshotsDigest);
  if (!(await settle("pending", "submitted", `${PM_NOTICE_RECEIPT}${tag}`))) return `${PM_NOTICE_RECEIPT} 已发，意图没认领上（下轮会重发一次）`;
  return (await settle("submitted", "done", `${PM_NOTICE_RECEIPT}：已通知项目 PM${tag}`)) ? `${PM_NOTICE_RECEIPT} 已发` : `${PM_NOTICE_RECEIPT} 已发，意图没结上（下轮补结）`;
}

/**
 * A stage / ask intent past pending. A notice left submitted (sent, but the done write was lost or the service stopped in
 * between) is finished here without sending again; anything else is held, as before.
 */
export async function pmNoticeResume(intent: SchedulerIntent, settle: Settle): Promise<[string, string]> {
  const r = intent.receipt ?? "";
  if (intent.action !== "ask" || intent.status !== "submitted" || !r.startsWith(`${PM_NOTICE_RECEIPT}；`)) {
    return ["held", `${intent.action} 意图停在 ${intent.status}`];
  }
  const ok = await settle("submitted", "done", `${PM_NOTICE_RECEIPT}：已通知项目 PM${r.slice(PM_NOTICE_RECEIPT.length)}`);
  return ["ask", ok ? `${PM_NOTICE_RECEIPT} 补结` : `${PM_NOTICE_RECEIPT} 补结没成（下轮再试）`];
}
