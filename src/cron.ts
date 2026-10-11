#!/usr/bin/env bun
/**
 * Cron Scheduler — 定时任务调度器
 *
 * launchd 管理的守护进程（com.claudestra.cron），按 cron 表达式调度任务。
 * 每个任务触发时：创建临时 agent → 发送 prompt → 等待完成 → 通知 → 销毁。
 *
 * 存储：~/.claude-orchestrator/cron.json
 * 日志：~/.claude-orchestrator/cron-history.json（最近 100 条执行记录）
 */

import { STATE_DIR, statePath, CRON_HISTORY_PATH, refuseInSandbox } from "./lib/paths.js";
import { readFile, mkdir } from "fs/promises";
import { enableTimestampLogs } from "./lib/log-timestamp.js";
import { runtimeForSessionPath, translateSessionLine } from "./lib/session-source.js";
import { initLang } from "./lib/i18n.js";
import { existsSync, watchFile } from "fs";
import { notify } from "./lib/notify.js";
import { runManagerProcess, agentsFromList, createFailureLatch } from "./lib/run-manager.js";
import { createCronRunStore } from "./lib/cron-run-state.js";
import { runCronJobGuarded, runCronTempAgent, type CronExecDeps, type CronHistoryRow, type CronRunCtx, type CronRunOutcome } from "./lib/cron-run-state-exec.js";
import { recoverCronRuns, markLegacyRunningHistory, type CronAgentPorts, type CronRecoveryDeps } from "./lib/cron-run-recovery.js";
import { tempAgentCleanupFailure } from "./lib/restart-result.js";
import { CRON_PROMPT_REFUSED, hasControlChar } from "./lib/flag-like.js";
import { readJsonLenient, writeJsonAtomic, writeJsonStateGuarded } from "./lib/state-file.js";
import { projectJsonlPath, findJsonlBySessionId } from "./lib/jsonl-cost.js";
import {
  tmuxSendLine,
  tmuxCapture,
  isIdle as tmuxIsIdle, windowTarget, tmuxRawStrict,
} from "./lib/tmux-helper.js";

// ============================================================
// 配置
// ============================================================

import { resolveBunPath, bunBinDir } from "./lib/bun-path.js";
import { installCrashGuard } from "./lib/crash-guard.js";

// 进程级异常兜底：保证死因一定进 stderr（见 lib/crash-guard.ts）
installCrashGuard("cron");

import { initDaemonLogs } from "./lib/log-paths.js";
import { wallWaitRefusal, windowWallWait } from "./lib/wall-screen.js";
initDaemonLogs("cron");

const CONFIG_DIR = STATE_DIR;
const CRON_PATH = statePath("cron.json");
const HISTORY_PATH = CRON_HISTORY_PATH;
const MANAGER_PATH = `${import.meta.dir}/manager.ts`;
// 见 lib/bun-path.ts：写死 ~/.bun 会让 brew/mise 装 bun 的人所有 cron 任务静默失败
const BUN_PATH = resolveBunPath();
const REPORT_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";
const MAX_HISTORY = 100;
const TICK_INTERVAL_MS = 30_000; // 每 30 秒检查一次

// ============================================================
// 类型定义
// ============================================================

export type { CronJob } from "./lib/cron-job.js";
import type { CronJob } from "./lib/cron-job.js";

/** cron 临时 agent 缺省 effort(交互 agent 不受影响——它们走全局/registry 档)。 */
export const CRON_DEFAULT_EFFORT = "medium";

/** status 多一档 unknown：daemon 中断后结果未知 / 旧记录待核（lib/cron-run-recovery.ts），不重发 */
export type CronHistory = CronHistoryRow;

// 纯解析 / 匹配 / nextRun 在 lib/cron-expression.ts（manager、测试不必加载本入口）；这里原样再导出，老的 import 不用改。
export { parseCronExpression, cronMatches, nextCronTime } from "./lib/cron-expression.js";
import { nextCronTime, dueCronJobs, splitCronJobRows } from "./lib/cron-expression.js";

