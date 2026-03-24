#!/usr/bin/env bun
/**
 * Worker Manager CLI
 *
 * 管理 Claude Code worker 的生命周期：创建、恢复、销毁、列表。
 * 可被大总管通过 Bash 调用，也可独立命令行使用。
 *
 * Usage:
 *   bun src/manager.ts create <name> <dir> [purpose]
 *   bun src/manager.ts resume <name> <sessionId> [dir]
 *   bun src/manager.ts kill <name>
 *   bun src/manager.ts list
 *   bun src/manager.ts sessions [search]
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ============================================================
// 配置
// ============================================================

const SOCK = "/tmp/claude-orchestrator/master.sock";
const REGISTRY_PATH = `${process.env.HOME}/.claude-orchestrator/registry.json`;
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const WORKER_PREFIX = "worker-";
const CATEGORY_NAME = "workers";

// ============================================================
// Registry
// ============================================================

interface WorkerInfo {
  project: string;
  purpose: string;
  created: string;
  status: "active" | "stopped";
  channelId: string;
  notes: string;
  sessionId?: string;
  cwd: string;
  displayName?: string;
}

interface Registry {
  socket: string;
  workers: Record<string, WorkerInfo>;
}

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) {
    const empty: Registry = { socket: SOCK, workers: {} };
    await saveRegistry(empty);
    return empty;
  }
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
}

async function saveRegistry(reg: Registry) {
  await mkdir(`${process.env.HOME}/.claude-orchestrator`, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ============================================================
// tmux 工具函数
// 所有 worker 是 master session 里的 window（不是独立 session）
// 这样 iTerm2 -CC 模式下每个 worker 都是一个 tab
// ============================================================

const MASTER_SESSION = "master";

async function tmuxRaw(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", "-S", SOCK, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function ensureSocket() {
  await mkdir("/tmp/claude-orchestrator", { recursive: true });
}

/** tmux window target: master:worker-xxx */
function windowTarget(name: string): string {
  return `${MASTER_SESSION}:${name}`;
}

async function listWorkerWindows(): Promise<string[]> {
  const out = await tmuxRaw([
    "list-windows",
    "-t", MASTER_SESSION,
    "-F", "#{window_name}",
  ]);
  if (!out) return [];
  return out.split("\n").filter((w) => w.startsWith(WORKER_PREFIX));
}

async function windowExists(name: string): Promise<boolean> {
  const windows = await listWorkerWindows();
  return windows.includes(name);
}

async function isWorkerIdle(name: string): Promise<boolean> {
  const tail = await tmuxRaw(["capture-pane", "-t", windowTarget(name), "-p"]);
  const last5 = tail.split("\n").slice(-5).join("\n");
  return /❯/.test(last5);
}

async function captureLast(name: string, lines = 40): Promise<string> {
  return tmuxRaw(["capture-pane", "-t", windowTarget(name), "-p", "-J", "-S", `-${lines}`]);
}

// ============================================================
// Bridge WebSocket Client
// ============================================================

async function bridgeRequest(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    const requestId = `mgr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Bridge 请求超时 (10s)"));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ ...msg, requestId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (data.requestId === requestId) {
          clearTimeout(timer);
          ws.close();
          if (data.error) reject(new Error(data.error));
          else resolve(data.result);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("无法连接 Bridge。请确认: pm2 start --only discord-bridge"));
    };
  });
}

// ============================================================
// Claude Code Session 扫描
// ============================================================

interface ClaudeSession {
  sessionId: string;
  cwd: string;
  slug: string;
  modifiedAt: Date;
  lastUserMessage: string;
}

async function scanClaudeSessions(search?: string): Promise<ClaudeSession[]> {
  const projectsDir = join(process.env.HOME || "~", ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: ClaudeSession[] = [];
  const projectDirs = await readdir(projectsDir);

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const files = await readdir(projPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.includes("compact")) continue;
      const uuid = file.replace(".jsonl", "");
      if (!/^[0-9a-f]{8}-/.test(uuid)) continue;

      const filePath = join(projPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      try {
        const fd = Bun.file(filePath);
        const chunk = await fd.slice(0, 8192).text();
        const lines = chunk.split("\n").filter((l) => l.trim());

        let sessionId = uuid;
        let cwd = "";
        let slug = "";

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId) sessionId = obj.sessionId;
            if (obj.cwd && !cwd) cwd = obj.cwd;
            if (obj.slug && !slug) slug = obj.slug;
            if (cwd && slug) break;
          } catch {}
        }

        if (!cwd) continue;

        if (search) {
          const q = search.toLowerCase();
          const haystack = `${cwd} ${slug} ${sessionId}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        // 从文件尾部读取最后一条用户文字消息（跳过 tool_result）
        let lastUserMessage = "";
        try {
          const size = fileStat.size;
          const tailStart = Math.max(0, size - 500_000);
          const tailChunk = await fd.slice(tailStart, size).text();
          const tailLines = tailChunk.split("\n").filter((l) => l.trim());
          for (let i = tailLines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(tailLines[i]);
              if (entry.type !== "user") continue;
              const content = entry.message?.content;
              let text = "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find(
                  (b: any) => b.type === "text" && b.text?.length > 3
                );
                if (textBlock) text = textBlock.text;
              }
              if (text && text.length > 3) {
                // 提取 <channel> 标签内的实际内容
                const channelMatch = text.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
                if (channelMatch) text = channelMatch[1].trim();
                lastUserMessage = text.replace(/\n/g, " ").slice(0, 80);
                break;
              }
            } catch {}
          }
        } catch {}

        sessions.push({ sessionId, cwd, slug, modifiedAt: fileStat.mtime, lastUserMessage });
      } catch {}
    }
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

