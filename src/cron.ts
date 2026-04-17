#!/usr/bin/env bun
/**
 * Cron Scheduler — 定时任务调度器
 *
 * pm2 管理的守护进程，按 cron 表达式调度任务。
 * 每个任务触发时：创建临时 agent → 发送 prompt → 等待完成 → 通知 → 销毁。
 *
 * 存储：~/.claude-orchestrator/cron.json
 * 日志：~/.claude-orchestrator/cron-history.json（最近 100 条执行记录）
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, watchFile } from "fs";
import { bridgeRequest } from "./lib/bridge-client.js";
import {
  tmuxSendLine,
  tmuxCapture,
  isIdle as tmuxIsIdle,
} from "./lib/tmux-helper.js";

// ============================================================
// 配置
// ============================================================

const HOME = process.env.HOME || "~";
const CONFIG_DIR = `${HOME}/.claude-orchestrator`;
const CRON_PATH = `${CONFIG_DIR}/cron.json`;
const HISTORY_PATH = `${CONFIG_DIR}/cron-history.json`;
const MANAGER_PATH = `${import.meta.dir}/manager.ts`;
const BUN_PATH = `${HOME}/.bun/bin/bun`;
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
  dir: string;              // 工作目录
  enabled: boolean;
  reportChannelId?: string; // 结果通知频道（默认用 CONTROL_CHANNEL_ID）
  maxRuntime?: number;      // 最大运行时间（分钟，默认 30）
  lastRun?: string;         // ISO timestamp
  nextRun?: string;         // ISO timestamp
  createdAt: string;        // ISO timestamp
}

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
  await writeFile(CRON_PATH, JSON.stringify(jobs, null, 2));
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
  await writeFile(HISTORY_PATH, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
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

// ============================================================
// 任务执行
// ============================================================

const runningJobs = new Set<string>();

async function executeJob(job: CronJob): Promise<void> {
  if (runningJobs.has(job.id)) {
    console.log(`⏭ 跳过 "${job.name}" — 上一次执行尚未完成`);
    return;
  }

  runningJobs.add(job.id);
  const historyId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reportChannel = job.reportChannelId || REPORT_CHANNEL_ID;
  const maxRuntime = (job.maxRuntime || 30) * 60 * 1000;
  const agentName = `cron-${job.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Date.now().toString(36)}`;

  console.log(`🚀 执行 cron 任务: "${job.name}" → agent ${agentName}`);

  // 记录开始
  await appendHistory({
    id: historyId,
    jobId: job.id,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  // 通知开始
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
    // 1. 创建 agent
    const createResult = await runManager("create", agentName, job.dir, `cron: ${job.name}`);
    if (!createResult.ok) {
      throw new Error(`创建 agent 失败: ${createResult.error}`);
    }

    const channelId = createResult.channelId;

    // 2. 等待 agent 就绪
    await Bun.sleep(3000);

    // 3. 发送 prompt（通过 tmux send-keys）
    const tmuxTarget = `master:agent-${agentName}`;
    await tmuxSendLine(tmuxTarget, job.prompt);

    // 4. 等待完成（轮询 idle 状态）
    // 先等 15 秒让 agent 开始处理（避免检测到发送前的 ❯ 提示符）
    await Bun.sleep(15_000);
    const startTime = Date.now();
    let completed = false;

    while (Date.now() - startTime < maxRuntime) {
      await Bun.sleep(10_000); // 每 10 秒检查一次
      try {
        if (await tmuxIsIdle(tmuxTarget)) {
          completed = true;
          break;
        }
      } catch {
        // window 可能已经不存在了
        break;
      }
    }

    // 5. 更新状态
    const status = completed ? "success" : "timeout";
    await updateHistory(historyId, {
      finishedAt: new Date().toISOString(),
      status,
      error: completed ? undefined : `超时 (${job.maxRuntime || 30} 分钟)`,
    });

    // 6. 通知结果
    if (reportChannel) {
      try {
        const emoji = completed ? "✅" : "⏰";
        const statusText = completed ? "完成" : "超时";
        await bridgeRequest({
          type: "reply",
          chatId: reportChannel,
          text: `${emoji} **定时任务${statusText}**: ${job.name}`,
        });
      } catch { /* non-critical */ }
    }

    // 7. 销毁临时 agent
    await Bun.sleep(2000);
    await runManager("kill", agentName);

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

    // 尝试清理
    try { await runManager("kill", agentName); } catch { /* non-critical */ }
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
if (import.meta.main) {
  main().catch((err) => {
    console.error("Cron Scheduler 崩溃:", err);
    process.exit(1);
  });
}
