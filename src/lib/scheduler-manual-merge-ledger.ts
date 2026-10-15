/**
 * manual 卡代排人工合并（merge-arch-MANAUTOQ1）台账侧：调度身份、带租约守卫的
 * `ledger scheduler-autostart manual-merge <卡> request <指纹> --mode on|observe`，调度身份能写人工合并请求的唯一入口（不放宽 actorMayConfigure，
 * 不冒用 PM 作 actor）。BEGIN IMMEDIATE 里重算 manualMergeReadiness：项目归调度管、开关模式、全部条件与指纹都要和预读一致，否则 conflict、
 * 这一轮不写。on：推 review→merge（applyMove 以 pm 角色，同 applySchedulerStage 的事务内写法）→ 在推完之后的真实状态上经 recordSchedulerRequest
 * 记请求（requestRefusal 必须为 null，请求人 scheduler）→ 卡上一条代排 note（dedup manual-merge-auto:<卡>:<指纹>）；任何一步不过整笔回滚。
 * observe：不推阶段、不记请求，每个指纹 recordObserved 一条「本会代排」样本。同一指纹已代排过回 duplicate。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { busyAsLedgerError, getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, applyMove } from "./ledger-write.js";
import { recordSchedulerRequest } from "./manual-merge-queue.js";
import { recordObserved } from "./recovery-policy.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { manualMergeAutoMode, manualMergeReadiness, observeActionKey, type ManualMergeCandidate, type ReadyPorts } from "./scheduler-manual-merge-ready.js";

export const MANUAL_MERGE_AUTO_OP = "manual_merge_auto";
const autoNoteKey = (taskId: string, fingerprint: string): string => `manual-merge-auto:${taskId}:${fingerprint}`;

export type ManualMergeAutoOut =
  | { outcome: "requested"; request: number; note: number }
  | { outcome: "observed"; recorded: boolean; seq: number }
  | { outcome: "duplicate"; note: number };

const autoNoteText = (c: ManualMergeCandidate): string =>
  `调度器代排人工合并：依据审查 #${c.reviewSeq}（${c.reviewerFamily} ≠ 作者 ${c.authorFamily}），指纹 ${c.fingerprint.slice(0, 12)}`;

function requestInTx(db: Database, ctx: WriteCtx, taskId: string, fingerprint: string, mode: "on" | "observe",
  svc: Pick<ServiceFacts, "projects">, ports: ReadyPorts): ManualMergeAutoOut {
  const t = getTask(db, taskId);
  if (!t) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  if (!svc.projects.includes(t.project)) throw new LedgerError("forbidden", `项目 ${t.project} 不归调度服务管，不代排人工合并`);
  const now = ctx.now ?? Date.now();
  const done = getEventByDedup(db, autoNoteKey(t.id, fingerprint));
  if (done) return { outcome: "duplicate", note: done.seq };
  if (manualMergeAutoMode(t.project) !== mode) throw new LedgerError("conflict", `manualMergeAuto 已不是 ${mode}，这轮不写`);
  const c = manualMergeReadiness(db, t.id, now, ports);
  if ("why" in c) throw new LedgerError("conflict", `代排条件已变：${c.why}`);
  if (c.fingerprint !== fingerprint) throw new LedgerError("conflict", "代排绑定已变（rev / head / 规格 / 轮次 / 审查 / UI 摘要），这轮不写");
  if (mode === "observe") {
    const r = recordObserved(db, { project: t.project, mechanism: "manualMergeAuto", target: t.id, actionKey: observeActionKey(fingerprint),
      action: `代排人工合并 ${t.id}（审查 #${c.reviewSeq}，${c.reviewerFamily} ≠ 作者 ${c.authorFamily}）`,
      data: { reviewSeq: c.reviewSeq, reviewerFamily: c.reviewerFamily, authorFamily: c.authorFamily, uiDigest: c.uiDigest !== null, fingerprint } }, now);
    return { outcome: "observed", ...r };
  }
  const wctx: WriteCtx = { ...ctx, now, dedupKey: undefined };
  // 角色只喂合法性表；真正的闸是上面的事务内重判与下面推完之后的 requestRefusal
  applyMove(db, wctx, t, { from: "review", to: "merge" }, false, `manual 卡跨家族审查 #${c.reviewSeq} 通过，调度器代推 merge 并排人工合并`, "pm");
  const { request, duplicate } = recordSchedulerRequest(db, wctx, { taskId: t.id, head: c.head, specRev: c.specRev, round: c.round, reviewSeq: c.reviewSeq,
    ...(c.uiDigest !== null ? { uiDigest: c.uiDigest } : {}), reason: `调度器代排（MANAUTOQ1）：审查 #${c.reviewSeq} 跨家族 pass，指纹 ${fingerprint.slice(0, 12)}` });
  if (duplicate) throw new LedgerError("conflict", `卡已有同绑定的人工合并请求 #${request.seq}`);
  const note = appendEvent(db, { ...wctx, dedupKey: autoNoteKey(t.id, fingerprint) }, { project: t.project, target: t.id, kind: "note", text: autoNoteText(c),
    data: { op: MANUAL_MERGE_AUTO_OP, fingerprint, request: request.seq, reviewSeq: c.reviewSeq, reviewerFamily: c.reviewerFamily, authorFamily: c.authorFamily,
      head: c.head, specRev: c.specRev, round: c.round, uiDigest: c.uiDigest } });
  return { outcome: "requested", request: request.seq, note: note.event.seq };
}

const USAGE = "manual-merge <卡> request <指纹> --mode on|observe";

/** `scheduler-autostart manual-merge` 的参数解析（manager/ledger-autostart-cmds.ts 只接线）；ports 只给测试注入 */
export function manualMergeAutoCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>,
  svc: Pick<ServiceFacts, "projects">, ports: ReadyPorts = {}): ManualMergeAutoOut & { ok: true } {
  const stray = Object.keys(flags).filter((k) => flags[k] !== undefined && k !== "mode");
  if (stray.length || pos.length !== 3 || pos[1] !== "request" || !/^[a-f0-9]{64}$/.test(pos[2]) || ctx.dedupKey !== undefined) {
    throw new LedgerError("invalid", `${USAGE}（正文与 dedup 键由调度算，不收 ${stray.map((k) => `--${k}`).join(" ") || "额外参数"}）`);
  }
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "代排人工合并只有调度服务能写");
  const mode = flags.mode ?? "";
  if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
  return { ok: true, ...busyAsLedgerError("代排人工合并", () => db.transaction(() => requestInTx(db, ctx, pos[0], pos[2], mode, svc, ports)).immediate()) };
}
