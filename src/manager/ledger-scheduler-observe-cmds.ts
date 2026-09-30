/** Observe-mode CLI: write one plan record, read the plan-vs-PM diff, hand a card back to PM. No external effects. */
import { existsSync, readFileSync } from "node:fs";
import { getMeta, LedgerError, listEvents } from "../lib/ledger-store.js";
import type { RegistryAgent } from "../lib/registry.js";
import { diffLine, schedulerDiff, type DiffRow } from "../lib/scheduler-diff.js";
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
    valued: ["project"], bools: ["all"],
    usage: "scheduler-diff [task] [--project <id>] [--all]（只读：观察到的计划 vs PM 实际动作，每条一行；不带任务 = 项目里所有观察过的卡；默认只列差异与未决）",
    run(c) {
      const one = c.p.pos[1] ? c.task(c.p.pos[1]) : null;
      const project = one?.project ?? c.project();
      const ids = one ? [one.id] : (c.db.query(`SELECT DISTINCT target FROM events WHERE project = ? AND kind = 'scheduler'
        AND json_extract(data, '$.op') = 'observe' ORDER BY target`).all(project) as { target: string }[]).map((r) => r.target);
      const pms = new Set([...getMeta(c.db, project).pms, "owner", "master"]);
      const all: (DiffRow & { task: string })[] = ids.flatMap((id) =>
        schedulerDiff(listEvents(c.db, { project, target: id }), (a) => pms.has(a)).map((r) => ({ ...r, task: id })));
      const count = (v: string) => all.filter((r) => r.verdict === v).length;
      const rows = c.p.bools.has("all") ? all : all.filter((r) => r.verdict !== "match");
      return { ok: true, project, tasks: ids, summary: { match: count("match"), diff: count("diff"), unknown: count("unknown"), pending: count("pending"),
        superseded: count("superseded") },
        lines: rows.map((r) => diffLine(r.task, r)), rows };
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
