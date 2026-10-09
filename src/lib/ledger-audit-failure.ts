/** Failure notices use role metadata and fixed summaries; command output stays in local diagnostics. */
import type { Database } from "bun:sqlite";
import { auditedProjects } from "./ledger-audit-snapshot.js";
import { LedgerReader } from "./ledger-read.js";
import { getMeta } from "./ledger-store.js";
import { activeProjectPm } from "./pm-role.js";
import type { StoredFinding } from "./ledger-audit-store.js";

export type AuditFailureKind = "manager_failed" | "invalid_response" | "round_failed";
export interface AuditFailureTarget { project: string; to: string }

/** Same project set as `ledger audit --json`, with current on-duty PM resolution; never fall back to owner/master. */
function auditFailureTargets(db: Database): AuditFailureTarget[] {
  return auditedProjects(db).map((project) => {
    const meta = getMeta(db, project), to = activeProjectPm(db, project);
    if (!to || !meta.pms.includes(to) || to === meta.team?.dispatcher) throw new Error(`台账巡检 ${project} 的当班 PM 无法核验`);
    return { project, to };
  });
}

/** Short-lived canonical read connection: no schema creation, migration, role writes or new polling service. */
export function readAuditFailureTargets(path?: string): AuditFailureTarget[] {
  const reader = new LedgerReader(path);
  try {
    const db = reader.get();
    if (!db) throw new Error("台账巡检告警无法读取项目 PM：台账不可用");
    return auditFailureTargets(db);
  } finally { reader.close(); }
}

const summaries: Record<AuditFailureKind, string> = {
  manager_failed: "巡检命令未成功完成",
  invalid_response: "巡检响应结构无效",
  round_failed: "巡检结果处理未成功完成",
};
export function auditFailureText(project: string, kind: AuditFailureKind): string {
  return `⚠️ [ledger-audit-failure] 项目 ${project} 台账巡检连续失败至少 3 轮。分类：${kind}；${summaries[kind]}。请检查本机巡检日志；本轮不能当作零异常。`;
}

interface AuditResult { ok: true; projects: { project: string; skipped?: { rule: string; reason: string }[] }[]; pending: StoredFinding[] }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** An incomplete success envelope cannot erase a failure streak or acknowledge findings. */
export function auditResult(value: unknown): AuditResult {
  if (!record(value) || value.ok !== true || !Array.isArray(value.projects) || !Array.isArray(value.pending) ||
    !value.projects.every((p) => record(p) && typeof p.project === "string" && !!p.project &&
      (p.skipped === undefined || Array.isArray(p.skipped) && p.skipped.every((s) => record(s) && typeof s.rule === "string" && typeof s.reason === "string"))) ||
    !value.pending.every((f) => record(f) && ["key", "project", "rule", "detail", "suggestion"].every((k) => typeof f[k] === "string") &&
      !!f.key && !!f.project && (f.notify === null || f.notify === undefined || typeof f.notify === "string") &&
      (f.fallback === undefined || typeof f.fallback === "string"))) throw new Error("ledger audit 响应结构无效");
  return value as unknown as AuditResult;
}
