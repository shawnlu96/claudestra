/**
 * `ledger scheduler-worker-retire --wire <json>`: the card worker lifecycle's ledger write (LIFE1, lib/agent-lifecycle-store.ts).
 * The scheduler's own ledger connection is read-only, so every collected agent is recorded through this command, like
 * scheduler-session-retire. The scheduler identity may run it (SCHEDULER_SERVICE_COMMANDS); anyone else needs PM / master / owner.
 */
import { isWorkerRole, recordWorkerRetire, type RetireRecord } from "../lib/agent-lifecycle-store.js";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, what: string, max = 300): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new LedgerError("invalid", `${what}要是 1..${max} 字的字符串`);
  return v;
};

function parseRetireWire(raw: string, now: number): RetireRecord {
  let w: Record<string, unknown>;
  try { w = JSON.parse(raw) as Record<string, unknown>; } catch { throw new LedgerError("invalid", "--wire 不是 JSON"); }
  if (!w || typeof w !== "object") throw new LedgerError("invalid", "--wire 要是对象");
  const role = w.role === "stock" || isWorkerRole(w.role) ? w.role : null;
  if (!role) throw new LedgerError("invalid", "role 只能是 author / reviewer / other / stock");
  if (w.mode !== "retire" && w.mode !== "park") throw new LedgerError("invalid", "mode 只能是 retire / park");
  const steps = Array.isArray(w.steps) ? w.steps.filter((s): s is string => typeof s === "string").slice(0, 20).map((s) => s.slice(0, 400)) : [];
  return { agent: text(w.agent, "agent", 120), taskId: w.taskId === null || w.taskId === undefined ? null : text(w.taskId, "taskId", 80), role,
    rule: text(w.rule, "rule", 40), mode: w.mode, reason: text(w.reason, "reason"), idleMs: num(w.idleMs), bytesBefore: num(w.bytesBefore),
    bytesAfter: num(w.bytesAfter), steps, now };
}

export const WORKER_CMDS: Record<string, CommandSpec> = {
  "scheduler-worker-retire": {
    valued: ["wire"], bools: [],
    usage: "scheduler-worker-retire --wire '<json {agent,taskId,role,rule,mode,reason,idleMs,bytesBefore,bytesAfter,steps}>'（卡 worker 生命周期收回记录，LIFE1）",
    run(c) {
      const ctx = c.ctx(), r = parseRetireWire(c.need("wire"), ctx.now ?? Date.now());
      if (ctx.actor !== "scheduler") {
        const task = r.taskId ? getTask(c.db, r.taskId) : null;
        if (!task) throw new LedgerError("forbidden", "只有调度服务能记没有卡的存量 agent");
        c.requireManager(task.project, "记 worker 收回");
      }
      recordWorkerRetire(c.db, ctx.actor, r);
      return { ok: true, agent: r.agent, mode: r.mode };
    },
  },
};
