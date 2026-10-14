/**
 * 哨兵试点（agents-T14b）的 IO：cron 的 tick() 每分钟调一次 sentinelPilotTick(now)，到点就生成日报、按档位发送。
 * off（缺省）：不读会话记录、不写报告、不发送；observe：写报告文件 + 一行日志；on：再认领 `.sent`、经 notify 发到任务的报告频道。
 * 报告文件已在就不再生成（排他创建，重启 / 两个实例都安全）；`.sent` 先写再发，认领后发送失败只记日志、不重发——宁可少发一次。
 * 运行台账读不出（CronRunStore.list 抛）就本轮不生成、下一分钟再试：不能把「读不出」当成「没有记录」判没检查。
 * tests/sentinel-pilot.test.ts。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CronJob } from "./cron-job.js";
import { createCronRunStore, type CronRunRecord } from "./cron-run-state.js";
import { findJsonlBySessionId } from "./jsonl-cost.js";
import { notify } from "./notify.js";
import { statePath } from "./paths.js";
import { runtimeForSessionPath } from "./session-source.js";
import { readJsonLenient } from "./state-file.js";
import { collectRunEvidence } from "./sentinel-pilot-evidence.js";
import {
  classifySlot, dueSlots, localDate, recordForSlot, renderNotice, renderReport, reportFileName, reportReadyAt, runWindow, sentinelPilotMode,
  type ReportInput, type SentinelPilotMode, type SessionRead, type SlotVerdict,
} from "./sentinel-pilot.js";

export type SessionLines = { lines: string[]; runtime?: string } | { error: string };

export interface SentinelTickDeps {
  loadJobs(): Promise<CronJob[]>;
  /** cron 现有的 runStore.list()：文件坏了会抛 */
  listRuns(): Promise<CronRunRecord[]>;
  mode(jobId: string): SentinelPilotMode;
  readSession(sessionId: string): Promise<SessionLines>;
  reportsDir: string;
  /** 发通知；返回是否送达（lib/notify.ts 永不抛） */
  notify(chatId: string | undefined, text: string): Promise<boolean>;
  log(msg: string): void;
  error(msg: string): void;
}

/** 按会话 id 找 Claude Code 的会话记录；找不到 / 读不了给原因（日报记未验证，不去猜别的会话） */
async function readSessionById(sessionId: string): Promise<SessionLines> {
  const path = findJsonlBySessionId(sessionId);
  if (!path) return { error: "找不到这个会话 id 的会话文件" };
  try {
    return { lines: (await readFile(path, "utf8")).split("\n"), runtime: runtimeForSessionPath(path) };
  } catch (e) {
    return { error: `会话文件读不了：${(e as Error).message}` };
  }
}

const isJobsFile = (d: unknown): boolean => Array.isArray(d);
const asJobs = (rows: unknown[]): CronJob[] =>
  rows.filter((j): j is CronJob => !!j && typeof j === "object" && typeof (j as CronJob).id === "string" && typeof (j as CronJob).schedule === "string");

export function defaultSentinelDeps(): SentinelTickDeps {
  const store = createCronRunStore(statePath("cron-runs.json"));
  return {
    loadJobs: async () => asJobs(await readJsonLenient<unknown[]>(statePath("cron.json"), [], { validate: isJobsFile, who: "sentinel-pilot" })),
    listRuns: () => store.list(),
    mode: (jobId) => sentinelPilotMode(jobId),
    readSession: readSessionById,
    reportsDir: statePath("reports"),
    notify: (chatId, text) => (chatId ? notify({ source: "cron", chatId, text }) : Promise.resolve(false)),
    log: console.log,
    error: console.error,
  };
}

async function sessionFor(r: CronRunRecord, job: CronJob, readSession: SentinelTickDeps["readSession"]): Promise<SessionRead | undefined> {
  const w = runWindow(r);
  if (r.status !== "success" || !w) return undefined; // classifySlot 不看会话：失败 / 没收尾 / 定不出时间窗
  if (!r.targetSessionId) return { kind: "no_session_id" };
  const s = await readSession(r.targetSessionId);
  if ("error" in s) return { kind: "unreadable", why: s.error };
  return { kind: "ok", ev: collectRunEvidence(s.lines, w, { runtime: s.runtime, prompt: job.prompt }) };
}

