/**
 * 哨兵试点（agents-T14b）的 IO：cron 的 tick() 每分钟调一次 sentinelPilotTick(now)，到点就生成日报、按档位发送。
 * off（缺省）：不读会话记录、不写报告、不发送；observe：写报告文件 + 一行日志；on：再认领 `.sent`、经 notify 发到任务的报告频道。
 * 报告文件已在就不再生成（排他创建，重启 / 两个实例都安全）；`.sent` 先写再发，认领后发送失败只记日志、不重发——宁可少发一次。
 * 运行台账读不出（CronRunStore.list 抛）就本轮不生成、下一分钟再试：不能把「读不出」当成「没有记录」判没检查。
 * tests/sentinel-pilot.test.ts。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CronJob } from "./cron-job.js";
import { createCronRunStore, isUnfinishedCronRun, type CronRunRecord } from "./cron-run-state.js";
import { findJsonlBySessionId } from "./jsonl-cost.js";
import { notify } from "./notify.js";
import { statePath } from "./paths.js";
import { runtimeForSessionPath } from "./session-source.js";
import { readJsonLenient } from "./state-file.js";
import { collectRunEvidence } from "./sentinel-pilot-evidence.js";
import {
  classifySlot, dueSlots, localDate, parseLocalDate, recordForSlot, renderNotice, renderReport, reportFileName, reportReadyAt, runWindow, sentinelPilotMode,
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
  if (!w) return undefined; // 定不出时间窗（没发出去 / 台账缺字段）：没有可审的会话段
  // 失败 / 没收尾的也读：classifySlot 照样判失败，但越界、人工回合要从这里审（审查 failed-run-audit-loss）
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

/** 补生成最多往回看这么多天（含今天）：再早的运行记录可能已被 cron-runs.json 按条数裁掉 */
export const CATCHUP_DAYS = 7;

/** 启用起点标记：`<reportsDir>/.sentinel-<任务名>.since`，内容是本地日期。补生成不早于这一天（没开之前的日子不出报告） */
export const sincePath = (reportsDir: string, job: CronJob): string =>
  join(reportsDir, `.${reportFileName(job, "since").replace(/-since\.md$/, "")}.since`);

/** 读启用起点；缺就以今天为起点排他补写（set 走的是别的路径、或老版本开的） */
function pilotSince(reportsDir: string, job: CronJob, now: number): string {
  const path = sincePath(reportsDir, job);
  try {
    const d = readFileSync(path, "utf8").trim();
    if (parseLocalDate(d)) return d;
  } catch { /* 缺：下面补写 */ }
  const today = localDate(new Date(now));
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path, today);
  return today;
}

/** `sentinel-pilot set`：开（observe / on）时记启用起点（已有不动），关时删掉——关过的那段以后再开也不补 */
export function markPilotSince(reportsDir: string, job: CronJob, mode: SentinelPilotMode, now: number): void {
  const path = sincePath(reportsDir, job);
  if (mode === "off") { rmSync(path, { force: true }); return; }
  mkdirSync(reportsDir, { recursive: true });
  try { writeFileSync(path, localDate(new Date(now)), { flag: "wx" }); } catch (e) { if (!isEexist(e)) throw e; }
}

interface Due { job: CronJob; day: string; mode: SentinelPilotMode }

/**
 * 哪些（任务，日子）到了截止点、报告还没生成：从启用起点和「今天往前 CATCHUP_DAYS 天」里较晚的那天起，到今天。
 * 机器睡过 / daemon 停过多天，醒来把这段里缺的日报都补上（审查 catchup-limited-to-yesterday）。
 */
function dueReports(jobs: CronJob[], now: number, deps: SentinelTickDeps): Due[] {
  const out: Due[] = [];
  for (const job of jobs) {
    if (!job.targetAgent) continue;
    const mode = deps.mode(job.id);
    if (mode === "off") continue;
    const since = pilotSince(deps.reportsDir, job, now);
    for (let i = CATCHUP_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = localDate(d);
      if (day < since) continue;
      const at = reportReadyAt(job, day);
      if (at !== null && now >= at && !existsSync(join(deps.reportsDir, reportFileName(job, day)))) out.push({ job, day, mode });
    }
  }
  return out;
}

/**
 * cron-runs.json 结束记录的保留条数（cron-run-state.ts 的 KEEP_FINISHED，那边不导出；tests 用真实 store 钉住这个值）。
 * 台账只有裁剪会删记录，而裁剪只在结束记录超过这个数时发生、裁完至少留这么多条：不到这个数就一定没裁过。
 */
export const LEDGER_KEEP_FINISHED = 300;

/**
 * 这天的「没有记录」可不可信：结束记录不到 LEDGER_KEEP_FINISHED 条 → 从没裁过，可信（缺就是没检查）；
 * 到了这个数、且台账里最早的一条晚于这天第一个应检时刻 → 这天的记录可能已被裁掉，不出报告（不判没检查）。
 * 不能只凭「有一条较晚的记录」推断裁过：首次启用、真实漏检都是这个样子（审查 ledger-coverage-suppresses-missed-run）。
 */
function ledgerCovers(runs: readonly CronRunRecord[], job: CronJob, day: string): boolean {
  const first = dueSlots(job.schedule, day)[0];
  if (first === undefined || runs.filter((r) => !isUnfinishedCronRun(r)).length < LEDGER_KEEP_FINISHED) return true;
  return runs.reduce((m, r) => Math.min(m, r.epochMinute), Infinity) <= Math.floor(first / 60_000);
}
const uncovered = new Set<string>();

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
      if (!ledgerCovers(runs, d.job, d.day)) {
        const k = `${d.job.id}@${d.day}`;
        if (!uncovered.has(k)) { uncovered.add(k); deps.error(`⚠️ 哨兵日报 ${d.job.name} ${d.day} 不补：运行台账已裁到这天之后，没有记录不等于没检查`); }
        continue;
      }
      try { await generate(d.job, d.day, d.mode, runs, now.getTime(), deps); } catch (e) { deps.error(`⚠️ 哨兵日报 ${d.job.name} ${d.day} 生成失败: ${(e as Error).message}`); }
    }
  } catch (e) {
    deps.error(`⚠️ 哨兵试点 tick 异常: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}
