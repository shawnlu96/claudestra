/**
 * PM 处理员（agents-PMJOB1，docs/architecture/pm-job.md）的 manager 命令：
 * - `ledger pm-job`：只读，最近 24 小时处理员的请求数 / 用时 / 失败 / 升级 / 队列等待和各状态单数，给 PMCOST1 同窗口对照用；
 * - `ledger pm-job-mode <on|observe|off>`：项目开关（缺省 observe），项目真 PM / master / owner 才能切；每切一次模式世代加一。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { PmJobStore } from "../lib/pm-job-store.js";
import type { PmJob } from "../lib/pm-job-types.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const WINDOW_MS = 24 * 3600_000;

/** 不含问题 / 答复正文；本机 Codex 的成本（请求数、用时、字符量）单列，对照 PM 叫醒成本时不能省 */
export function pmJobStats(store: PmJobStore, project: string, now: number) {
  const jobs = store.list().filter((j) => j.project === project && now - j.createdAt < WINDOW_MS);
  const byState: Record<string, number> = {};
  for (const j of jobs) byState[j.state] = (byState[j.state] ?? 0) + 1;
  const ran = jobs.filter((j): j is PmJob & { usage: NonNullable<PmJob["usage"]> } => !!j.usage);
  const waits = jobs.filter((j) => j.startedAt !== undefined).map((j) => j.startedAt! - j.createdAt);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    project, mode: store.mode(project), modeGen: store.gen(project), hours: 24, jobs: jobs.length, byState,
    direct: byState.sent ?? 0, escalated: (byState.escalated ?? 0) + (byState.unknown ?? 0),
    failed: jobs.filter((j) => j.result?.verdict === "escalate" && /运行失败|出错|中断|超时/.test(j.result.reason)).length,
    codex: { requests: sum(ran.map((j) => j.usage.requests)), elapsedMs: sum(ran.map((j) => j.usage.elapsedMs)),
      promptChars: sum(ran.map((j) => j.usage.promptChars)), answerChars: sum(ran.map((j) => j.usage.answerChars)) },
    queueWaitMs: { avg: waits.length ? Math.round(sum(waits) / waits.length) : 0, max: waits.length ? Math.max(...waits) : 0 },
  };
}

export function pmJobCmds(store = new PmJobStore()): Record<string, CommandSpec> {
  return {
    "pm-job": { valued: ["project"], bools: [], usage: "pm-job [--project <id>]（只读：最近 24 小时 PM 处理员的请求 / 用量 / 失败 / 升级 / 队列等待）",
      run: async (c: LedgerCli) => ({ ok: true, ...pmJobStats(store, c.project(), c.deps.now()) }) },
    "pm-job-mode": { valued: ["project"], bools: [], usage: "pm-job-mode <on|observe|off> [--project <id>]（PM 处理员开关，缺省 observe）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1];
        if (mode !== "on" && mode !== "observe" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / observe / off");
        c.requireRealPm(project, "切 PM 处理员开关");
        const from = store.mode(project);
        store.setMode(project, mode);
        return { ok: true, project, from, jobMode: mode, modeGen: store.gen(project) };
      } },
  };
}

export const PM_JOB_CMDS = pmJobCmds();
