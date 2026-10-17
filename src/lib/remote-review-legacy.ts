/** Legacy bookings cannot gain authority from a short SHA; one durable checklist per project makes the upgrade visible to PM. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { TERMINAL_STAGES } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listTasks } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { quoteExternal } from "./quote-text.js";
import { fullRemoteHead, validRemoteRepo } from "./remote-review-identity.js";
import { appliedKey, REMOTE_REVIEW_OP, remoteRows } from "./remote-review-read.js";

export const LEGACY_NOTICE_OP = "remote_review_legacy_notice";
const legacyKey = (project: string): string => `scheduler:${LEGACY_NOTICE_OP}:${project}:v1`;

interface LegacyPending { taskId: string; seq: number; reportId: string; reportPath: string; head12: string }

function pendingLegacy(db: Database, project: string): LegacyPending[] {
  const tasks = new Map(listTasks(db, project).map((t) => [t.id, t]));
  return remoteRows(db, project).flatMap((row) => {
    const d = JSON.parse(row.data) as Record<string, unknown>, task = tasks.get(row.target);
    if (d.op !== REMOTE_REVIEW_OP || !task || TERMINAL_STAGES.includes(task.stage) || d.supersededBy != null || d.ambiguous === true) return [];
    if (typeof d.repo === "string" && validRemoteRepo(d.repo) && fullRemoteHead(d.fullHead)) return [];
    if (d.action != null || (d.matched !== false && !(d.matched === true && Number(d.p1) > 0 && d.ambiguous !== true))) return [];
    if (getEventByDedup(db, appliedKey(row.seq)) || getEventByDedup(db, `scheduler:remote_bounce:${task.id}:${row.seq}`)) return [];
    return [{ taskId: task.id, seq: row.seq, reportId: String(d.reportId ?? "未知报告"), reportPath: String(d.reportPath ?? "无报告路径"), head12: String(d.head12 ?? "未知") }];
  });
}

/** A real task anchors the project-level notice so the existing notified command can acknowledge it durably. */
export function legacyRemoteNoticeTask(db: Database, project: string): string | null {
  return getEventByDedup(db, legacyKey(project)) ? null : pendingLegacy(db, project)[0]?.taskId ?? null;
}

export function recordLegacyRemoteNotice(db: Database, ctx: WriteCtx, taskId: string) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "旧格式升级清单只由调度服务登记");
  return tx(db, () => {
    const task = mustTask(db, taskId), dedupKey = legacyKey(task.project);
    const seen = getEventByDedup(db, dedupKey);
    if (seen) return { event: seen, duplicate: true };
    const pending = pendingLegacy(db, task.project);
    const lines = pending.map((p) => `- ${p.taskId} ${quoteExternal(p.reportId, 80)}（seq ${p.seq}，head ${quoteExternal(p.head12, 40)}）；报告：${quoteExternal(p.reportPath, 400)}`);
    const notice = pending.length ? ["[调度引擎] 升级前的旧格式仓库方审查不会自动生效，请人工处理以下未完成记录：", ...lines].join("\n") : null;
    const event = insertEvent(db, { ...ctx, dedupKey }, { project: task.project, target: task.id, kind: "scheduler",
      text: "旧格式远端审查升级清单已登记", data: { op: LEGACY_NOTICE_OP, remoteSeqs: pending.map((p) => p.seq), notice } }, true);
    return { event, duplicate: false };
  });
}