// ============================================================
// 对话历史提取
// ============================================================

function cwdToProjectDir(cwd: string): string {
  return "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

async function extractRecentChat(
  cwd: string,
  sessionId: string,
  maxTurns = 5
): Promise<ChatTurn[]> {
  const projectDir = cwdToProjectDir(cwd);
  const jsonlPath = join(
    process.env.HOME || "~",
    ".claude",
    "projects",
    projectDir,
    `${sessionId}.jsonl`
  );
  if (!existsSync(jsonlPath)) return [];

  try {
    const file = Bun.file(jsonlPath);
    const size = file.size;
    const chunk = await file.slice(Math.max(0, size - 500_000), size).text();
    const lines = chunk.split("\n").filter((l) => l.trim());

    const turns: ChatTurn[] = [];

    for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns * 2; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== "user" && entry.type !== "assistant") continue;

        const content = entry.message?.content;
        let text = "";

        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          // 提取普通 text blocks
          const textBlocks = content
            .filter((b: any) => b.type === "text" && b.text?.length > 3)
            .map((b: any) => b.text);
          // 提取 reply tool_use 的 text 参数（Discord 回复）
          const replyBlocks = content
            .filter((b: any) => b.type === "tool_use" && b.name === "reply" && b.input?.text)
            .map((b: any) => b.input.text);
          text = [...textBlocks, ...replyBlocks].join("\n");
        }

        if (!text || text.length < 4) continue;

        // 提取 <channel> 标签内的内容
        const channelMatch = text.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
        if (channelMatch) text = channelMatch[1].trim();

        // 截断过长的内容
        if (text.length > 300) text = text.slice(0, 297) + "...";

        turns.unshift({ role: entry.type as "user" | "assistant", text });
      } catch {}
    }

    return turns.slice(-maxTurns * 2);
  } catch {
    return [];
  }
}

async function sendChatHistory(
  channelId: string,
  turns: ChatTurn[]
): Promise<void> {
  if (turns.length === 0) return;

  const lines = turns.map((t) => {
    const prefix = t.role === "user" ? "👤" : "🤖";
    return `${prefix} ${t.text}`;
  });

  const header = "**📜 最近对话回顾**\n\n" + lines.join("\n\n");

  // 分块发送（Discord 2000 字符限制）
  const chunks: string[] = [];
  let current = "**📜 最近对话回顾**\n\n";

  for (const line of lines) {
    if ((current + line + "\n\n").length > 1900) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());

  for (const chunk of chunks) {
    await bridgeRequest({ type: "reply", chatId: channelId, text: chunk });
    await Bun.sleep(500);
  }
}

// ============================================================
// 辅助
// ============================================================

function normalizeName(raw: string): string {
  return `${WORKER_PREFIX}${raw.replace(WORKER_PREFIX, "")}`.toLowerCase();
}

