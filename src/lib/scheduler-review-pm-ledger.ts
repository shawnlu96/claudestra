/**
 * 审查已回待 PM 处置提醒（dispatch-recovery-RVWAKE1）台账侧：调度身份、带租约守卫的
 * `ledger scheduler-autostart review-pm <卡> record <实例键> --mode on|observe --pm <agent>` 与 `… review-pm <卡> sent <发送意图 seq> --mode on --pm <agent>`。
 * BEGIN IMMEDIATE 里重算 reviewPmCandidate：项目归调度管、开关、实例键（= 当前 head / 规格 / 轮次 / 审查 / 收件 PM）、--pm 都要和预读一致，
 * 否则 conflict、调度下一轮重判。正文与 dedup 键只在这里算，--text / --dedup 等一律拒。只写本卡 note（op review_pm_wait），不碰审查、阶段、审批、
 * 截图、请求、意图或合并槽。observe：每实例一条 would（review-pm-would:<卡>:<键>），不发。on：已有 review-pm-sent:<卡>:<键> 或上一条发送意图
 * 不满 30 分钟 → due:false；否则写第 n 条意图 review-pm-try:<卡>:<键>:<n> 回正文，调度发出后写 sent 确认（每实例一条）；没确认就 30 分钟后重试。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { busyAsLedgerError, getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { appendEvent } from "./ledger-write.js";
import { readSwitch, type ServiceFacts } from "./scheduler-autostart.js";
import { reviewPmCandidate } from "./scheduler-review-pm-wait.js";

export const REVIEW_PM_REPEAT_MS = 30 * 60_000;
export const REVIEW_PM_OP = "review_pm_wait";
export type ReviewPmMode = "on" | "observe" | "off";

/** 项目级开关 autostart.reviewPmWait，缺省 observe；不借 specWait / mergePmWait */
export const reviewPmMode = (db: Database, project: string): ReviewPmMode => readSwitch(db, project).reviewPmWait ?? "observe";

const dedupOf = (what: "would" | "sent", taskId: string, key: string) => `review-pm-${what}:${taskId}:${key}`;

/** 本实例的发送意图，按 seq 升序 */
const attemptsOf = (db: Database, taskId: string, key: string): LedgerEvent[] => listEvents(db, { target: taskId })
  .filter((e) => e.kind === "note" && e.actor === "scheduler" && e.data.op === REVIEW_PM_OP && e.data.kind === "try" && e.data.key === key);

/** observe 每实例记一次；on 确认送达就停，未确认时上一条意图满 30 分钟才再试 */
export function reviewPmDue(db: Database, taskId: string, key: string, mode: ReviewPmMode, now: number): boolean {
  if (mode === "observe") return !getEventByDedup(db, dedupOf("would", taskId, key));
  if (mode !== "on" || getEventByDedup(db, dedupOf("sent", taskId, key))) return false;
  const last = attemptsOf(db, taskId, key).at(-1);
  return last === undefined || now - last.ts >= REVIEW_PM_REPEAT_MS;
}

export type ReviewPmOut = { due: boolean; seq: number | null; to: string; text: string; key: string };

/** 送达确认：只认本卡本功能、发给同一 PM 的发送意图；此刻开关仍须是 on（off 零写） */
function ackInTx(db: Database, ctx: WriteCtx, taskId: string, project: string, ref: string, mode: string, pm: string, now: number): ReviewPmOut {
  const intent = listEvents(db, { target: taskId }).find((e) => e.seq === Number(ref));
  const ours = intent && intent.actor === "scheduler" && intent.kind === "note" && intent.data.op === REVIEW_PM_OP && intent.data.kind === "try";
  if (!ours || intent.data.pm !== pm || mode !== "on" || reviewPmMode(db, project) !== "on") {
    throw new LedgerError("conflict", `#${ref} 不是本卡发给 ${pm} 的审查已回提醒发送意图，或开关已不是 on`);
  }
  const key = String(intent.data.key);
  const r = appendEvent(db, { ...ctx, now, dedupKey: dedupOf("sent", taskId, key) },
    { project, target: taskId, kind: "note", text: `审查已回提醒已送达 ${pm}`, data: { op: REVIEW_PM_OP, kind: "sent", key, pm, try: intent.seq } });
  return { due: false, seq: r.duplicate ? null : r.event.seq, to: pm, text: "", key };
}

function recordInTx(db: Database, ctx: WriteCtx, pos: string[], mode: string, pm: string, svc: Pick<ServiceFacts, "projects">): ReviewPmOut {
  const [taskId, op, ref] = pos;
  const t = getTask(db, taskId);
  if (!t) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  if (!svc.projects.includes(t.project)) throw new LedgerError("forbidden", `项目 ${t.project} 不归调度服务管，不记审查已回提醒`);
  const now = ctx.now ?? Date.now();
  if (op === "sent") return ackInTx(db, ctx, t.id, t.project, ref, mode, pm, now);
  const c = reviewPmCandidate(db, t.id, now);
  if (reviewPmMode(db, t.project) !== mode || !c || c.key !== ref || c.pm !== pm) {
    throw new LedgerError("conflict", "审查已回提醒的条件已变（开关 / 阶段 / head / 规格 / 轮次 / 审查 / 收件 PM），这轮不记");
  }
  const out: ReviewPmOut = { due: false, seq: null, to: pm, text: c.text, key: c.key };
  if (!reviewPmDue(db, t.id, c.key, mode, now)) return out;
  const data = { op: REVIEW_PM_OP, key: c.key, mode, pm, head: c.head, specRev: c.specRev, round: c.round, reviewSeq: c.reviewSeq };
  if (mode === "observe") {
    const w = appendEvent(db, { ...ctx, now, dedupKey: dedupOf("would", t.id, c.key) },
      { project: t.project, target: t.id, kind: "note", text: `审查已回提醒（observe，本该发给 ${pm}）`, data: { ...data, kind: "would" } });
    return { ...out, seq: w.duplicate ? null : w.event.seq };
  }
  const n = attemptsOf(db, t.id, c.key).length + 1;
  const a = appendEvent(db, { ...ctx, now, dedupKey: `review-pm-try:${t.id}:${c.key}:${n}` },
    { project: t.project, target: t.id, kind: "note", text: `审查已回提醒第 ${n} 次发送意图（→ ${pm}）`, data: { ...data, kind: "try", n } });
  return { ...out, due: !a.duplicate, seq: a.duplicate ? null : a.event.seq };
}

const USAGE = "review-pm <卡> record <实例键> | sent <发送意图 seq> --mode on|observe --pm <agent>";

/** `scheduler-autostart review-pm` 的参数解析（manager/ledger-autostart-cmds.ts 只接线） */
export function reviewPmCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>,
  svc: Pick<ServiceFacts, "projects">): ReviewPmOut & { ok: true } {
  const stray = Object.keys(flags).filter((k) => flags[k] !== undefined && k !== "mode" && k !== "pm");
  if (stray.length || pos.length !== 3 || ctx.dedupKey !== undefined || (pos[1] !== "record" && pos[1] !== "sent")) {
    throw new LedgerError("invalid", `${USAGE}（正文与 dedup 键由调度算，不收 ${stray.map((k) => `--${k}`).join(" ") || "额外参数"}）`);
  }
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "审查已回提醒的记录只有调度服务能写");
  const mode = flags.mode ?? "", pm = flags.pm ?? "";
  if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
  return { ok: true, ...busyAsLedgerError("记审查已回提醒", () => db.transaction(() => recordInTx(db, ctx, pos, mode, pm, svc)).immediate()) };
}