/** 某任务某一天的报告输入（tick 与 `sentinel-pilot report --dry-run` 共用） */
export async function buildDayReport(
  job: CronJob, day: string, runs: readonly CronRunRecord[], readSession: SentinelTickDeps["readSession"],
  mode: SentinelPilotMode, now: number, dryRun = false,
): Promise<ReportInput> {
  const verdicts: SlotVerdict[] = [];
  for (const slot of dueSlots(job.schedule, day)) {
    const rec = recordForSlot(runs, job.id, slot);
    verdicts.push(classifySlot(slot, rec, rec ? await sessionFor(rec, job, readSession) : undefined));
  }
  return { job, day, mode, verdicts, generatedAt: now, readyAt: reportReadyAt(job, day), dryRun };
}

const isEexist = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "EEXIST";

/** 排他创建；已存在返回 false */
function createOnce(path: string, text: string): boolean {
  try { writeFileSync(path, text, { flag: "wx" }); return true; } catch (e) { if (isEexist(e)) return false; throw e; }
}

async function generate(job: CronJob, day: string, mode: SentinelPilotMode, runs: CronRunRecord[], now: number, deps: SentinelTickDeps): Promise<void> {
  const file = join(deps.reportsDir, reportFileName(job, day));
  const input = await buildDayReport(job, day, runs, deps.readSession, mode, now);
  mkdirSync(deps.reportsDir, { recursive: true });
  if (!createOnce(file, renderReport(input))) return;
  deps.log(`🛰 哨兵日报已生成（${mode}）: ${job.name} ${day} → ${file}`);
  if (mode !== "on") return;
  if (!createOnce(`${file}.sent`, new Date(now).toISOString())) return; // 先认领再发
  const ok = await deps.notify(job.reportChannelId || process.env.CONTROL_CHANNEL_ID || undefined, renderNotice(input, file));
  if (!ok) deps.error(`⚠️ 哨兵日报 ${job.name} ${day} 已认领但没发出去（不重发）: ${file}`);
}

/** 哪些（任务，日子）到了截止点、报告还没生成：只看昨天和今天（机器睡过 / daemon 停过醒来补一次） */
function dueReports(jobs: CronJob[], now: number, deps: SentinelTickDeps): { job: CronJob; day: string; mode: SentinelPilotMode }[] {
  const out: { job: CronJob; day: string; mode: SentinelPilotMode }[] = [];
  for (const job of jobs) {
    if (!job.targetAgent) continue;
    const mode = deps.mode(job.id);
    if (mode === "off") continue;
    const today = new Date(now), yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    for (const day of [localDate(yesterday), localDate(today)]) {
      const at = reportReadyAt(job, day);
      if (at !== null && now >= at && !existsSync(join(deps.reportsDir, reportFileName(job, day)))) out.push({ job, day, mode });
    }
  }
  return out;
}

let busy = false;
let lastMinute = -1;

/** cron 调度循环每轮 tick() 之后调用；同一分钟只跑一次，自己读开关，全 off 直接返回。不抛（错误只记日志），上一轮没跑完就跳过这一轮 */
export async function sentinelPilotTick(now: Date = new Date(), deps: SentinelTickDeps = defaultSentinelDeps()): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  if (busy || minute === lastMinute) return;
  busy = true;
  lastMinute = minute;
  try {
    const due = dueReports(await deps.loadJobs(), now.getTime(), deps);
    if (!due.length) return;
    let runs: CronRunRecord[];
    try { runs = await deps.listRuns(); } catch (e) {
      deps.error(`⚠️ 哨兵日报这轮没生成：运行台账读不出（下一分钟再试）: ${(e as Error).message}`);
      return;
    }
    for (const d of due) {
      try { await generate(d.job, d.day, d.mode, runs, now.getTime(), deps); } catch (e) { deps.error(`⚠️ 哨兵日报 ${d.job.name} ${d.day} 生成失败: ${(e as Error).message}`); }
    }
  } catch (e) {
    deps.error(`⚠️ 哨兵试点 tick 异常: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}