function formatAge(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function output(data: Record<string, unknown>) {
  console.log(JSON.stringify(data));
}

// ============================================================
// 命令实现
// ============================================================

async function cmdCreate(name: string, dir: string, purpose: string = "") {
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(WORKER_PREFIX, "");

  // 检查是否已存在
  if (await windowExists(tmuxName)) {
    output({ ok: false, error: `${tmuxName} 已存在` });
    return;
  }

  // 1. 创建 Discord 频道
  let channelId: string;
  try {
    const result = await bridgeRequest({
      type: "create_channel",
      name: channelName,
      category: CATEGORY_NAME,
    });
    channelId = result.channelId;
  } catch (err) {
    output({ ok: false, error: `创建 Discord 频道失败: ${(err as Error).message}` });
    return;
  }

  // 2. 创建 tmux window（在 master session 里）
  const expandedDir = dir.replace(/^~/, process.env.HOME || "~");
  await ensureSocket();
  await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", expandedDir]);
  await Bun.sleep(500);

  // 3. 启动 Claude Code
  const target = windowTarget(tmuxName);
  const sessionId = crypto.randomUUID();
  const cmd = `DISCORD_CHANNEL_ID=${channelId} BRIDGE_URL=${BRIDGE_URL} claude --session-id ${sessionId} --dangerously-load-development-channels server:discord-bridge --dangerously-skip-permissions`;
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", cmd]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 4. 轮询等待就绪，遇到确认提示自动按 Enter
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const pane = await captureLast(tmuxName, 10);
    // 检查 development channels 确认提示
    if (pane.includes("I am using this for local development")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }
    if (await isWorkerIdle(tmuxName)) {
      ready = true;
      break;
    }
  }

  // 6. 更新 registry
  const reg = await loadRegistry();
  reg.workers[tmuxName] = {
    project: dir,
    purpose,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: "",
    sessionId,
    cwd: expandedDir,
  };
  await saveRegistry(reg);

  output({
    ok: true,
    worker: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    message: ready
      ? `Worker ${tmuxName} 已创建，Discord 频道 #${channelName} 已就绪`
      : `Worker ${tmuxName} 已创建，但 Claude Code 可能还在启动中`,
  });
}

async function cmdResume(
  name: string,
  sessionId: string,
  dir?: string
) {
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(WORKER_PREFIX, "");

  if (await windowExists(tmuxName)) {
    output({ ok: false, error: `${tmuxName} 已存在` });
    return;
  }

  // 如果没有指定目录，从 session 文件找
  let resolvedDir = dir?.replace(/^~/, process.env.HOME || "~") || "";
  if (!resolvedDir) {
    const sessions = await scanClaudeSessions();
    const match = sessions.find((s) => s.sessionId === sessionId);
    if (match) {
      resolvedDir = match.cwd;
    } else {
      output({ ok: false, error: `找不到 session ${sessionId} 的工作目录，请用第三个参数指定` });
      return;
    }
  }

  // 创建 Discord 频道
  let channelId: string;
  try {
    const result = await bridgeRequest({
      type: "create_channel",
      name: channelName,
      category: CATEGORY_NAME,
    });
    channelId = result.channelId;
  } catch (err) {
    output({ ok: false, error: `创建 Discord 频道失败: ${(err as Error).message}` });
    return;
  }

  // 发送对话历史到新频道
  const chatHistory = await extractRecentChat(resolvedDir, sessionId, 5);
  if (chatHistory.length > 0) {
    await sendChatHistory(channelId, chatHistory);
  }

  // 创建 tmux window（在 master session 里）
  await ensureSocket();
  await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", resolvedDir]);
  await Bun.sleep(500);

  // 启动 Claude Code（resume 模式）
  const target = windowTarget(tmuxName);
  const displayName = channelName;
  const cmd = `DISCORD_CHANNEL_ID=${channelId} BRIDGE_URL=${BRIDGE_URL} claude --resume ${sessionId} --name "${displayName}" --dangerously-load-development-channels server:discord-bridge --dangerously-skip-permissions`;
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", cmd]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 轮询等待，遇到确认提示自动按 Enter
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const pane = await captureLast(tmuxName, 10);
    if (pane.includes("I am using this for local development")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }
    if (await isWorkerIdle(tmuxName)) {
      ready = true;
      break;
    }
  }

  // 更新 registry
  const reg = await loadRegistry();
  reg.workers[tmuxName] = {
    project: dir || resolvedDir.replace(process.env.HOME || "", "~"),
    purpose: `resumed: ${sessionId.slice(0, 8)}`,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: `claude session: ${sessionId}`,
    sessionId,
    cwd: resolvedDir,
    displayName: channelName,
  };
  await saveRegistry(reg);

  output({
    ok: true,
    worker: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    message: ready
      ? `Worker ${tmuxName} 已恢复，Discord 频道 #${channelName} 已就绪`
      : `Worker ${tmuxName} 已恢复，但 Claude Code 可能还在启动中`,
  });
}

