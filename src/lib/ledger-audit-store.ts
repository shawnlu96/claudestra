/**
 * 巡检结果落库（audit_findings 表，ledger-store.ts 的 v2 迁移）：一轮结果对账成「新开 / 仍在 / 已解决」，去重也靠这张表——
 * 已推过（notifiedAt 有值）且还开着的不再推，bridge 重启不重推。只有 CLI 写（bridge 对台账只读，见 ledger-read.ts）。
 * 同一个 key 解决后又出现 = 重新打开：清掉 resolvedAt / notifiedAt，firstSeen 取这次，会再推一次。
 */
import type { Database } from "bun:sqlite";
import type { AuditFinding, AuditRule } from "./ledger-audit.js";
import { busyAsLedgerError } from "./ledger-store.js";

export interface StoredFinding {
  key: string;
  project: string;
  taskId: string | null;
  rule: AuditRule;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  since: number;
  detail: string;
  suggestion: string;
  notify: string | null;
  notifiedAt: number | null;
  changedAt: number;
}

export interface ReconcileResult {
  opened: string[];
  resolved: string[];
  /** 本项目还开着、还没推过、有收件人的（推送方投递成功后调 ackFindings） */
  pending: StoredFinding[];
}

type Row = Record<string, unknown>;
const toFinding = (r: Row) => r as unknown as StoredFinding;

/** 表还不存在（库是 v1、写者还没升级过）→ 读侧当没有巡检结果 */
function hasAuditTable(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'").get();
}

/** 一个项目的一轮结果入库。只关 evaluated 里的规则下这次没出现的：取数失败没跑的规则，旧异常原样留着 */
export function reconcileFindings(db: Database, project: string, found: readonly AuditFinding[], evaluated: readonly AuditRule[], now: number): ReconcileResult {
  return busyAsLedgerError("巡检写入", () =>
    db.transaction((): ReconcileResult => {
      const opened: string[] = [];
      const resolved: string[] = [];
      const get = db.prepare("SELECT * FROM audit_findings WHERE key = ?");
      for (const f of found) {
        const cur = get.get(f.key) as Row | null;
        if (!cur) {
          db.prepare(`INSERT INTO audit_findings (key, project, taskId, rule, firstSeen, lastSeen, since, detail, suggestion, notify, changedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.key, project, f.taskId, f.rule, now, now, f.since, f.detail, f.suggestion, f.notify, now);
          opened.push(f.key);
        } else if (cur.resolvedAt !== null) {
          db.prepare(`UPDATE audit_findings SET firstSeen = ?, lastSeen = ?, resolvedAt = NULL, notifiedAt = NULL, since = ?, detail = ?, suggestion = ?,
            notify = ?, changedAt = ? WHERE key = ?`).run(now, now, f.since, f.detail, f.suggestion, f.notify, now, f.key);
          opened.push(f.key);
        } else {
          // 仍在：只刷新 lastSeen 与文案（时长会变），不动 changedAt——否则每轮都会推一次 SSE
          db.prepare("UPDATE audit_findings SET lastSeen = ?, detail = ?, suggestion = ?, notify = ? WHERE key = ?").run(now, f.detail, f.suggestion, f.notify, f.key);
        }
      }
      const seen = new Set(found.map((f) => f.key));
      const open = db.prepare("SELECT key, rule FROM audit_findings WHERE project = ? AND resolvedAt IS NULL").all(project) as { key: string; rule: AuditRule }[];
      for (const r of open) {
        if (seen.has(r.key) || !evaluated.includes(r.rule)) continue;
        db.prepare("UPDATE audit_findings SET resolvedAt = ?, changedAt = ? WHERE key = ?").run(now, now, r.key);
        resolved.push(r.key);
      }
      const pending = (db.prepare("SELECT * FROM audit_findings WHERE project = ? AND resolvedAt IS NULL AND notifiedAt IS NULL AND notify IS NOT NULL ORDER BY firstSeen, key")
        .all(project) as Row[]).map(toFinding);
      return { opened, resolved, pending };
    }).immediate(),
  );
}

/** 推送成功后标记；已解决的也照标（推的时候还开着），重复 ack 不改时间 */
export function ackFindings(db: Database, keys: readonly string[], now: number): number {
  return busyAsLedgerError("巡检确认", () =>
    db.transaction(() => {
      let n = 0;
      const upd = db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE key = ? AND notifiedAt IS NULL");
      for (const k of keys) n += upd.run(now, k).changes;
      return n;
    }).immediate(),
  );
}

/** 一个项目当前没解决的（读接口 / CLI 展示）；表不存在 = 空 */
export function openFindings(db: Database, project: string): StoredFinding[] {
  if (!hasAuditTable(db)) return [];
  return (db.query("SELECT * FROM audit_findings WHERE project = ? AND resolvedAt IS NULL ORDER BY firstSeen, key").all(project) as Row[]).map(toFinding);
}

/** changedAt 晚于 after 的项目（读侧变更推送的第二个游标）；表不存在 = 没有 */
export function auditChangedProjects(db: Database, after: number): { projects: string[]; last: number } {
  if (!hasAuditTable(db)) return { projects: [], last: after };
  const rows = db.query("SELECT project, MAX(changedAt) AS m FROM audit_findings WHERE changedAt > ? GROUP BY project ORDER BY project").all(after) as { project: string; m: number }[];
  return { projects: rows.map((r) => r.project), last: rows.reduce((m, r) => Math.max(m, r.m), after) };
}
