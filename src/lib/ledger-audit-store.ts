/**
 * 巡检结果落库（audit_findings 表，迁移步骤在 ledger-audit-schema.ts）：一轮结果对账成「新开 / 仍在 / 已解决」，去重也靠这张表——
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
  /** 通知押在押后队列里（收件人当时在忙）：那条消息的 messageId；投出去之前不算推过 */
  queuedAs: string | null;
  changedAt: number;
}

export interface ReconcileOpts {
  /** 这一轮判不出、要保持打开的 key（AuditResult.keep） */
  keep?: readonly string[];
  /** 押后队列里还在不在（不知道就当还在）；不在了 = 已投出，补记 notifiedAt */
  stillQueued?: (messageId: string) => boolean;
}

export interface ReconcileResult {
  opened: string[];
  resolved: string[];
  /** 本项目还开着、还没推过、有收件人的（推送方投递成功后调 ackFindings） */
  pending: StoredFinding[];
  /** 规则在本项目第一次跑：它开着的发现静默记成已推过（不进 pending） */
  silenced: string[];
}

type Row = Record<string, unknown>;
const toFinding = (r: Row) => r as unknown as StoredFinding;

/** 表还不存在（库停在巡检之前的版本、写者还没升级过）→ 读侧当没有巡检结果 */
function hasAuditTable(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'").get();
}

/** 一个项目的一轮结果入库。只关 evaluated 里的规则下这次没出现的：取数失败没跑的规则，旧异常原样留着 */
export function reconcileFindings(
  db: Database, project: string, found: readonly AuditFinding[], evaluated: readonly AuditRule[], now: number, opts: ReconcileOpts = {},
): ReconcileResult {
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
          db.prepare(`UPDATE audit_findings SET firstSeen = ?, lastSeen = ?, resolvedAt = NULL, notifiedAt = NULL, queuedAs = NULL, since = ?, detail = ?, suggestion = ?,
            notify = ?, changedAt = ? WHERE key = ?`).run(now, now, f.since, f.detail, f.suggestion, f.notify, now, f.key);
          opened.push(f.key);
        } else {
          // 仍在：只刷新 lastSeen 与文案（时长会变），不动 changedAt——否则每轮都会推一次 SSE
          db.prepare("UPDATE audit_findings SET lastSeen = ?, detail = ?, suggestion = ?, notify = ? WHERE key = ?").run(now, f.detail, f.suggestion, f.notify, f.key);
        }
      }
      const kept = new Set(opts.keep ?? []);
      const seen = new Set([...found.map((f) => f.key), ...kept]);
      const open = db.prepare("SELECT key, rule FROM audit_findings WHERE project = ? AND resolvedAt IS NULL").all(project) as { key: string; rule: AuditRule }[];
      for (const r of open) {
        if (seen.has(r.key) || !evaluated.includes(r.rule)) continue;
        db.prepare("UPDATE audit_findings SET resolvedAt = ?, changedAt = ? WHERE key = ?").run(now, now, r.key);
        resolved.push(r.key);
      }
      const queued = db.prepare("SELECT key, queuedAs FROM audit_findings WHERE project = ? AND notifiedAt IS NULL AND queuedAs IS NOT NULL").all(project) as { key: string; queuedAs: string }[];
      for (const q of queued) {
        if (opts.stillQueued?.(q.queuedAs) ?? true) continue;
        db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE key = ?").run(now, q.key);
      }
      const silenced = silenceFirstRun(db, project, evaluated, now);
      const pending = (db.prepare(`SELECT * FROM audit_findings WHERE project = ? AND resolvedAt IS NULL AND notifiedAt IS NULL AND queuedAs IS NULL
        AND notify IS NOT NULL ORDER BY firstSeen, key`)
        .all(project) as Row[]).map(toFinding).filter((f) => !kept.has(f.key)); // AUDN1：keep 的 key 这轮判不出，保持打开但不推
      return { opened, resolved, pending, silenced };
    }).immediate(),
  );
}

/**
 * 某条规则在这个项目上第一次真正跑（evaluated 里有、audit_baseline 里没有）：记下基线，并把它开着、没推过的发现标成已推过——
 * 上线首轮、或某个来源第一次取到数时，已经积压的旧事不一次推一大批，只推之后新出现的。按规则记而不是按项目：
 * 首轮因取数失败没跑的规则，等它第一次跑起来时同样静默。
 */
/** 首次满足就该推、没有积压洪水的规则：第一次 evaluated 照建基线，但不把开着没推过的发现记成已推（MQWATCH1：没送达的留在 pending 可重试） */
const NO_SILENCE_RULES: readonly AuditRule[] = ["merge_pm_blocked"];

function silenceFirstRun(db: Database, project: string, evaluated: readonly AuditRule[], now: number): string[] {
  const seen = new Set((db.prepare("SELECT rule FROM audit_baseline WHERE project = ?").all(project) as { rule: string }[]).map((r) => r.rule));
  const fresh = evaluated.filter((r) => !seen.has(r));
  const out: string[] = [];
  for (const rule of fresh) {
    db.prepare("INSERT INTO audit_baseline (project, rule, since) VALUES (?, ?, ?)").run(project, rule, now);
    if (NO_SILENCE_RULES.includes(rule)) continue;
    const keys = db.prepare("SELECT key FROM audit_findings WHERE project = ? AND rule = ? AND resolvedAt IS NULL AND notifiedAt IS NULL").all(project, rule) as { key: string }[];
    db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE project = ? AND rule = ? AND resolvedAt IS NULL AND notifiedAt IS NULL").run(now, project, rule);
    out.push(...keys.map((k) => k.key));
  }
  return out;
}

/**
 * 推送成功后标记；已解决的也照标（推的时候还开着），重复 ack 不改时间。
 * queuedAs = 通知进了押后队列：先记下 messageId，等下一轮对账看到它不在队里了才补 notifiedAt。
 */
export function ackFindings(db: Database, keys: readonly string[], now: number, queuedAs?: string): number {
  return busyAsLedgerError("巡检确认", () =>
    db.transaction(() => {
      let n = 0;
      const upd = queuedAs
        ? db.prepare("UPDATE audit_findings SET queuedAs = ? WHERE key = ? AND notifiedAt IS NULL")
        : db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE key = ? AND notifiedAt IS NULL");
      for (const k of keys) n += upd.run(queuedAs ?? now, k).changes;
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