async function cmdKill(name: string) {
  const tmuxName = normalizeName(name);

  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }

  await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);

  // 删除对应的 Discord 频道
  const reg = await loadRegistry();
  const info = reg.workers[tmuxName];
  if (info?.channelId) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId: info.channelId });
    } catch {}
  }
  if (reg.workers[tmuxName]) {
    reg.workers[tmuxName].status = "stopped";
  }

  // 清理 registry 里同名的大小写变体（历史遗留）
  for (const key of Object.keys(reg.workers)) {
    if (key.toLowerCase() === tmuxName && key !== tmuxName) {
      delete reg.workers[key];
    }
  }
  await saveRegistry(reg);

  output({
    ok: true,
    worker: tmuxName,
    message: `${tmuxName} 已销毁。`,
  });
}

// ============================================================
// 优雅退出 + 重启
// ============================================================

/** 等待 tmux window 到达 shell 提示符（$ 或 %） */
async function waitForShell(name: string, timeoutMs = 15000): Promise<boolean> {
  const target = windowTarget(name);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pane = await captureLast(name, 5);
    // macOS zsh 提示符通常以 % 结尾，bash 以 $ 结尾
    if (/[%$]\s*$/.test(pane)) return true;
    await Bun.sleep(500);
  }
  return false;
}

/** 优雅退出一个 Claude Code worker，处理所有确认弹窗 */
async function gracefulExit(name: string): Promise<boolean> {
  const target = windowTarget(name);

  // 先发 Ctrl+C 打断任何正在进行的操作
  await tmuxRaw(["send-keys", "-t", target, "C-c"]);
  await Bun.sleep(1000);

  // 再发一次 Ctrl+C 以防第一次没打断
  await tmuxRaw(["send-keys", "-t", target, "C-c"]);
  await Bun.sleep(1000);

  // 发 /exit
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", "/exit"]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 轮询处理各种确认提示，最多等 20 秒
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 8);

    // 已经回到 shell
    if (/[%$]\s*$/.test(pane)) return true;

    // Claude Code 退出确认 ("has unsaved changes" 等)
    if (pane.includes("Yes") && (pane.includes("Do you want") || pane.includes("Are you sure"))) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }

    // 任何 "Enter to confirm" 类型的提示
    if (pane.includes("Enter to confirm") || pane.includes("确认")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }
  }

  // 最后检查
  const finalPane = await captureLast(name, 3);
  return /[%$]\s*$/.test(finalPane);
}

/** 在已有的 tmux window 里启动 Claude Code，处理所有确认弹窗 */
async function startClaudeInWindow(
  name: string,
  claudeCmd: string
): Promise<boolean> {
  const target = windowTarget(name);

  // 发送启动命令
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", claudeCmd]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 轮询处理各种确认提示，最多等 45 秒
  for (let i = 0; i < 90; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // Claude Code 就绪
    if (/❯/.test(pane.split("\n").slice(-5).join("\n"))) return true;

    // development channel 确认
    if (pane.includes("I am using this for local development")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }

    // 信任目录确认 ("Do you trust the files in this folder?")
    if (pane.includes("trust") || pane.includes("Trust")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }

    // 任何 Yes/No 选择默认选 Yes
    if (pane.includes("❯") && pane.includes("Yes") && !pane.includes("❯ ")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      continue;
    }
  }

  return false;
}