// ============================================================
// 存储
// ============================================================

const isJobsFile = (d: unknown): boolean => Array.isArray(d);

/**
 * 损坏时沿用上次成功读到的任务（daemon 冷启动就坏则为空），并响亮地报一次；saveJobs 拒绝覆盖坏文件——
 * 旧写法把解析失败当成 []，下一次 cron-add 就把全部任务清空。
 */
export async function loadJobs(): Promise<CronJob[]> {
  return readJsonLenient<CronJob[]>(CRON_PATH, [], { validate: isJobsFile, who: "cron" });
}

export async function saveJobs(jobs: CronJob[]): Promise<void> {
  // 原子写（进程写到一半被 launchd 重启不会留下截断的 JSON）+ 坏文件拒写
  await writeJsonStateGuarded(CRON_PATH, jobs, { validate: isJobsFile });
}

async function loadHistory(): Promise<CronHistory[]> {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const data = JSON.parse(await readFile(HISTORY_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveHistory(history: CronHistory[]): Promise<void> {
  // 历史只是日志：坏了就覆盖，不拦（拦了会让每次任务执行都抛）
  await writeJsonAtomic(HISTORY_PATH, history.slice(-MAX_HISTORY));
}

async function appendHistory(entry: CronHistory): Promise<void> {
  const history = await loadHistory();
  history.push(entry);
  await saveHistory(history);
}

async function updateHistory(id: string, update: Partial<CronHistory>): Promise<void> {
  const history = await loadHistory();
  const idx = history.findIndex((h) => h.id === id);
  if (idx >= 0) {
    Object.assign(history[idx], update);
    await saveHistory(history);
  }
}

// ============================================================
// Manager 调用
// ============================================================

// create 要等 Claude Code 起来（manager 自己的启动超时 + 清理），给足；其余短。
// 以前这里没有超时：manager 或它拉起的 tmux 挂住，这个任务就永远 running。
const CRON_MANAGER_TIMEOUT_MS: Record<string, number> = { list: 20_000, create: 300_000 };

async function runManager(...args: string[]): Promise<any> {
  return runManagerProcess(args, {
    bunPath: BUN_PATH,
    managerPath: MANAGER_PATH,
    env: { ...process.env, PATH: `${bunBinDir()}:${process.env.PATH}` },
    timeoutMs: CRON_MANAGER_TIMEOUT_MS[args[0] ?? ""] ?? 120_000,
  });
}

/**
 * 从临时 agent 的 session jsonl 里抽取它最后输出的 assistant 文本。
 * cron 完成通知用它把 agent 实际干了啥带回报告频道，而不是只发一句"✅ 完成"。
 * 取最后一条非空 assistant text（通常是 agent 的总结性回复）。抓不到返回 ""。
 */
async function extractAgentSummary(dir: string, sessionId: string): Promise<string> {
  try {
    let path = projectJsonlPath(dir, sessionId);
    if (!existsSync(path)) {
      const fallback = findJsonlBySessionId(sessionId);
      if (!fallback) return "";
      path = fallback;
    }
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    let last = "";
    for (const line of lines) {
      let rec: any;
      rec = translateSessionLine(runtimeForSessionPath(path), line);
      if (!rec) continue;
      if (rec.type !== "assistant") continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text.trim())
        .filter(Boolean)
        .join("\n");
      if (text) last = text;
    }
    return last.trim();
  } catch {
    return "";
  }
}

// ============================================================
// 任务执行
// ============================================================

// 认领、临时 agent 身份、截止时间都落在运行台账里（lib/cron-run-state.ts）：daemon 换了实例不重跑同一分钟，也接得上没收完的临时 agent
const runStore = createCronRunStore(statePath("cron-runs.json"));
const DAEMON_OWNER = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
const runningJobs = new Set<string>();
const liveRunKeys = new Set<string>();
const maxRuntimeMs = (job: CronJob) => (job.maxRuntime || 30) * 60 * 1000;
const reportChannelOf = (job: CronJob) => job.reportChannelId || REPORT_CHANNEL_ID || undefined;

/** 通知是附带的：没有频道就不发，发不出去只记日志，不让任务因此算失败 */
async function notifyTo(chatId: string | undefined, text: string): Promise<void> {
  if (!chatId) return;
  try { await notify({ source: "cron", chatId, text }); } catch (e) { console.error(`⚠️ cron 通知没发出去: ${(e as Error).message}`); }
}

// 停临时 agent 只走这组 manager 端口；停之前按会话 id 核身份（lib/cron-run-recovery.ts guardedStopTempAgent）
const agentPorts: CronAgentPorts = {
  listAgents: async () => agentsFromList(await runManager("list")),
  killAgent: async (agentName) => tempAgentCleanupFailure(await runManager("kill", agentName)), // 「不存在」= 已自清，不算失败
  isIdle: (agentName) => tmuxIsIdle(windowTarget(`agent-${agentName}`)),
};

/**
 * 老行为：spawn 临时 agent 跑一次，跑完销毁。零上下文（fresh Claude Code session）。
 * 适合"每周清一次日志"、"每天写个孤立周报"之类跟具体 agent 记忆无关的批处理。流程在 lib/cron-run-state-exec.ts。
 */
function executeOnTempAgent(job: CronJob, run: CronRunCtx, reportChannel: string | undefined, maxRuntime: number): Promise<CronRunOutcome> {
  return runCronTempAgent({
    store: runStore,
    agents: agentPorts,
    // cron 无人值守，走 bypassPermissions（auto 会弹权限框卡死）
    create: (agentName) => runManager(
      "create", agentName, job.dir, `cron: ${job.name}`, "--mode", "bypassPermissions",
      "--effort", job.effort || CRON_DEFAULT_EFFORT,
      ...(job.project ? ["--project", job.project] : []),
    ),
    sendPrompt: async (agentName, prompt) => { await tmuxSendLine(windowTarget(`agent-${agentName}`), prompt); },
    summary: (j, sessionId) => extractAgentSummary(j.dir, sessionId),
    notify: (text) => notifyTo(reportChannel, text),
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    log: console.log,
    error: console.error,
    timing: { readyMs: 3000, coldStartMs: 15_000, pollMs: 10_000, cleanupDelayMs: 2000 },
  }, job, run, maxRuntime);
}

/**
 * 定向到已存在的 agent：跟用户在它的 TUI 里敲字一样，tmux send-keys 把 prompt 塞进去，它在自己 session 里回答（继承对话历史、
 * config、记忆），不建临时 agent、不销毁。cron 一定要触发、不跳过（用户明确要求）：目标正忙也直接发，CC 把新输入接到当前回合
 * 之后处理（cron 不主动 C-c）。例外：停在额度菜单 / 撞墙倒计时上不发（lib/wall-screen.ts），记失败。
 */
async function executeOnExistingAgent(
  job: CronJob,
  run: CronRunCtx,
  reportChannel: string | undefined,
  maxRuntime: number,
): Promise<CronRunOutcome> {
  const agentShort = job.targetAgent!;
  const tmuxName = agentShort.startsWith("agent-") ? agentShort : `agent-${agentShort}`;
  const tmuxTarget = windowTarget(tmuxName); // 精确匹配：目标不在时别把提示词打进前缀同名的别的 agent

  console.log(`🚀 执行 cron 任务（打到现存 agent）: "${job.name}" → ${tmuxName}`);

  // 存在性校验：window 不存在（agent 被 kill / registry 名不对）就报 error，
  // 这种情况用户需要知道。但"agent 忙"不算错，照发。
  try {
    await tmuxRawStrict(["list-panes", "-t", tmuxTarget, "-F", "#{pane_id}"]); // 窗口不在会抛（isIdle 走 tmuxRaw 从不抛，display-message 会退回当前窗口）
  } catch {
    throw new Error(`目标 agent 不存在或未运行: ${tmuxName}`);
  }

  // 通知开始：**只在** reportChannel 跟 agent 自己 channel 不同的时候发，
  // 否则就是 agent 自己频道刷屏（agent 待会儿会自己回复，重复噪音）
  const targetChannelId = await lookupAgentChannelId(tmuxName);
  const notifyChannel = reportChannel !== targetChannelId ? reportChannel : undefined;
  await notifyTo(notifyChannel, `⏰ **定时任务开始**: ${job.name} → ${tmuxName}\n-# 💬 ${job.prompt.slice(0, 100)}`);

  // 发 prompt。忙不忙都发，Claude Code TUI 自己排队；停在额度菜单 / 撞墙倒计时上不发（lib/wall-screen.ts），这次记失败
  const wall = await windowWallWait(tmuxTarget);
  if (wall) throw new Error(`${tmuxName} ${wallWaitRefusal(wall)}，这次没发`);
  // 先在台账里记「要发了」再发：重启后看到它就知道 prompt 可能已出去，不重发；记不上就不发
  await runStore.update(run.key, (r) => { r.dispatchAttemptedAt = new Date().toISOString(); });
  await tmuxSendLine(tmuxTarget, job.prompt);

  // 等 agent 处理完（idle 恢复）。冷启动 15s + 10s 轮询。
  // 注意：agent 之前可能在忙别的事，这里等的是"忙别的 + cron prompt 都跑完"。
  await Bun.sleep(15_000);
  const startTime = Date.now();
  let completed = false;
  while (Date.now() - startTime < maxRuntime) {
    await Bun.sleep(10_000);
    try { if (await tmuxIsIdle(tmuxTarget)) { completed = true; break; } } catch { break; }
  }

  // 完成通知：agent 会自己 reply 到它自己频道，reportChannel != 目标 channel
  // 时才补一条"XX 完成"提示。同频道不重复发（agent 的 reply 已经足够）。
  await notifyTo(notifyChannel, `${completed ? "✅" : "⏰"} **定时任务${completed ? "完成" : "超时"}**: ${job.name} → ${tmuxName}`);
  return completed ? { status: "success" } : { status: "timeout", error: `超时 (${job.maxRuntime || 30} 分钟)` };
}

/** 从 registry 里根据 tmux 名（含 "agent-" 前缀）查该 agent 的 Discord channelId。 */
async function lookupAgentChannelId(tmuxName: string): Promise<string | undefined> {
  try {
    const agent = agentsFromList(await runManager("list")).find((a: any) => a.name === tmuxName);
    return agent?.channelId;
  } catch (e) {
    // manager 坏了 ≠ agent 没有频道：说清楚，别让通知静默少一半
    console.error(`⚠️ cron 查 ${tmuxName} 的频道失败: ${(e as Error).message}`);
    return undefined;
  }
}

/** 更新 lastRun 和 nextRun */
async function touchLastRun(job: CronJob): Promise<void> {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j?.id === job.id); // 热加载进来的坏记录（null）不该让回写 lastRun 失败
  if (idx < 0) return;
  jobs[idx].lastRun = new Date().toISOString();
  try {
    jobs[idx].nextRun = nextCronTime(jobs[idx].schedule).toISOString();
  } catch { /* 表达式解析不了：nextRun 留旧值，lastRun 照写 */ }
  await saveJobs(jobs);
}

const execDeps: CronExecDeps = {
  running: runningJobs,
  liveKeys: liveRunKeys,
  store: runStore,
  owner: DAEMON_OWNER,
  maxRuntimeMs,
  deadlineSlackMs: CRON_MANAGER_TIMEOUT_MS.create + 60_000,
  reportChannel: reportChannelOf,
  appendHistory,
  updateHistory,
  execute: (job, run) => {
    if (hasControlChar(job.prompt)) throw new Error(CRON_PROMPT_REFUSED); // 入口拦之前写进去的旧任务：\x1b[Z 会切掉权限模式
    const exec = job.targetAgent ? executeOnExistingAgent : executeOnTempAgent;
    return exec(job, run, reportChannelOf(job), maxRuntimeMs(job));
  },
  notifyFailure: (job, error) => notifyTo(reportChannelOf(job), `❌ **定时任务失败**: ${job.name}\n-# ${error.slice(0, 200)}`),
  touchLastRun,
  log: console.log,
  error: console.error,
};

/** now 决定认领的是哪一分钟：同一任务同一分钟只有一个 daemon 实例启动得了（tick 传它看到的时刻） */
export async function executeJob(job: CronJob, now: Date = new Date()): Promise<void> { // export 给 tests/cron-prompt-refuse.test.ts
  await runCronJobGuarded(execDeps, job, now);
}

// ============================================================
// 重启恢复
// ============================================================

/** 认领它的 daemon 进程还在不在（owner 以 pid 开头）。pid 被别的进程复用会误判成活着，所以恢复侧过了截止时间加宽限就不再信它 */
function ownerAlive(owner: string): boolean {
  const pid = Number(owner.split(".")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { return process.kill(pid, 0), true; } catch { return false; /* ESRCH：进程不在了 */ }
}

const recoveryDeps: CronRecoveryDeps = {
  store: runStore,
  agents: agentPorts,
  owner: DAEMON_OWNER,
  liveKeys: liveRunKeys,
  now: Date.now,
  ownerAlive,
  finishHistory: (id, patch) => updateHistory(id, patch),
  notify: (r, text) => notifyTo(r.reportChannel || REPORT_CHANNEL_ID || undefined, text),
  log: console.error,
  idleStreaks: new Map(),
  createSettleMs: CRON_MANAGER_TIMEOUT_MS.create + 30_000,
  ownerGraceMs: 120_000,
};
const recoveryLatch = createFailureLatch("cron 运行台账恢复");

/** 把没结束的运行记录各推进一步（接着监督 / 到期只收原会话 / 待核）。启动后每个 tick 跑一次，不重发任何 prompt */
export async function recoverCronRunsOnce() { // export 给 tests/cron-audit-run.test.ts
  const r = await recoverCronRuns(recoveryDeps);
  if (r.readError) recoveryLatch.fail(new Error(r.readError)); else recoveryLatch.ok();
  return r;
}

let recovering = false;
/** 不等它：list / kill 各有几十秒到两分钟的预算，等了会错过下一分钟的 tick */
function kickRecovery(): void {
  if (recovering) return;
  recovering = true;
  recoverCronRunsOnce().catch((e) => console.error("cron 恢复扫描异常:", e)).finally(() => { recovering = false; });
}

/** 旧版留下的 running 历史没有 agent 名和会话身份：标成待核、通知一次，不按任务名去猜、去停任何会话 */
async function markLegacyHistory(): Promise<void> {
  const history = await loadHistory();
  const marked = markLegacyRunningHistory(history, await runStore.list(), new Date().toISOString());
  if (marked.length === 0) return;
  await saveHistory(history);
  const lines = marked.slice(0, 10).map((h) => `-# ${h.jobName}（${h.startedAt}）`).join("\n");
  console.error(`⚠️ cron 旧运行记录待核 ${marked.length} 条（没有运行身份，没有停任何会话）`);
  await notifyTo(REPORT_CHANNEL_ID || undefined,
    `⚠️ **定时任务旧记录待核**（${marked.length} 条）\n${lines}\n` +
    "-# 这些记录没有 agent 名和会话身份，重启后没法恢复监督，也没有停任何会话；请核对是否还有残留的 cron-* 临时 agent");
}

// ============================================================
// 调度循环
// ============================================================

// 跟踪上一次 tick 检查的分钟，避免同一分钟内重复触发
let lastTickMinute = -1;

async function tick(): Promise<void> {
  const now = new Date();
  // 用 epoch 分钟数作为唯一标识，避免哈希碰撞
  const currentMinute = Math.floor(now.getTime() / 60_000);

  if (currentMinute === lastTickMinute) return;
  lastTickMinute = currentMinute;

  const { due, errors } = dueCronJobs(await loadJobs(), now);
  for (const { label, error } of errors) console.error(`cron 任务记录错误: ${label} — ${error.message}`);
  for (const job of due) {
    // 异步执行，不阻塞调度循环
    executeJob(job, now).catch((err) => {
      console.error(`cron 任务异常: "${job.name}" —`, err);
    });
  }
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  console.log("⏰ Cron Scheduler 启动");
  console.log(`   配置: ${CRON_PATH}`);
  console.log(`   历史: ${HISTORY_PATH}`);
  console.log(`   通知频道: ${REPORT_CHANNEL_ID || "(未设置)"}`);
  console.log(`   检查间隔: ${TICK_INTERVAL_MS / 1000}s`);

  // 确保配置目录存在
  await mkdir(CONFIG_DIR, { recursive: true });

  // 初始化 nextRun
  const jobs = await loadJobs();
  // 文件只校验到「是数组」：不是对象的记录（null 等）报一次就跳过，不能让它在首次 tick 之前把整个调度器带崩
  const { rows, errors } = splitCronJobRows(jobs);
  for (const { label, error } of errors) console.error(`cron 任务记录错误: ${label} — ${error.message}（已跳过，其余任务照常调度）`);
  let changed = false;
  for (const job of rows) {
    if (job.enabled && !job.nextRun) {
      try {
        job.nextRun = nextCronTime(job.schedule).toISOString();
        changed = true;
      } catch { /* non-critical */ }
    }
  }
  if (changed) await saveJobs(jobs); // 回写原数组：坏行原样留着，不替用户删

  // 列出所有任务
  if (rows.length > 0) {
    console.log(`\n📋 已加载 ${rows.length} 个任务:`);
    for (const job of rows) {
      const status = job.enabled ? "✅" : "⏸";
      console.log(`   ${status} ${job.name} — ${job.schedule} → ${job.dir}`);
    }
    console.log();
  } else {
    console.log("📭 没有定时任务\n");
  }

  // 监听配置文件变更（热重载）
  if (existsSync(CRON_PATH)) {
    watchFile(CRON_PATH, { interval: 5000 }, () => {
      console.log("🔄 检测到 cron.json 变更，下次 tick 时生效");
    });
  }
  void import("./lib/shared-ledger-mirror-loop.js").then((m) => m.startSharedLedgerMirrorLoop()).catch(() => console.error("共享台账镜像推送没启动")); // PJ1：自带定时器与异常隔离，不进下面的调度循环 tick
  void import("./lib/shared-ledger-auto-share-run.js").then((m) => m.startSharedLedgerAutoShareLoop()).catch(() => console.error("共享台账自动共享没启动")); // N8A：5 分钟一轮，子进程跑（N8A3）
  await markLegacyHistory().catch((e) => console.error(`⚠️ cron 旧运行记录没核成（下次启动再核）: ${(e as Error).message}`));
  while (true) {
    kickRecovery(); // 启动后第一轮就是重启恢复扫描；之后每轮重试上一轮没收完的
    try {
      await tick();
    } catch (err) {
      console.error("Tick 错误:", err);
    }
    await Bun.sleep(TICK_INTERVAL_MS);
  }
}

// 仅在直接运行时启动调度器（不在被 import 时启动）
// 这里才 enableTimestampLogs() —— manager.ts 会从本文件 import loadJobs 等工具，
// 不该让它的 console 被 wrap（会污染 JSON 输出）。
if (import.meta.main) {
  refuseInSandbox("跑 cron 调度器"); // 沙箱：lib/paths 按入口名拦不住 `bun -e 'import(...)'`，这里再拦一道
  enableTimestampLogs();
  initLang();
  // v2.19.0 认主守卫（见 lib/owner-guard.ts）。放在 import.meta.main 里——manager.ts 会 import 本文件的工具函数，那条路径不该被守卫拦。
  await (await import("./lib/owner-guard.js")).assertPrimaryOrExit("cron");
  main().catch((err) => {
    console.error("Cron Scheduler 崩溃:", err);
    process.exit(1);
  });
}
