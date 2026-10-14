/**
 * `sentinel-pilot set <任务名|id> off|observe|on`（写 sentinel-pilot.json）
 * `sentinel-pilot show`（列试点任务、档位、下一个截止点，印结果行约定 SENTINEL_RESULT_HINT）
 * `sentinel-pilot report <任务名|id> [--date YYYY-MM-DD] --dry-run`（只在终端印报告，不写文件、不发送，供 PM 对账）
 * 哨兵试点见 lib/sentinel-pilot.ts（agents-T14b）。
 */
import type { CronJob } from "../lib/cron-job.js";
import { outputSync } from "./core.js";
import {
  localDate, nextReportDeadline, parseLocalDate, renderReport, SENTINEL_RESULT_HINT, sentinelPilotMode, setSentinelPilotMode,
} from "../lib/sentinel-pilot.js";
import { buildDayReport, defaultSentinelDeps, markPilotSince, mirrorRuns, type SentinelTickDeps } from "../lib/sentinel-pilot-tick.js";

const USAGE = "usage: sentinel-pilot set <任务名|id> off|observe|on | sentinel-pilot show | sentinel-pilot report <任务名|id> [--date YYYY-MM-DD] --dry-run";

type Out = (data: Record<string, unknown> | string) => void;

export interface SentinelCmdDeps {
  deps: SentinelTickDeps;
  mode(jobId: string): ReturnType<typeof sentinelPilotMode>;
  setMode(job: CronJob, mode: string): Promise<unknown>;
  now(): number;
  out: Out;
}

const findJob = (jobs: CronJob[], key: string): CronJob | undefined => jobs.find((j) => j.id === key) ?? jobs.find((j) => j.name === key);

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdShow(c: SentinelCmdDeps): Promise<void> {
  const jobs = (await c.deps.loadJobs()).filter((j) => j.targetAgent);
  const rows = jobs.map((j) => {
    const at = nextReportDeadline(j, c.now());
    return { id: j.id, name: j.name, schedule: j.schedule, targetAgent: j.targetAgent, mode: c.mode(j.id), nextDeadline: at === null ? null : new Date(at).toISOString() };
  });
  c.out({ ok: true, jobs: rows, resultHint: SENTINEL_RESULT_HINT });
}

async function cmdReport(c: SentinelCmdDeps, args: string[]): Promise<void> {
  const [key] = args;
  if (!key || !args.includes("--dry-run")) return c.out({ ok: false, error: `report 只支持 --dry-run（只印不写不发）。${USAGE}` });
  const job = findJob(await c.deps.loadJobs(), key);
  if (!job) return c.out({ ok: false, error: `没有这个 cron 任务: ${key}` });
  const date = flagValue(args, "--date") ?? localDate(new Date(c.now()));
  if (!parseLocalDate(date)) return c.out({ ok: false, error: `--date 要是 YYYY-MM-DD（不是 ${date}）` });
  let runs;
  try { runs = await c.deps.listRuns(); } catch (e) { return c.out({ ok: false, error: `运行台账读不出，不出报告: ${(e as Error).message}` }); }
  runs = mirrorRuns(c.deps.reportsDir, job, runs, c.now(), c.deps.error, false); // 台账裁掉的从镜像补；只读不写
  const input = await buildDayReport(job, date, runs, c.deps.readSession, c.mode(job.id), c.now(), true);
  c.out(renderReport(input));
}

export async function cmdSentinelPilot(args: string[], c?: Partial<SentinelCmdDeps>): Promise<void> {
  const ctx: SentinelCmdDeps = {
    deps: c?.deps ?? defaultSentinelDeps(),
    mode: c?.mode ?? ((id) => sentinelPilotMode(id)),
    setMode: c?.setMode ?? ((job, mode) => setSentinelPilotMode(job, mode)),
    now: c?.now ?? Date.now,
    out: c?.out ?? outputSync,
  };
  const [sub, ...rest] = args;
  if (sub === "show") return cmdShow(ctx);
  if (sub === "report") return cmdReport(ctx, rest);
  if (sub !== "set" || rest.length < 2) return ctx.out({ ok: false, error: USAGE });
  const job = findJob(await ctx.deps.loadJobs(), rest[0]);
  if (!job) return ctx.out({ ok: false, error: `没有这个 cron 任务: ${rest[0]}` });
  try {
    const r = await ctx.setMode(job, rest[1]) as { mode: Parameters<typeof markPilotSince>[2] };
    markPilotSince(ctx.deps.reportsDir, job, r.mode, ctx.now()); // 启用起点：补生成不早于这天
    ctx.out({ ok: true, id: job.id, name: job.name, ...r });
  } catch (e) {
    ctx.out({ ok: false, error: (e as Error).message });
  }
}
