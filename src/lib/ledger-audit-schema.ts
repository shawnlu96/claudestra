/**
 * 巡检结果表 audit_findings 的迁移步骤（T29，读写在 ledger-audit-store.ts），接在 ledger-store 的 LEDGER_MIGRATIONS 末尾；
 * 单独成文件是因为 ledger-store 有 400 行上限。放单独一张表而不是事件族：findings 要改 lastSeen / resolvedAt，events 只能追加，
 * 而且当事件写会挤进 taskView.lastEvent 与 projectEvents（T11a 审查 P1-5 的坑）。
 * changedAt 只在开 / 关 / 重开时更新（读侧变更推送的游标）；queuedAs = 通知押在押后队列里的 messageId，投出去才算推过。
 * audit_baseline：某条规则在某个项目上第一次真正跑过的时刻；第一次跑出的发现静默记成已推过（上线不一次推一大批）。
 * 一条语句一个元素（runStep 逐条 prepare().run()），都带 IF NOT EXISTS：撞号补齐时会重跑。
 */
export const SCHEMA_AUDIT: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS audit_findings (
  key TEXT PRIMARY KEY, project TEXT NOT NULL, taskId TEXT, rule TEXT NOT NULL,
  firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, resolvedAt INTEGER,
  since INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', suggestion TEXT NOT NULL DEFAULT '',
  notify TEXT, notifiedAt INTEGER, queuedAs TEXT, changedAt INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS audit_findings_open ON audit_findings(project, resolvedAt)",
  "CREATE INDEX IF NOT EXISTS audit_findings_changed ON audit_findings(changedAt)",
  "CREATE TABLE IF NOT EXISTS audit_baseline (project TEXT NOT NULL, rule TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (project, rule))",
];
