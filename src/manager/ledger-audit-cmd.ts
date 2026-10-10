/**
 * `ledger audit`：台账巡检（T29，docs/architecture/ledger-audit.md）。取快照 → 跑规则 → 结果对账进 audit_findings。
 * bridge 每 15 分钟经 runManager 跑一次（bridge/ledger-audit-service.ts），把 pending 推给 PM / 调度助理后再 --ack；
 * 手动跑同一条命令，--dry-run 只算不写（LedgerReader 的 query_only 连接：不建库、不迁移，ledger.ts 的 realDeps）。输出一行 JSON；--json 带完整记录（bridge 用）。
 */
import { waitDiagnostics } from "../lib/ledger-deadlock.js";
import { auditLedger, auditRecipient, type AuditFinding } from "../lib/ledger-audit.js";
import { ackFindings, openFindings, reconcileFindings, type StoredFinding } from "../lib/ledger-audit-store.js";
import { auditedProjects, collectAuditSnapshots, queuedMessageIds } from "../lib/ledger-audit-snapshot.js";
import { getMeta, LedgerError } from "../lib/ledger-store.js";
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
  return { ok: true, acked: ackFindings(c.db, keys, c.deps.now(), c.p.flags.queued) };
}

/** 写巡检结果：owner / master 随便跑；PM 只能 --project 跑自己的项目（不带 --project 会写所有项目） */
function requireAuditWriter(c: LedgerCli): void {
  if (c.deps.actor === "owner" || c.deps.actor === "master") return;
  if (c.p.flags.project === undefined) throw new LedgerError("forbidden", "不带 --project 的巡检只有 owner / master 能写；PM 请带 --project，或用 --dry-run 只看");
  c.requireManager(c.project(), "写巡检结果");
}

/** 调度助理不在线时回落给谁：同一项目的 PM；本来就推给 PM 的不需要 */
function withFallback(c: LedgerCli, f: StoredFinding): StoredFinding & { fallback?: string } {
  const meta = getMeta(c.db, f.project);
  const pm = auditRecipient("pm_held", meta.pms, meta.team?.dispatcher);
  return pm && pm !== f.notify ? { ...f, fallback: pm } : f;
}

async function audit(c: LedgerCli): Promise<Result> {
  if (c.p.flags.ack !== undefined) return ack(c, c.p.flags.ack);
  const dry = c.p.bools.has("dry-run");
  if (!dry) requireAuditWriter(c);
  const now = c.deps.now();
  const projects = c.p.flags.project !== undefined ? [c.project()] : auditedProjects(c.db);
  const snaps = await collectAuditSnapshots(c.db, projects, now, c.deps.auditSources);
  const full = c.p.bools.has("json");
  const queued = dry ? null : queuedMessageIds(c.deps.auditSources?.heldPath);
  const out: Record<string, unknown>[] = [];
  const pending: StoredFinding[] = [];
  for (const s of snaps) {
    const r = auditLedger(s, now);
    if (dry) {
      out.push({ project: s.project, open: r.findings.map(full ? (f) => f : brief), skipped: r.skipped, ...waitDiagnostics(s.waitGraph) });
      continue;
    }
    const rec = reconcileFindings(c.db, s.project, r.findings, r.evaluated, now, { keep: r.keep, stillQueued: (id) => queued?.has(id) ?? true });
    pending.push(...rec.pending);
    const open = openFindings(c.db, s.project);
    out.push({ project: s.project, opened: rec.opened.length, resolved: rec.resolved.length, silenced: rec.silenced.length,
      open: full ? open : open.map(brief), skipped: r.skipped, ...waitDiagnostics(s.waitGraph) });
  }
  return { ok: true, now, dryRun: dry, projects: out, ...(full && !dry ? { pending: pending.map((f) => withFallback(c, f)) } : {}) };
}

export const AUDIT_CMDS: Record<string, CommandSpec> = {
  audit: {
    valued: ["project", "ack", "queued"], bools: ["dry-run", "json"],
    usage: "audit [--project <id>] [--dry-run] [--json] | audit --ack <key,key> [--queued <messageId>]", run: audit,
  },
};
