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
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { SRC_DIR } from "./repo-root.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import type { ReviewFinding } from "./scheduler-review.js";

export const UI_ASK_ACTION = "scheduler_ui_screenshot";
export const UI_APPROVED = "ui_approved", UI_REJECTED = "ui_rejected", UI_OWNER_VISUAL = "ui_owner_visual";
/** Receipt prefix of an ask intent that notified PM instead of opening an owner ask. */
const PM_NOTICE_RECEIPT = "pm_notice";
export const DIGEST_RE = /^[a-f0-9]{64}$/i;

type UiGate = PlannerSnapshot["uiGate"];
type Planned = Extract<PlannerDecision, { kind: "intent" }>;
export interface PmUiGate { state: "none" | "approved" | "rejected"; head?: string; specRev?: number; round?: number; screenshotsDigest?: string; seq?: number; note?: string }

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
 * Whether the card needs the owner. Only the scheduler (autostart claim) and managers set it, through the card's extra or
 * `ui-owner-visual`; anyone else (the executor rewriting extra with task-set) can raise it, never clear it.
 */
export function ownerVisualOf(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  let on = false;
  for (const e of events) {
    let value: boolean;
    let trusted: boolean;
    if (e.kind === "task" && (e.data.op === "new" || e.data.op === "set")) {
      const extra = (e.data.patch as { extra?: unknown } | undefined)?.extra;
      if (!extra || typeof extra !== "object") continue;
      value = (extra as Record<string, unknown>).ownerVisual === true;
      trusted = e.actor === "scheduler" || actorMayConfigure(db, e.actor, task.project);
    } else if (e.kind === "decision" && e.data.op === UI_OWNER_VISUAL && typeof e.data.on === "boolean") {
      value = e.data.on;
      trusted = actorMayConfigure(db, e.actor, task.project);
      if (!trusted) continue;
    } else continue;
    on = trusted ? value : on || value;
  }
  return on;
}

/** PM's newest screenshot verdict on this card, from a manager; the planner checks its binding against the card. */
export function projectPmUiGate(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): PmUiGate {
  const e = events.findLast((x) => x.kind === "decision" && (x.data.op === UI_APPROVED || x.data.op === UI_REJECTED) &&
    actorMayConfigure(db, x.actor, task.project));
  if (!e) return { state: "none" };
  const d = e.data;
  return { state: d.op === UI_APPROVED ? "approved" : "rejected", seq: e.seq,
    ...(typeof d.head === "string" ? { head: d.head } : {}), ...(typeof d.specRev === "number" ? { specRev: d.specRev } : {}),
    ...(typeof d.round === "number" ? { round: d.round } : {}),
    ...(typeof d.screenshotsDigest === "string" ? { screenshotsDigest: d.screenshotsDigest } : {}),
    ...(typeof d.note === "string" ? { note: d.note } : {}) };
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
  const pmNoticed = asks.some((i) => i.status === "done" && i.receipt?.startsWith(PM_NOTICE_RECEIPT));
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

/**
 * The fix order after PM's ui-reject: PM's words are the one P1 finding. Only the rejection that sent this round to fix counts
 * (same round, recorded before the review→fix move); the executor may already be re-shooting, so head / digest are not compared.
 */
export function uiRejectFix(s: PlannerSnapshot): { reportPath: string; findings: ReviewFinding[]; fallbackWarning: null } | null {
  const g = s.pmUiGate;
  if (s.workflow?.template !== "ui" || s.task.stage !== "fix" || g?.state !== "rejected" || g.round !== s.task.round || g.seq === undefined) return null;
  const entered = s.events.findLast((e) => e.kind === "stage" && e.data.to === "fix");
  if (!entered || entered.data.from !== "review" || entered.seq < g.seq) return null;
  return { reportPath: `台账事件 #${g.seq}（PM 截图验收意见：${s.task.id}）`, fallbackWarning: null,
    findings: [{ findingId: `ui-screenshot-${g.seq}`, family: "ui_screenshot", severity: "P1", probe: g.note ?? "PM 未通过前后截图" }] };
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
const LEDGER_CLI = `bun ${SRC_DIR}/manager.ts ledger`;

/** What PM gets instead of an owner ask: the images, the digest, and the two commands bound to this head. */
function pmUiNoticeText(task: LedgerTask, n: NonNullable<Planned["pmNotice"]>, refs: readonly string[]): string {
  return [`[调度引擎] ${task.id} 审查已通过，请看前后截图（ui 卡由 PM 验收；只有改整体观感的卡才问 owner）`,
    `head ${n.head}，规格第 ${n.specRev} 版，第 ${n.round} 轮`, "截图：", ...refs.map((r) => `- ${r}`), `截图摘要：${n.screenshotsDigest}`,
    `通过：${LEDGER_CLI} ui-approve ${task.id} --head ${n.head} --digest ${n.screenshotsDigest}`,
    `不通过：${LEDGER_CLI} ui-reject ${task.id} --text "<意见>"（卡退回 fix，意见进修复单）`].join("\n");
}

/** The notice is the intent's effect: it settles only after a delivered send, so a failed send leaves it pending for the next pass. */
export async function pmUiNotice(task: LedgerTask, n: NonNullable<Planned["pmNotice"]>, refs: readonly string[],
  notify: (task: LedgerTask, text: string) => Promise<void>, settle: Settle): Promise<string> {
  try {
    await notify(task, pmUiNoticeText(task, n, refs));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `截图验收通知没发出去，下轮重发：${(e as Error).message}`;
  }
  const ok = await settle("pending", "submitted", PM_NOTICE_RECEIPT) && await settle("submitted", "done", `${PM_NOTICE_RECEIPT}：已通知项目 PM`);
  return ok ? `${PM_NOTICE_RECEIPT} 已发` : `${PM_NOTICE_RECEIPT} 已发，意图没结上（下轮可能重发一次）`;
}
