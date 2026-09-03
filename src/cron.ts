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

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { enableTimestampLogs } from "./lib/log-timestamp.js";
import { initLang } from "./lib/i18n.js";
import { existsSync, watchFile } from "fs";
import { bridgeRequest } from "./lib/bridge-client.js";
import { projectJsonlPath, findJsonlBySessionId } from "./lib/jsonl-cost.js";
import {
  tmuxSendLine,
  tmuxCapture,
  isIdle as tmuxIsIdle,
} from "./lib/tmux-helper.js";

// ============================================================
// 配置
// ============================================================

const HOME = process.env.HOME || "~";
import { resolveBunPath } from "./lib/bun-path.js";
import { installCrashGuard } from "./lib/crash-guard.js";

// 进程级异常兜底：保证死因一定进 stderr（见 lib/crash-guard.ts）
installCrashGuard("cron");

import { initDaemonLogs } from "./lib/log-paths.js";
initDaemonLogs("cron");

const CONFIG_DIR = `${HOME}/.claude-orchestrator`;
const CRON_PATH = `${CONFIG_DIR}/cron.json`;
const HISTORY_PATH = `${CONFIG_DIR}/cron-history.json`;
const MANAGER_PATH = `${import.meta.dir}/manager.ts`;
// 见 lib/bun-path.ts：写死 ~/.bun 会让 brew/mise 装 bun 的人所有 cron 任务静默失败
const BUN_PATH = resolveBunPath();
const REPORT_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";
const MAX_HISTORY = 100;
const TICK_INTERVAL_MS = 30_000; // 每 30 秒检查一次

// ============================================================
// 类型定义
// ============================================================

export interface CronJob {
  id: string;
  name: string;
  schedule: string;         // cron 表达式 (分 时 日 月 周)
  prompt: string;           // 发给 agent 的指令
  dir: string;              // 工作目录（targetAgent 模式下未使用，为向后兼容保留字段）
  enabled: boolean;
  reportChannelId?: string; // 结果通知频道（默认用 CONTROL_CHANNEL_ID）
  maxRuntime?: number;      // 最大运行时间（分钟，默认 30）
  lastRun?: string;         // ISO timestamp
  nextRun?: string;         // ISO timestamp
  createdAt: string;        // ISO timestamp
  /**
   * v2.4.18+ 定向到已存在的 agent。设了这个字段就不 spawn 临时 agent，直接把
   * prompt 发到目标 agent 的 tmux window（等同用户在 Discord 里给它敲字）。
   * agent 在自己 session 里回答，完整继承对话历史 / 上下文 / mem0 记忆访问。
   * 不设 = 老行为（每次建临时 agent、跑完销毁）。
   *
   * 值是 agent 短名（不带 "agent-" 前缀，跟 CLI 一致）。
   */
  targetAgent?: string;
  /**
   * v2.21.3+ 临时 agent 的 effort 档(low|medium|high|xhigh|max)。缺省 medium——
   * Fable 5.1 文档:medium ≈ Fable 5 且更便宜;无人值守批处理不值得 xhigh 的
   * 额度与时延。targetAgent 模式下无意义(用目标 agent 自己的档),不传。
   */
  effort?: string;
}

/** cron 临时 agent 缺省 effort(交互 agent 不受影响——它们走全局/registry 档)。 */
export const CRON_DEFAULT_EFFORT = "medium";

export interface CronHistory {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "error" | "timeout";
  error?: string;
}

// ============================================================
// Cron 表达式解析器
// ============================================================

interface CronField {
  values: Set<number>;
}

function parseCronField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      values.add(parseInt(range));
    }
  }

  return { values };
}

export function parseCronExpression(expr: string): {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
} {
  // 支持常用别名
  const aliases: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
  };

  const resolved = aliases[expr.trim()] || expr.trim();
  const parts = resolved.split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`无效的 cron 表达式: "${expr}" (需要 5 个字段: 分 时 日 月 周)`);
  }

  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  };
}

export function cronMatches(expr: string, date: Date): boolean {
  const cron = parseCronExpression(expr);
  return (
    cron.minute.values.has(date.getMinutes()) &&
    cron.hour.values.has(date.getHours()) &&
    cron.dayOfMonth.values.has(date.getDate()) &&
    cron.month.values.has(date.getMonth() + 1) &&
    cron.dayOfWeek.values.has(date.getDay())
  );
}

/** 计算下一次触发时间（从 now 开始，最多往后找 366 天） */
export function nextCronTime(expr: string, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const limit = 366 * 24 * 60; // 最多检查一年
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }

  throw new Error(`无法计算下次触发时间: "${expr}"`);
}

// ============================================================
// 存储
// ============================================================

