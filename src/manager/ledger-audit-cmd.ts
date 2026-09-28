/**
 * `ledger audit`：台账巡检（T29，docs/architecture/ledger-audit.md）。取快照 → 跑规则 → 结果对账进 audit_findings。
 * bridge 每 15 分钟经 runManager 跑一次（bridge/ledger-audit-service.ts），把 pending 推给 PM / 调度助理后再 --ack；
 * 手动跑同一条命令，--dry-run 只算不写。输出同其它 ledger 子命令，一行 JSON；--json 带上完整记录（bridge 用）。
 */
import { auditLedger, type AuditFinding } from "../lib/ledger-audit.js";
import { ackFindings, openFindings, reconcileFindings, type StoredFinding } from "../lib/ledger-audit-store.js";
import { auditedProjects, collectAuditSnapshots } from "../lib/ledger-audit-snapshot.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

type Brief = Pick<AuditFinding, "rule" | "taskId" | "detail" | "suggestion">;
const brief = (f: Brief & { project?: string }): Brief & { project?: string } =>
  ({ project: f.project, rule: f.rule, taskId: f.taskId, detail: f.detail, suggestion: f.suggestion });

/** 推送确认：只认 owner / master / 相关项目的 PM（bridge 以 owner 身份跑）——执行者不能替 PM 把提醒标成已推 */
function ack(c: LedgerCli, raw: string): Result {
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new LedgerError("invalid", "--ack 要带逗号分隔的 key");
  for (const k of keys) c.requireManager(k.split("|")[0] ?? "", "确认巡检推送");
  return { ok: true, acked: ackFindings(c.db, keys, c.deps.now()) };
}

async function audit(c: LedgerCli): Promise<Result> {
  if (c.p.flags.ack !== undefined) return ack(c, c.p.flags.ack);
  const now = c.deps.now();
  const projects = c.p.flags.project !== undefined ? [c.project()] : auditedProjects(c.db);
  const snaps = await collectAuditSnapshots(c.db, projects, now, c.deps.auditSources);
  const dry = c.p.bools.has("dry-run");
  const full = c.p.bools.has("json");
  const out: Record<string, unknown>[] = [];
  const pending: StoredFinding[] = [];
  for (const s of snaps) {
    const r = auditLedger(s, now);
    if (dry) {
      out.push({ project: s.project, open: r.findings.map(full ? (f) => f : brief), skipped: r.skipped });
      continue;
    }
    const rec = reconcileFindings(c.db, s.project, r.findings, r.evaluated, now);
    pending.push(...rec.pending);
    const open = openFindings(c.db, s.project);
    out.push({ project: s.project, opened: rec.opened.length, resolved: rec.resolved.length, open: full ? open : open.map(brief), skipped: r.skipped });
  }
  return { ok: true, now, dryRun: dry, projects: out, ...(full && !dry ? { pending } : {}) };
}

export const AUDIT_CMDS: Record<string, CommandSpec> = {
  audit: { valued: ["project", "ack"], bools: ["dry-run", "json"], usage: "audit [--project <id>] [--dry-run] [--json] | audit --ack <key,key>", run: audit },
};