async function cmdRestart(name?: string) {
  const reg = await loadRegistry();

  // 确定要重启的 worker 列表
  let targets: string[];
  if (name) {
    const tmuxName = normalizeName(name);
    if (!(await windowExists(tmuxName))) {
      output({ ok: false, error: `${tmuxName} 不存在` });
      return;
    }
    targets = [tmuxName];
  } else {
    // 重启所有 worker
    targets = await listWorkerWindows();
  }

  if (targets.length === 0) {
    output({ ok: false, error: "没有需要重启的 worker" });
    return;
  }

  const results: { name: string; ok: boolean; error?: string }[] = [];

  for (const tmuxName of targets) {
    const info = reg.workers[tmuxName];
    if (!info || !info.sessionId || !info.channelId) {
      results.push({ name: tmuxName, ok: false, error: "registry 中缺少 sessionId 或 channelId" });
      continue;
    }

    // 1. 优雅退出
    const exited = await gracefulExit(tmuxName);
    if (!exited) {
      // 强制：杀掉 window 里的进程
      await tmuxRaw(["send-keys", "-t", windowTarget(tmuxName), "C-c"]);
      await Bun.sleep(500);
      await tmuxRaw(["send-keys", "-t", windowTarget(tmuxName), "C-c"]);
      await Bun.sleep(1000);
    }

    // 2. 确保回到 shell
    const atShell = await waitForShell(tmuxName, 5000);
    if (!atShell) {
      results.push({ name: tmuxName, ok: false, error: "无法回到 shell 提示符" });
      continue;
    }

    // 3. 重新启动 Claude Code
    const displayName = info.displayName || tmuxName.replace(WORKER_PREFIX, "");
    const cmd = `DISCORD_CHANNEL_ID=${info.channelId} BRIDGE_URL=${BRIDGE_URL} claude --resume ${info.sessionId} --name "${displayName}" --dangerously-load-development-channels server:discord-bridge --dangerously-skip-permissions`;

    const started = await startClaudeInWindow(tmuxName, cmd);
    results.push({
      name: tmuxName,
      ok: started,
      error: started ? undefined : "启动超时",
    });
  }

  output({
    ok: results.every((r) => r.ok),
    results,
    message: results.map((r) => `${r.name}: ${r.ok ? "✅" : `❌ ${r.error}`}`).join("\n"),
  });
}

async function cmdList() {
  const tmuxWindows = await listWorkerWindows();
  const reg = await loadRegistry();

  const workers: Record<string, unknown>[] = [];

  for (const name of tmuxWindows) {
    const idle = await isWorkerIdle(name);
    const info = reg.workers[name];
    workers.push({
      name,
      status: "active",
      idle,
      project: info?.project || "unknown",
      purpose: info?.purpose || "",
      channelId: info?.channelId || "",
      sessionId: info?.sessionId || "",
    });
  }

  // 也列出 registry 里 active 但 tmux 已死的
  for (const [name, info] of Object.entries(reg.workers)) {
    if (info.status === "active" && !tmuxWindows.includes(name)) {
      workers.push({
        name,
        status: "dead",
        idle: false,
        project: info.project,
        purpose: info.purpose,
        channelId: info.channelId,
        sessionId: info.sessionId,
      });
    }
  }

  output({ ok: true, workers });
}

async function cmdSessions(search?: string) {
  const sessions = await scanClaudeSessions(search);

  // 从 registry 建立 sessionId → displayName 映射
  const reg = await loadRegistry();
  const nameMap = new Map<string, string>();
  for (const info of Object.values(reg.workers)) {
    if (info.sessionId && info.displayName) {
      nameMap.set(info.sessionId, info.displayName);
    }
  }

  const display = sessions.slice(0, 25).map((s, i) => ({
    index: i + 1,
    sessionId: s.sessionId,
    name: nameMap.get(s.sessionId) || s.slug || s.sessionId.slice(0, 8),
    slug: s.slug,
    project: s.cwd.replace(process.env.HOME || "", "~"),
    age: formatAge(s.modifiedAt),
    lastMessage: s.lastUserMessage || "",
  }));

  output({
    ok: true,
    total: sessions.length,
    showing: display.length,
    sessions: display,
  });
}

// ============================================================
// CLI 入口
// ============================================================

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "create": {
    const [name, dir, ...rest] = args;
    if (!name || !dir) {
      output({ ok: false, error: "用法: create <name> <dir> [purpose]" });
      break;
    }
    await cmdCreate(name, dir, rest.join(" "));
    break;
  }

  case "resume": {
    const [name, sessionId, dir] = args;
    if (!name || !sessionId) {
      output({ ok: false, error: "用法: resume <name> <sessionId> [dir]" });
      break;
    }
    await cmdResume(name, sessionId, dir);
    break;
  }

  case "kill": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "用法: kill <name>" });
      break;
    }
    await cmdKill(name);
    break;
  }

  case "list":
    await cmdList();
    break;

  case "sessions":
    await cmdSessions(args.join(" ") || undefined);
    break;

  case "restart": {
    const [name] = args;
    await cmdRestart(name || undefined);
    break;
  }

  default:
    output({
      ok: false,
      error: `未知命令: ${cmd || "(空)"}`,
      usage: [
        "create <name> <dir> [purpose]  — 新建 worker",
        "resume <name> <sessionId> [dir] — 恢复历史 session",
        "kill <name>                     — 销毁 worker",
        "restart [name]                  — 重启 worker（不指定则重启所有）",
        "list                            — 列出所有 worker",
        "sessions [search]               — 浏览历史 Claude Code 会话",
      ],
    });
}