/**
 * 原子写：先写同目录临时文件再 rename。直接 writeFile 的话，进程在写到一半时
 * 被 launchd 重启 / 机器断电，就会留下一个被截断的 JSON —— 下次 load 解析失败
 * 返回空数组，所有定时任务静默消失。rename 在同一文件系统内是原子的。
 */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function loadJobs(): Promise<CronJob[]> {
  if (!existsSync(CRON_PATH)) return [];
  try {
    const data = JSON.parse(await readFile(CRON_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: CronJob[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFileAtomic(CRON_PATH, JSON.stringify(jobs, null, 2));
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
  await writeFileAtomic(HISTORY_PATH, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
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

async function runManager(...args: string[]): Promise<any> {
  const proc = Bun.spawn([BUN_PATH, "run", MANAGER_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${HOME}/.bun/bin:${process.env.PATH}` },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out.trim());
  } catch {
    return { ok: false, error: out.trim() || "manager 执行失败" };
  }
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
      try { rec = JSON.parse(line); } catch { continue; }
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

const runningJobs = new Set<string>();

/**
 * 老行为：spawn 临时 agent 跑一次，跑完销毁。零上下文（fresh Claude Code session）。
 * 适合"每周清一次日志"、"每天写个孤立周报"之类跟具体 agent 记忆无关的批处理。
 */
async function executeOnTempAgent(
  job: CronJob,
  historyId: string,
  reportChannel: string | undefined,
  maxRuntime: number,
): Promise<void> {
  const agentName = `cron-${job.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Date.now().toString(36)}`;
  console.log(`🚀 执行 cron 任务（临时 agent）: "${job.name}" → agent ${agentName}`);

  if (reportChannel) {
    try {
      await bridgeRequest({
        type: "reply",
        chatId: reportChannel,
        text: `⏰ **定时任务开始**: ${job.name}\n-# 📁 ${job.dir}\n-# 💬 ${job.prompt.slice(0, 100)}`,
      });
    } catch { /* non-critical */ }
  }

  try {
    // 建 agent — cron 无人值守，走 bypassPermissions（auto 会弹权限框卡死）
    const createResult = await runManager(
      "create", agentName, job.dir, `cron: ${job.name}`, "--mode", "bypassPermissions",
      "--effort", job.effort || CRON_DEFAULT_EFFORT,
    );
    if (!createResult.ok) throw new Error(`创建 agent 失败: ${createResult.error}`);

    const tmpSessionId = createResult.sessionId as string | undefined;
    await Bun.sleep(3000); // 等 agent 就绪

    const tmuxTarget = `master:agent-${agentName}`;
    await tmuxSendLine(tmuxTarget, job.prompt);

    // 等完成 —— 15s 冷启动 + 10s 轮询 idle
    await Bun.sleep(15_000);
    const startTime = Date.now();
    let completed = false;
    while (Date.now() - startTime < maxRuntime) {
      await Bun.sleep(10_000);
      try { if (await tmuxIsIdle(tmuxTarget)) { completed = true; break; } } catch { break; }
    }

    const status = completed ? "success" : "timeout";
    await updateHistory(historyId, {
      finishedAt: new Date().toISOString(),
      status,
      error: completed ? undefined : `超时 (${job.maxRuntime || 30} 分钟)`,
    });

    if (reportChannel) {
      try {
        const emoji = completed ? "✅" : "⏰";
        const statusText = completed ? "完成" : "超时";
        let body = `${emoji} **定时任务${statusText}**: ${job.name}`;
        if (completed && tmpSessionId) {
          const summary = await extractAgentSummary(job.dir, tmpSessionId);
          if (summary) body += `\n\n${summary}`;
        }
        await bridgeRequest({ type: "reply", chatId: reportChannel, text: body });
      } catch { /* non-critical */ }
    }
  } finally {
    // 清理临时 agent（成功、超时、异常都跑一次）
    try {
      await Bun.sleep(2000);
      await runManager("kill", agentName);
    } catch { /* non-critical */ }
  }
}

/**
 * v2.4.18+ 定向到已存在的 agent。跟"用户在 Discord 里给 agent 敲字"一模一样：
 * 通过 tmux send-keys 把 prompt 塞进目标 agent 的 TUI，agent 在自己 session 里
 * 回答（继承对话历史 + config + mem0 访问权）。不建临时 agent、不销毁。
 *
 * 冲突处理：**cron 一定要触发，不跳过**（用户明确要求）。目标 agent 正忙也直接
 * 发进去 —— Claude Code TUI 会把新输入接到当前 turn 结束后处理（跟用户在 Discord
 * 里对着忙碌的 agent 敲字同样的行为，只不过 cron 路径不主动 C-c，让当前工作跑完
 * 再处理 cron 的 prompt）。
 */
async function executeOnExistingAgent(
  job: CronJob,
  historyId: string,
  reportChannel: string | undefined,
  maxRuntime: number,
): Promise<void> {
  const agentShort = job.targetAgent!;
  const tmuxName = agentShort.startsWith("agent-") ? agentShort : `agent-${agentShort}`;
  const tmuxTarget = `master:${tmuxName}`;

  console.log(`🚀 执行 cron 任务（打到现存 agent）: "${job.name}" → ${tmuxName}`);

  // 存在性校验：window 不存在（agent 被 kill / registry 名不对）就报 error，
  // 这种情况用户需要知道。但"agent 忙"不算错，照发。
  try {
    await tmuxIsIdle(tmuxTarget); // 只测能不能访问 window，不管返回值
  } catch {
    throw new Error(`目标 agent 不存在或未运行: ${tmuxName}`);
  }

  // 通知开始：**只在** reportChannel 跟 agent 自己 channel 不同的时候发，
  // 否则就是 agent 自己频道刷屏（agent 待会儿会自己回复，重复噪音）
  const targetChannelId = await lookupAgentChannelId(tmuxName);
  const shouldNotifyStart = reportChannel && reportChannel !== targetChannelId;
  if (shouldNotifyStart) {
    try {
      await bridgeRequest({
        type: "reply",
        chatId: reportChannel!,
        text: `⏰ **定时任务开始**: ${job.name} → ${tmuxName}\n-# 💬 ${job.prompt.slice(0, 100)}`,
      });
    } catch { /* non-critical */ }
  }

  // 发 prompt。忙不忙都发，Claude Code TUI 自己排队。
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

  const status = completed ? "success" : "timeout";
  await updateHistory(historyId, {
    finishedAt: new Date().toISOString(),
    status,
    error: completed ? undefined : `超时 (${job.maxRuntime || 30} 分钟)`,
  });

  // 完成通知：agent 会自己 reply 到它自己频道，reportChannel != 目标 channel
  // 时才补一条"XX 完成"提示。同频道不重复发（agent 的 reply 已经足够）。
  if (reportChannel && reportChannel !== targetChannelId) {
    try {
      const emoji = completed ? "✅" : "⏰";
      const statusText = completed ? "完成" : "超时";
      await bridgeRequest({
        type: "reply",
        chatId: reportChannel,
        text: `${emoji} **定时任务${statusText}**: ${job.name} → ${tmuxName}`,
      });
    } catch { /* non-critical */ }
  }
}

/** 从 registry 里根据 tmux 名（含 "agent-" 前缀）查该 agent 的 Discord channelId。 */
async function lookupAgentChannelId(tmuxName: string): Promise<string | undefined> {
  try {
    const r = await runManager("list");
    const agent = (r.agents || []).find((a: any) => a.name === tmuxName);
    return agent?.channelId;
  } catch {
    return undefined;
  }
}

async function executeJob(job: CronJob): Promise<void> {
  if (runningJobs.has(job.id)) {
    console.log(`⏭ 跳过 "${job.name}" — 上一次执行尚未完成`);
    return;
  }

  runningJobs.add(job.id);
  const historyId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reportChannel = job.reportChannelId || REPORT_CHANNEL_ID;
  const maxRuntime = (job.maxRuntime || 30) * 60 * 1000;

  // 记录开始
  await appendHistory({
    id: historyId,
    jobId: job.id,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  try {
    if (job.targetAgent) {
      await executeOnExistingAgent(job, historyId, reportChannel, maxRuntime);
    } else {
      await executeOnTempAgent(job, historyId, reportChannel, maxRuntime);
    }
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`❌ cron 任务执行失败: "${job.name}" — ${errorMsg}`);

    await updateHistory(historyId, {
      finishedAt: new Date().toISOString(),
      status: "error",
      error: errorMsg,
    });

    if (reportChannel) {
      try {
        await bridgeRequest({
          type: "reply",
          chatId: reportChannel,
          text: `❌ **定时任务失败**: ${job.name}\n-# ${errorMsg.slice(0, 200)}`,
        });
      } catch { /* non-critical */ }
    }
  } finally {
    runningJobs.delete(job.id);
    // 更新 lastRun 和 nextRun
    const jobs = await loadJobs();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      jobs[idx].lastRun = new Date().toISOString();
      try {
        jobs[idx].nextRun = nextCronTime(jobs[idx].schedule).toISOString();
      } catch { /* non-critical */ }
      await saveJobs(jobs);
    }
  }
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

  const jobs = await loadJobs();
  for (const job of jobs) {
    if (!job.enabled) continue;
    try {
      if (cronMatches(job.schedule, now)) {
        // 异步执行，不阻塞调度循环
        executeJob(job).catch((err) => {
          console.error(`cron 任务异常: "${job.name}" —`, err);
        });
      }
    } catch (err) {
      console.error(`cron 表达式错误: "${job.name}" — ${(err as Error).message}`);
    }
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
  let changed = false;
  for (const job of jobs) {
    if (job.enabled && !job.nextRun) {
      try {
        job.nextRun = nextCronTime(job.schedule).toISOString();
        changed = true;
      } catch { /* non-critical */ }
    }
  }
  if (changed) await saveJobs(jobs);

  // 列出所有任务
  if (jobs.length > 0) {
    console.log(`\n📋 已加载 ${jobs.length} 个任务:`);
    for (const job of jobs) {
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

  // 调度循环
  while (true) {
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
  enableTimestampLogs();
  initLang();
  // v2.19.0 认主守卫（见 lib/owner-guard.ts）。放在 import.meta.main 里——
  // manager.ts 会 import 本文件的工具函数，那条路径不该被守卫拦。
  await (await import("./lib/owner-guard.js")).assertPrimaryOrExit("cron");
  main().catch((err) => {
    console.error("Cron Scheduler 崩溃:", err);
    process.exit(1);
  });
}
