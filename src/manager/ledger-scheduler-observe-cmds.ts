/** Observe-mode CLI: write one plan record, read the plan-vs-PM diff, hand a card back to PM. No external effects. */
import { existsSync, readFileSync } from "node:fs";
import { getMeta, LedgerError, listEvents } from "../lib/ledger-store.js";
import type { RegistryAgent } from "../lib/registry.js";
import { schedulerDiff } from "../lib/scheduler-diff.js";
import { fallbackToManual } from "../lib/scheduler-fallback.js";
import { observeTask } from "../lib/scheduler-observe.js";
import { pathLike } from "../lib/quote-text.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Planner capacity when the scheduler service has not passed its project policy (the service always does). */
const DEFAULT_MAX_WORKERS = 2;

async function registryRows(c: LedgerCli): Promise<RegistryAgent[]> {
  const reg = await c.deps.loadRegistry();
  return Object.entries(reg.agents).map(([name, a]) => ({ ...(a as Omit<RegistryAgent, "name">), name }));
}

/** `ledger review` structured flags: all four or none; the ledger re-checks them against the task inside the write. */
export function structuredReviewFlags(c: LedgerCli): Record<string, unknown> {
  const f = c.p.flags;
  const out: Record<string, unknown> = {};
  if (f.head !== undefined) out.head = f.head;
  if (f.session !== undefined) out.reviewerSessionId = f.session;
  if (f.family !== undefined) out.reviewerFamily = f.family;
  if (f.findings !== undefined) {
    if (!pathLike(f.findings) || !existsSync(f.findings)) throw new LedgerError("invalid", "--findings 要是逐项结论 JSON 文件的路径");
    try { out.findings = JSON.parse(readFileSync(f.findings, "utf8")); }
    catch (e) { throw new LedgerError("invalid", `--findings 读不成 JSON：${(e as Error).message}`); }
  }
  return out;
}

export const SCHEDULER_OBSERVE_CMDS: Record<string, CommandSpec> = {
  "scheduler-observe": {
    valued: ["max-workers"], bools: [],
    usage: "scheduler-observe <task> [--max-workers N]（observe 卡：按模板算出下一步并只记一条观察事件，决定没变就不记）",
    async run(c) {
      const max = intFlag(c.p, "max-workers") ?? DEFAULT_MAX_WORKERS;
      if (max < 1 || max > 32) throw new LedgerError("invalid", "--max-workers 要在 1–32");
      const r = observeTask(c.db, c.ctx(), c.task(c.p.pos[1]).id, { registry: await registryRows(c), maxWorkers: max });
      return { ok: true, duplicate: r.duplicate, decision: r.decision, event: r.observation };
    },
  },
  "scheduler-diff": {
    valued: [], bools: ["all"],
    usage: "scheduler-diff <task> [--all]（只读：观察到的计划 vs PM 实际动作；默认只列差异与未决）",
    run(c) {
      const task = c.task(c.p.pos[1]);
      const pms = new Set([...getMeta(c.db, task.project).pms, "owner", "master"]);
      const rows = schedulerDiff(listEvents(c.db, { project: task.project, target: task.id }), (a) => pms.has(a));
      const count = (v: string) => rows.filter((r) => r.verdict === v).length;
      return { ok: true, task: task.id, summary: { match: count("match"), diff: count("diff"), pending: count("pending") },
        rows: c.p.bools.has("all") ? rows : rows.filter((r) => r.verdict !== "match") };
    },
  },
  "scheduler-fallback-manual": {
    valued: ["reason", "intent"], bools: [],
    usage: "scheduler-fallback-manual <task> --reason <为什么退回人工> [--intent <key>]",
    run(c) {
      const r = fallbackToManual(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, reason: c.need("reason"), intentId: c.p.flags.intent });
      return { ok: true, ...r };
    },
  },
};
