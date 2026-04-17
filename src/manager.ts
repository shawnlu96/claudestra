#!/usr/bin/env bun
/**
 * Agent Manager CLI
 *
 * 管理 Claude Code agent 的生命周期：创建、恢复、销毁、列表。
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

import {
  TMUX_SOCK as SOCK,
  MASTER_SESSION,
  AGENT_PREFIX,
  tmuxRaw,
  windowTarget,
  tmuxSendLine,
  tmuxCapture,
  isIdle,
  listAgentWindows as listAgentWindowsShared,
  ensureSocketDir,
  hasClaudePromptToConfirm,
} from "./lib/tmux-helper.js";
import {
  buildClaudeCommand,
  resolveDisallowed,
  listPresets,
  isKnownPreset,
  DISALLOWED_PRESETS,
  DEFAULT_PRESET,
} from "./lib/claude-launch.js";
import { printTmuxGuide } from "./lib/tmux-guide.js";

const REGISTRY_PATH = `${process.env.HOME}/.claude-orchestrator/registry.json`;
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const CATEGORY_NAME = "agents";

// ============================================================
// Registry
// ============================================================

interface AgentInfo {
  project: string;
  purpose: string;
  created: string;
  status: "active" | "stopped";
  channelId: string;
  notes: string;
  sessionId?: string;
  cwd: string;
  displayName?: string;
  /** 权限预设名（default/strict/readonly/paranoid/自定义） */
  disallowedPreset?: string;
  /** 原始 disallowedTools 字符串。如果设置了，优先于 preset */
  disallowedRaw?: string;
}

interface Registry {
  socket: string;
  agents: Record<string, AgentInfo>;
}

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) {
    const empty: Registry = { socket: SOCK, agents: {} };
    await saveRegistry(empty);
    return empty;
  }
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as Registry;
}

/** 一次性迁移：worker- → agent-。由 update 命令显式调用。 */
async function migrateWorkerToAgent(): Promise<{ migrated: boolean; entries: number }> {
  if (!existsSync(REGISTRY_PATH)) return { migrated: false, entries: 0 };
  const raw = JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
  if (!raw.workers || raw.agents) return { migrated: false, entries: 0 };

  raw.agents = {};
  for (const [key, val] of Object.entries(raw.workers)) {
    const newKey = key.replace(/^worker-/, "agent-");
    raw.agents[newKey] = val;
  }
  delete raw.workers;
  await writeFile(REGISTRY_PATH, JSON.stringify(raw, null, 2));

  // 同步重命名 tmux window（可能因为 tmux 不在运行而失败，忽略即可）
  for (const newName of Object.keys(raw.agents)) {
    const oldTmux = newName.replace(/^agent-/, "worker-");
    if (oldTmux !== newName) {
      await tmuxRaw(["rename-window", "-t", `${MASTER_SESSION}:${oldTmux}`, newName]).catch(() => {});
    }
  }

  return { migrated: true, entries: Object.keys(raw.agents).length };
}

async function saveRegistry(reg: Registry) {
  await mkdir(`${process.env.HOME}/.claude-orchestrator`, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

import { bridgeRequest } from "./lib/bridge-client.js";

async function windowExists(name: string): Promise<boolean> {
  const windows = await listAgentWindowsShared();
  return windows.includes(name);
}

async function isAgentIdle(name: string): Promise<boolean> {
  return isIdle(windowTarget(name));
}

async function captureLast(name: string, lines = 40): Promise<string> {
  return tmuxCapture(windowTarget(name), lines);
}

// mkdir 等原本内联的工具
async function ensureSocket() {
  await ensureSocketDir();
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
          } catch { /* non-critical */ }
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
            } catch { /* non-critical */ }
          }
        } catch { /* non-critical */ }

        sessions.push({ sessionId, cwd, slug, modifiedAt: fileStat.mtime, lastUserMessage });
      } catch { /* non-critical */ }
    }
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

// ============================================================
// 辅助
// ============================================================

// 拒绝空白、shell 元字符、控制字符。CJK 和其他 Unicode 字母允许。
// 长度上限 48 — Discord 频道名上限 100，tmux window 名没硬限制，48 足够宽。
const NAME_BLOCKLIST_RE = /[\s"'`$;&|<>()*?{}\\\x00-\x1f\x7f]/;

function normalizeName(raw: string): string {
  return `${AGENT_PREFIX}${raw.replace(AGENT_PREFIX, "").toLowerCase()}`;
}

/**
 * 校验：只用于新建/resume。拒绝空白和 shell 元字符，防止命令注入。
 * 允许 CJK 等 Unicode 字符（Discord 频道名支持，tmux 也支持）。
 */
function assertValidNewName(raw: string): void {
  const cleaned = raw.replace(AGENT_PREFIX, "");
  if (cleaned.length === 0 || cleaned.length > 48) {
    throw new Error(`agent 名称长度必须在 1~48 之间: "${raw}"`);
  }
  if (NAME_BLOCKLIST_RE.test(cleaned)) {
    throw new Error(
      `agent 名称含非法字符: "${raw}"（不能包含空白或 shell 元字符 " ' \` $ ; & | < > ( ) * ? { } \\）`
    );
  }
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

/**
 * 从 argv 残余里提取 --preset <name> 和 --disallowed "<raw>"，
 * 返回剩余的位置参数。支持 --preset=foo / --disallowed=foo 两种写法。
 */
function extractPermFlags(args: string[]): {
  rest: string[];
  preset?: string;
  disallowedRaw?: string;
} {
  const rest: string[] = [];
  let preset: string | undefined;
  let disallowedRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--preset") {
      preset = args[++i];
    } else if (a.startsWith("--preset=")) {
      preset = a.slice("--preset=".length);
    } else if (a === "--disallowed") {
      disallowedRaw = args[++i];
    } else if (a.startsWith("--disallowed=")) {
      disallowedRaw = a.slice("--disallowed=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, preset, disallowedRaw };
}

// ============================================================
// 命令实现
// ============================================================

async function cmdCreate(
  name: string,
  dir: string,
  purpose: string = "",
  perms: { preset?: string; disallowedRaw?: string } = {}
) {
  assertValidNewName(name);
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(AGENT_PREFIX, "");

  // 校验权限预设
  if (perms.preset && !isKnownPreset(perms.preset)) {
    output({
      ok: false,
      error: `未知的权限预设: "${perms.preset}"。可用: ${listPresets().join(", ")}`,
    });
    return;
  }

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
  const cmd = buildClaudeCommand({
    channelId,
    bridgeUrl: BRIDGE_URL,
    sessionId,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
  });
  await tmuxSendLine(target, cmd);

  // 4. 轮询等待就绪，遇到任何确认弹窗自动按 Enter
  //    用 hasPromptToConfirm 统一处理 dev-channel / trust files / "❯ 1. Yes" 等多种提示
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(tmuxName, 10);
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
    if (await isAgentIdle(tmuxName)) {
      ready = true;
      break;
    }
  }

  // 6. 更新 registry
  const reg = await loadRegistry();
  reg.agents[tmuxName] = {
    project: dir,
    purpose,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: "",
    sessionId,
    cwd: expandedDir,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
  };
  await saveRegistry(reg);

  output({
    ok: true,
    agent: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    preset: perms.preset || DEFAULT_PRESET,
    message: ready
      ? `Agent ${tmuxName} 已创建，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已创建，但 Claude Code 可能还在启动中`,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function cmdResume(
  name: string,
  sessionId: string,
  dir?: string,
  perms: { preset?: string; disallowedRaw?: string } = {}
) {
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`非法 sessionId: "${sessionId}"（应为 UUID 格式）`);
  }
  assertValidNewName(name);
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(AGENT_PREFIX, "");

  if (perms.preset && !isKnownPreset(perms.preset)) {
    output({
      ok: false,
      error: `未知的权限预设: "${perms.preset}"。可用: ${listPresets().join(", ")}`,
    });
    return;
  }

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

  // 创建 tmux window（在 master session 里）
  await ensureSocket();
  await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", resolvedDir]);
  await Bun.sleep(500);

  // 启动 Claude Code（resume 模式）
  const target = windowTarget(tmuxName);
  const displayName = channelName;
  const cmd = buildClaudeCommand({
    channelId,
    bridgeUrl: BRIDGE_URL,
    resumeId: sessionId,
    displayName,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
  });
  await tmuxSendLine(target, cmd);

  // 轮询等待，用 hasPromptToConfirm 统一处理所有确认弹窗
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(tmuxName, 10);
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
    if (await isAgentIdle(tmuxName)) {
      ready = true;
      break;
    }
  }

  // 更新 registry
  const reg = await loadRegistry();
  reg.agents[tmuxName] = {
    project: dir || resolvedDir.replace(process.env.HOME || "", "~"),
    purpose: `resumed: ${sessionId.slice(0, 8)}`,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: `claude session: ${sessionId}`,
    sessionId,
    cwd: resolvedDir,
    displayName: channelName,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
  };
  await saveRegistry(reg);

  // 截图发到新频道作为上下文预览
  if (ready) {
    try {
      const bunPath = `${process.env.HOME}/.bun/bin/bun`;
      const srcDir = import.meta.dir;
      const htmlPath = `/tmp/claude-orchestrator/resume_${Date.now()}.html`;
      const pngPath = `/tmp/claude-orchestrator/resume_${Date.now()}.png`;

      // tmux capture-pane -e → ansi2html → HTML
      const capture = Bun.spawn(
        ["tmux", "-S", SOCK, "capture-pane", "-t", windowTarget(tmuxName), "-p", "-e", "-S", "-50"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ansi2html = Bun.spawn(
        [bunPath, "run", `${srcDir}/ansi2html.ts`, htmlPath],
        { stdin: capture.stdout, stdout: "pipe", stderr: "pipe" }
      );
      await ansi2html.exited;

      // HTML → PNG
      await Bun.spawn(
        [bunPath, "run", `${srcDir}/html2png.ts`, htmlPath, pngPath, "1200"],
        { stdout: "pipe", stderr: "pipe" }
      ).exited;

      // 发图片到 Discord
      const { existsSync } = await import("fs");
      if (existsSync(pngPath)) {
        await bridgeRequest({
          type: "reply",
          chatId: channelId,
          text: "**📜 恢复的会话终端预览**",
          files: [pngPath],
        });
      }
      // 清理
      try { await Bun.spawn(["rm", htmlPath, pngPath]).exited; } catch { /* non-critical */ }
    } catch { /* non-critical */ }
  }

  output({
    ok: true,
    agent: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    message: ready
      ? `Agent ${tmuxName} 已恢复，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已恢复，但 Claude Code 可能还在启动中`,
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
  const info = reg.agents[tmuxName];
  if (info?.channelId) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId: info.channelId });
    } catch { /* non-critical */ }
  }
  if (reg.agents[tmuxName]) {
    reg.agents[tmuxName].status = "stopped";
  }

  // 清理 registry 里同名的大小写变体（历史遗留）
  for (const key of Object.keys(reg.agents)) {
    if (key.toLowerCase() === tmuxName && key !== tmuxName) {
      delete reg.agents[key];
    }
  }
  await saveRegistry(reg);

  output({
    ok: true,
    agent: tmuxName,
    message: `${tmuxName} 已销毁。`,
  });
}

// ============================================================
// 优雅退出 + 重启
// ============================================================

/** 检查 tmux pane 是否在 shell 提示符 */
function isAtShell(pane: string): boolean {
  const lastLine = pane.split("\n").filter((l) => l.trim()).pop() || "";
  return /[%$]\s*$/.test(lastLine);
}

/** 检查是否有需要按 Enter 的提示（转发到共享实现） */
const hasPromptToConfirm = hasClaudePromptToConfirm;

/** 优雅退出一个 Claude Code agent，处理所有确认弹窗 */
async function gracefulExit(name: string): Promise<boolean> {
  const target = windowTarget(name);

  // 阶段 1: 多次 Ctrl+C 确保打断当前操作
  for (let i = 0; i < 3; i++) {
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(800);
    const pane = await captureLast(name, 5);
    if (isAtShell(pane)) return true;
    // 如果出现了 ❯ 提示符（Claude Code 空闲），可以继续退出
    if (/❯/.test(pane.split("\n").slice(-5).join("\n"))) break;
  }

  // 阶段 2: 发 Escape 清除任何菜单/弹窗
  await tmuxRaw(["send-keys", "-t", target, "Escape"]);
  await Bun.sleep(500);

  // 阶段 3: 发 /exit
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", "/exit"]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 阶段 4: 轮询处理各种确认提示，最多等 30 秒
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // 已经回到 shell
    if (isAtShell(pane)) return true;

    // Goodbye! 表示 Claude Code 正在退出
    if (pane.includes("Goodbye!")) {
      await Bun.sleep(1000);
      continue;
    }

    // 有确认提示 → 按 Enter
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }

    // /exit 可能出现在自动补全列表里，需要再按一次 Enter
    if (pane.includes("/exit") && pane.includes("Exit the REPL")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  // 阶段 5: 最后手段 — 强制杀进程
  const finalPane = await captureLast(name, 5);
  if (!isAtShell(finalPane)) {
    // 发 Ctrl+C 多次 + Ctrl+D
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(300);
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(300);
    await tmuxRaw(["send-keys", "-t", target, "C-d"]);
    await Bun.sleep(2000);
  }

  const check = await captureLast(name, 3);
  return isAtShell(check);
}

/** 在已有的 tmux window 里启动 Claude Code，处理所有确认弹窗 */
async function startClaudeInWindow(
  name: string,
  claudeCmd: string
): Promise<boolean> {
  const target = windowTarget(name);

  // 确保在 shell 提示符
  const preLaunch = await captureLast(name, 3);
  if (!isAtShell(preLaunch)) {
    // 等一下 shell
    await Bun.sleep(2000);
    const retry = await captureLast(name, 3);
    if (!isAtShell(retry)) return false;
  }

  // 发送启动命令
  await tmuxSendLine(target, claudeCmd);

  // 轮询处理各种确认提示，最多等 60 秒
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // Claude Code 就绪
    if (/❯/.test(pane.split("\n").slice(-5).join("\n")) && pane.includes("bypass permissions")) {
      return true;
    }

    // 有确认提示 → 按 Enter
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  // 最后再捕一次，用严格条件：必须同时有 "❯" 和 "bypass permissions" 才算 ready。
  // 只检 "❯" 会被"❯ 1. I am using this for local development"这类选项菜单
  // 里的游标字符误判为 shell 提示符，导致卡在对话框还返回成功。
  const final = await captureLast(name, 10);
  const hasReadyPrompt = /❯/.test(final.split("\n").slice(-5).join("\n"));
  const hasBypassBanner = final.includes("bypass permissions");
  return hasReadyPrompt && hasBypassBanner;
}

async function cmdRestart(name?: string) {
  const reg = await loadRegistry();

  // 确定要重启的 agent 列表
  let targets: string[];
  if (name) {
    const tmuxName = normalizeName(name);
    if (!(await windowExists(tmuxName))) {
      output({ ok: false, error: `${tmuxName} 不存在` });
      return;
    }
    targets = [tmuxName];
  } else {
    // 重启所有 agent
    targets = await listAgentWindowsShared();
  }

  if (targets.length === 0) {
    output({ ok: false, error: "没有需要重启的 agent" });
    return;
  }

  const results: { name: string; ok: boolean; error?: string }[] = [];

  for (const tmuxName of targets) {
    const info = reg.agents[tmuxName];
    if (!info || !info.sessionId || !info.channelId) {
      results.push({ name: tmuxName, ok: false, error: "registry 中缺少 sessionId 或 channelId" });
      continue;
    }

    // 1. 优雅退出（包含强制退出兜底）
    const exited = await gracefulExit(tmuxName);
    if (!exited) {
      results.push({ name: tmuxName, ok: false, error: "无法退出 Claude Code" });
      continue;
    }

    // 2. 重新启动 Claude Code — 沿用 registry 中存储的权限配置
    const displayName = info.displayName || tmuxName.replace(AGENT_PREFIX, "");
    const cmd = buildClaudeCommand({
      channelId: info.channelId,
      bridgeUrl: BRIDGE_URL,
      resumeId: info.sessionId,
      displayName,
      disallowedPreset: info.disallowedPreset,
      disallowedRaw: info.disallowedRaw,
    });

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
  const tmuxWindows = await listAgentWindowsShared();
  const reg = await loadRegistry();

  const agents: Record<string, unknown>[] = [];

  for (const name of tmuxWindows) {
    const idle = await isAgentIdle(name);
    const info = reg.agents[name];
    agents.push({
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
  for (const [name, info] of Object.entries(reg.agents)) {
    if (info.status === "active" && !tmuxWindows.includes(name)) {
      agents.push({
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

  output({ ok: true, agents });
}

async function cmdSessions(search?: string) {
  const sessions = await scanClaudeSessions(search);

  // 从 registry 建立 sessionId → displayName 映射
  const reg = await loadRegistry();
  const nameMap = new Map<string, string>();
  for (const info of Object.values(reg.agents)) {
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
// Cron 管理命令
// ============================================================

import { loadJobs, saveJobs, parseCronExpression, nextCronTime, type CronJob } from "./cron.js";

async function cmdCronAdd(name: string, schedule: string, dir: string, prompt: string) {
  // 验证 cron 表达式
  try {
    parseCronExpression(schedule);
  } catch (err) {
    output({ ok: false, error: (err as Error).message });
    return;
  }

  const jobs = await loadJobs();

  // 检查同名
  if (jobs.some((j) => j.name === name)) {
    output({ ok: false, error: `已存在同名任务: "${name}"` });
    return;
  }

  const job: CronJob = {
    id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    schedule,
    prompt,
    dir: dir.replace(/^~/, process.env.HOME || "~"),
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  try {
    job.nextRun = nextCronTime(schedule).toISOString();
  } catch { /* non-critical */ }

  jobs.push(job);
  await saveJobs(jobs);

  output({
    ok: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRun: job.nextRun },
    message: `定时任务 "${name}" 已创建 (${schedule})`,
  });
}

async function cmdCronList() {
  const jobs = await loadJobs();
  output({
    ok: true,
    total: jobs.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      dir: j.dir.replace(process.env.HOME || "", "~"),
      prompt: j.prompt.slice(0, 80),
      enabled: j.enabled,
      lastRun: j.lastRun || null,
      nextRun: j.nextRun || null,
    })),
  });
}

async function cmdCronRemove(nameOrId: string) {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j.name === nameOrId || j.id === nameOrId);
  if (idx < 0) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  const removed = jobs.splice(idx, 1)[0];
  await saveJobs(jobs);
  output({ ok: true, removed: removed.name, message: `定时任务 "${removed.name}" 已删除` });
}

async function cmdCronToggle(nameOrId: string) {
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
  if (!job) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  job.enabled = !job.enabled;
  if (job.enabled) {
    try { job.nextRun = nextCronTime(job.schedule).toISOString(); } catch { /* non-critical */ }
  } else {
    job.nextRun = undefined;
  }
  await saveJobs(jobs);
  output({
    ok: true,
    name: job.name,
    enabled: job.enabled,
    message: `定时任务 "${job.name}" 已${job.enabled ? "启用" : "暂停"}`,
  });
}

async function cmdCronHistory(nameOrId?: string) {
  const historyPath = `${process.env.HOME}/.claude-orchestrator/cron-history.json`;
  let history: any[] = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(await readFile(historyPath, "utf-8"));
    } catch { /* non-critical */ }
  }
  if (nameOrId) {
    history = history.filter((h) => h.jobName === nameOrId || h.jobId === nameOrId);
  }
  output({
    ok: true,
    total: history.length,
    records: history.slice(-20).reverse(),
  });
}

// ============================================================
// 版本检查 / 自动更新
// ============================================================

// ============================================================
// 权限管理
// ============================================================

function describePerm(info: AgentInfo): {
  preset: string;
  raw?: string;
  tools: string[];
} {
  if (info.disallowedRaw) {
    return {
      preset: "(custom)",
      raw: info.disallowedRaw,
      tools: info.disallowedRaw.trim().split(/\s+/).filter(Boolean),
    };
  }
  const preset = info.disallowedPreset || DEFAULT_PRESET;
  return {
    preset,
    tools: [...(DISALLOWED_PRESETS[preset] || [])],
  };
}

async function cmdPermissions(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    // 列出所有 agent 的权限
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => {
        const d = describePerm(info);
        return { name, preset: d.preset, toolCount: d.tools.length };
      });
    output({ ok: true, agents: rows });
    return;
  }

  if (sub === "presets") {
    const presets = listPresets().map((name) => ({
      name,
      toolCount: DISALLOWED_PRESETS[name].length,
      tools: [...DISALLOWED_PRESETS[name]],
    }));
    output({ ok: true, presets, default: DEFAULT_PRESET });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "用法: permissions get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
    });
    return;
  }

  if (sub === "set") {
    // permissions set <name> --preset <name>
    // permissions set <name> --disallowed "..."
    const [name] = rest;
    if (!name) {
      output({
        ok: false,
        error: '用法: permissions set <name> --preset <preset>｜--disallowed "..."',
      });
      return;
    }
    const { preset, disallowedRaw } = extractPermFlags(rest.slice(1));
    if (!preset && !disallowedRaw) {
      output({
        ok: false,
        error: '需要指定 --preset 或 --disallowed。可用 preset: ' + listPresets().join(", "),
      });
      return;
    }
    if (preset && !isKnownPreset(preset)) {
      output({
        ok: false,
        error: `未知预设: "${preset}"。可用: ${listPresets().join(", ")}`,
      });
      return;
    }

    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = preset;
    info.disallowedRaw = disallowedRaw;
    await saveRegistry(reg);

    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
      hint: `新配置已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "用法: permissions reset <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = undefined;
    info.disallowedRaw = undefined;
    await saveRegistry(reg);
    output({
      ok: true,
      agent: tmuxName,
      preset: DEFAULT_PRESET,
      hint: `已重置为默认预设。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  output({
    ok: false,
    error: `未知子命令: permissions ${sub}`,
    usage: [
      "permissions list                 — 列出所有 agent 的权限预设",
      "permissions presets              — 列出所有可用预设及其包含的工具",
      "permissions get <name>           — 查看单个 agent 的详细权限",
      'permissions set <name> --preset <preset>｜--disallowed "..."',
      "permissions reset <name>         — 恢复默认预设",
    ],
  });
}

// ============================================================
// 版本检查 / 自动更新
// ============================================================

const REPO_ROOT = `${import.meta.dir}/..`;

async function git(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", REPO_ROOT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

async function cmdVersion() {
  const { getLatestRelease, getLocalVersion, isNewer } = await import("./lib/github-release.js");

  const local = await getLocalVersion();
  const head = (await git("rev-parse", "HEAD")).out.slice(0, 7);
  const release = await getLatestRelease();

  const hasUpdate = release ? isNewer(release.version, local) : false;

  output({
    ok: true,
    version: local,
    head,
    latestRelease: release?.tag || null,
    latestVersion: release?.version || null,
    upToDate: !hasUpdate,
    summary: !release
      ? `v${local} @ ${head}（无法查询远端 release）`
      : hasUpdate
        ? `v${local} → ${release.tag} 可更新`
        : `已是最新 v${local} @ ${head}`,
  });
}

async function cmdUpdate() {
  const { getLatestRelease, getLocalVersion, isNewer } = await import("./lib/github-release.js");

  // 1. 查询最新 release
  const release = await getLatestRelease();
  if (!release) {
    output({ ok: false, error: "无法查询 GitHub release（网络问题或没有发布过 release）" });
    return;
  }

  const local = await getLocalVersion();
  if (!isNewer(release.version, local)) {
    output({ ok: true, version: local, message: `已是最新版本 v${local}` });
    return;
  }

  // 2. 确认工作目录干净
  const status = await git("status", "--porcelain");
  if (!status.ok) {
    output({ ok: false, error: "不是 git 仓库，无法自动更新" });
    return;
  }
  if (status.out) {
    output({
      ok: false,
      error: "仓库有未提交的改动，请先 commit/stash 后再更新",
      dirty: status.out,
    });
    return;
  }

  // 3. fetch tags + checkout release tag
  await git("fetch", "--tags", "--quiet", "origin");
  const checkout = await git("checkout", release.tag, "--quiet");
  if (!checkout.ok) {
    output({ ok: false, error: `git checkout ${release.tag} 失败: ${checkout.err}` });
    return;
  }

  // 4. bun install（依赖可能变了）
  const biProc = Bun.spawn(["bun", "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  await biProc.exited;

  // 5. 执行新版 manager 的 migrate 子命令（新版可能带格式迁移逻辑）
  //    关键：用 subprocess 跑 NEW 版代码，当前进程跑的还是旧版
  const migrateProc = Bun.spawn(
    ["bun", "run", `${REPO_ROOT}/src/manager.ts`, "migrate"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }
  );
  await migrateProc.exited;

  // 6. pm2 restart（bridge + launcher + cron-scheduler）
  const pm2Proc = Bun.spawn(["pm2", "restart", "ecosystem.config.cjs"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Response(pm2Proc.stdout).text();
  await pm2Proc.exited;

  output({
    ok: true,
    from: `v${local}`,
    to: release.tag,
    message: `已更新到 ${release.tag} 并重启 pm2 服务`,
  });
}

// ============================================================
// CLI 入口
// ============================================================

const [cmd, ...args] = process.argv.slice(2);

try {
switch (cmd) {
  case "create": {
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(args);
    const [name, dir, ...purposeParts] = posArgs;
    if (!name || !dir) {
      output({
        ok: false,
        error: 'create <name> <dir> [purpose] [--preset <preset>] [--disallowed "..."]',
      });
      break;
    }
    await cmdCreate(name, dir, purposeParts.join(" "), { preset, disallowedRaw });
    break;
  }

  case "resume": {
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(args);
    const [name, sessionId, dir] = posArgs;
    if (!name || !sessionId) {
      output({
        ok: false,
        error: 'resume <name> <sessionId> [dir] [--preset <preset>] [--disallowed "..."]',
      });
      break;
    }
    await cmdResume(name, sessionId, dir, { preset, disallowedRaw });
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

  case "cron-add": {
    const [name, schedule, dir, ...rest] = args;
    if (!name || !schedule || !dir || rest.length === 0) {
      output({ ok: false, error: '用法: cron-add <name> "<cron>" <dir> <prompt...>' });
      break;
    }
    await cmdCronAdd(name, schedule, dir, rest.join(" "));
    break;
  }

  case "cron-list":
    await cmdCronList();
    break;

  case "cron-remove": {
    const [nameOrId] = args;
    if (!nameOrId) {
      output({ ok: false, error: "用法: cron-remove <name|id>" });
      break;
    }
    await cmdCronRemove(nameOrId);
    break;
  }

  case "cron-toggle": {
    const [nameOrId] = args;
    if (!nameOrId) {
      output({ ok: false, error: "用法: cron-toggle <name|id>" });
      break;
    }
    await cmdCronToggle(nameOrId);
    break;
  }

  case "cron-history":
    await cmdCronHistory(args[0] || undefined);
    break;

  case "version":
    await cmdVersion();
    break;

  case "update":
    await cmdUpdate();
    break;

  case "migrate": {
    const res = await migrateWorkerToAgent();
    output({ ok: true, ...res });
    break;
  }

  case "permissions":
  case "perm":
  case "perms": {
    const [sub, ...rest] = args;
    await cmdPermissions(sub || "list", ...rest);
    break;
  }

  case "tmux-help":
  case "tmux":
    printTmuxGuide();
    break;

  default:
    output({
      ok: false,
      error: `未知命令: ${cmd || "(空)"}`,
      usage: [
        "create <name> <dir> [purpose]  — 新建 agent",
        "resume <name> <sessionId> [dir] — 恢复历史 session",
        "kill <name>                     — 销毁 agent",
        "restart [name]                  — 重启 agent（不指定则重启所有）",
        "list                            — 列出所有 agent",
        "sessions [search]               — 浏览历史 Claude Code 会话",
        'cron-add <name> "<cron>" <dir> <prompt...> — 添加定时任务',
        "cron-list                       — 列出所有定时任务",
        "cron-remove <name|id>           — 删除定时任务",
        "cron-toggle <name|id>           — 启用/暂停定时任务",
        "cron-history [name|id]          — 查看执行历史",
        "permissions list                — 列出所有 agent 的权限预设",
        "permissions presets             — 列出所有可用预设",
        "permissions get <name>          — 查看单个 agent 的详细权限",
        'permissions set <name> --preset <preset>｜--disallowed "..."',
        "permissions reset <name>        — 恢复默认预设",
        "tmux-help                       — 打印 tmux 快速教程（含 iTerm2 -CC 模式）",
        "version                         — 显示当前版本 + 是否有更新",
        "update                          — 拉取最新代码并重启 pm2 服务",
      ],
    });
}
} catch (err) {
  output({ ok: false, error: (err as Error).message });
  process.exit(1);
}
