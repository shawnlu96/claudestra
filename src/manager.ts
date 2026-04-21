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
  detectSessionIdlePrompt,
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

/**
 * 通知 bridge 重新扫 skill 并重新注册 Discord slash commands。
 * agent 生命周期变化（create/resume/kill/restart）时调用。
 * bridge 没运行也无所谓 —— 失败静默。
 */
async function triggerSkillsRescan(
  action: "add" | "remove" | "full",
  agent?: string,
  cwd?: string
): Promise<void> {
  const port = process.env.BRIDGE_PORT || "3847";
  try {
    await fetch(`http://localhost:${port}/skills/rescan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, agent, cwd }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* bridge 可能未运行 */ }
}

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

  // 频道建好后若后续任何步骤失败，都必须清理孤儿频道 + tmux window
  async function cleanup(reason: string) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId });
    } catch { /* non-critical */ }
    try {
      await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
    } catch { /* non-critical */ }
    output({ ok: false, error: `${reason}（已清理残留频道 #${channelName} 和 tmux window）` });
  }

  let ready = false;
  let sessionId: string;
  const expandedDir = dir.replace(/^~/, process.env.HOME || "~");

  try {
    // 2. 创建 tmux window（在 master session 里）
    await ensureSocket();
    await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", expandedDir]);
    await Bun.sleep(500);

    // 3. 启动 Claude Code
    const target = windowTarget(tmuxName);
    sessionId = crypto.randomUUID();
    const cmd = buildClaudeCommand({
      channelId,
      bridgeUrl: BRIDGE_URL,
      sessionId,
      disallowedPreset: perms.preset,
      disallowedRaw: perms.disallowedRaw,
    });
    await tmuxSendLine(target, cmd);

    // 4. 轮询等待就绪
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // Session 闲置弹窗 → watcher 会通知用户，这里当成就绪返回
      if (detectSessionIdlePrompt(pane)) {
        ready = true;
        break;
      }
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

    if (!ready) {
      await cleanup("Claude Code 启动超时");
      return;
    }
  } catch (err) {
    await cleanup(`创建失败: ${(err as Error).message}`);
    return;
  }

  // 6. 更新 registry（只有启动成功才落盘）
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

  await triggerSkillsRescan("add", tmuxName, expandedDir);

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

  async function cleanup(reason: string) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId });
    } catch { /* non-critical */ }
    try {
      await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
    } catch { /* non-critical */ }
    output({ ok: false, error: `${reason}（已清理残留频道 #${channelName} 和 tmux window）` });
  }

  let ready = false;

  try {
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

    // 轮询等待
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // Session 闲置弹窗 → watcher 会通知用户，这里当成就绪返回
      if (detectSessionIdlePrompt(pane)) {
        ready = true;
        break;
      }
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

    if (!ready) {
      await cleanup("Claude Code 启动超时");
      return;
    }
  } catch (err) {
    await cleanup(`恢复失败: ${(err as Error).message}`);
    return;
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
  await triggerSkillsRescan("add", tmuxName, resolvedDir);
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

  await triggerSkillsRescan("remove", tmuxName);

  output({
    ok: true,
    agent: tmuxName,
    message: `${tmuxName} 已销毁。`,
  });
}

// ============================================================
// 优雅退出 + 重启
// ============================================================

/**
 * 检查 tmux pane 是否回到 shell 提示符。
 *
 * 策略：
 * 1. 排除法：pane 含 Claude Code TUI 的标志文字（"bypass permissions" / "esc to interrupt" /
 *    选项菜单 "❯ 1." ... 这些只在 Claude Code 运行时出现）→ 不是 shell
 * 2. 最后非空行结尾匹配常见 shell 提示符字符：$、%、#、>、➜、»、λ
 *    （注意：❯ 是 Claude Code 的输入提示符，也被 starship 等 shell 主题用，
 *     所以要配合排除法才能区分）
 *
 * 用户反馈 v1.7.4 的坑：oh-my-zsh "robbyrussell" 主题用 ➜，原来的
 * /[%$]/ 正则认不出来导致 restart 永远"启动超时"。
 */
function isAtShell(pane: string): boolean {
  const nonEmpty = pane.split("\n").filter((l) => l.trim());
  const tail = nonEmpty.slice(-5).join("\n");
  // 如果底部有 Claude Code TUI 标志，肯定不在 shell
  if (/bypass permissions|esc to interrupt|esc to cancel/i.test(tail)) return false;
  if (/^\s*❯\s*\d+\./m.test(tail)) return false;
  const lastLine = nonEmpty.pop() || "";
  // 常见 shell prompt 收尾字符：$ (bash/sh)、% (zsh default)、# (root)、> (fish/cmd)、
  // ➜ (oh-my-zsh robbyrussell)、» (pure prompt)、λ (lambda prompt)、
  // ❯ (starship / pure 某些主题 — 依赖上面的 Claude TUI exclusion 判断不是 Claude 的输入框)
  return /[%$#>➜»λ❯]\s*$/.test(lastLine);
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

    // Session 闲置弹窗 → 不自动确认，交给 permission-watcher 通知用户
    // 当作"就绪"返回，cmdCreate/cmdResume 会保存 registry，watcher 会发 Discord 按钮
    if (detectSessionIdlePrompt(pane)) {
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
  const liveWindows = await listAgentWindowsShared();

  // 确定要重启的 agent 列表（不指定名字时，既包括活着的 window，也包括 registry 里 active 但 window 没了的 dead agent —
  // 这样 gracefulExit 超时导致 window 被杀的情况也能通过重启救回）
  let targets: string[];
  if (name) {
    const tmuxName = normalizeName(name);
    const inReg = !!reg.agents[tmuxName];
    if (!liveWindows.includes(tmuxName) && !inReg) {
      output({ ok: false, error: `${tmuxName} 不存在` });
      return;
    }
    targets = [tmuxName];
  } else {
    const deadButInReg = Object.keys(reg.agents).filter(
      (n) => reg.agents[n].status === "active" && !liveWindows.includes(n)
    );
    targets = [...liveWindows, ...deadButInReg];
  }

  if (targets.length === 0) {
    output({ ok: false, error: "没有需要重启的 agent" });
    return;
  }

  const results: { name: string; ok: boolean; error?: string; recreated?: boolean }[] = [];

  for (const tmuxName of targets) {
    const info = reg.agents[tmuxName];
    if (!info || !info.sessionId || !info.channelId) {
      results.push({ name: tmuxName, ok: false, error: "registry 中缺少 sessionId 或 channelId" });
      continue;
    }

    // 1. 如果 window 还活着，先尝试优雅退出；失败/window 不存在时强制 kill-window + 重建
    //    关键：永远不创建新 Discord 频道，复用 info.channelId
    let recreated = false;
    const windowAlive = liveWindows.includes(tmuxName) || (await windowExists(tmuxName));
    if (windowAlive) {
      const exited = await gracefulExit(tmuxName);
      if (!exited) {
        console.log(`[restart] ${tmuxName} 优雅退出超时，kill-window + 重建 tmux window`);
        await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]).catch(() => {});
        await Bun.sleep(500);
        recreated = true;
      }
    } else {
      // window 已经不存在（之前可能被 gracefulExit 或其他原因杀掉了） → 直接重建
      recreated = true;
    }

    if (recreated) {
      const cwd = info.cwd || process.env.HOME || "/";
      await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", cwd]);
      await Bun.sleep(500);
    }

    // 2. 重新启动 Claude Code — 沿用 registry 中存储的 channelId + 权限配置
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
      recreated: recreated || undefined,
    });
  }

  // 重启后做一次完整 skill 重扫（每个 agent cwd 可能项目级 skill 有变动）
  await triggerSkillsRescan("full");

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
      cwd: info?.cwd || "",
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
        cwd: info.cwd || "",
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

  // 4b. 重新渲染 master/CLAUDE.md（新版本可能更新了 master prompt；不刷新的话 master 还用老 context）
  const rendered = await renderMasterClaude();

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

  // 6b. 告诉正在跑的 master Claude Code 退出，launcher 会用新 CLAUDE.md 重启它
  //     （pm2 restart 只重启 bridge/launcher/cron 三个后台进程，不会动 tmux 里的 master session —
  //      不这么做的话老 master 会继续跑着旧的 CLAUDE.md 上下文）
  await Bun.sleep(1500); // 给 launcher 稳定
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch(() => {});

  // 7. pm2 save — 让当前进程列表持久化（开机自启时 pm2 resurrect 会读它）
  await Bun.spawn(["pm2", "save"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }).exited;

  // 8. 检查 pm2 startup 是否已经配过（开机自启的 init 脚本）；没配给 hint
  const startupWarning = await checkPm2Startup();

  output({
    ok: true,
    from: `v${local}`,
    to: release.tag,
    message: `已更新到 ${release.tag} 并重启 pm2 服务`,
    masterReRendered: rendered,
    pm2StartupWarning: startupWarning,
  });
}

/**
 * 用当前 .env 里的 USER_NAME 重新渲染 master/CLAUDE.md from template。
 * 新版本可能更新了 master prompt（新工具、新命令），不重渲染的话 master 启动时读的还是旧 CLAUDE.md。
 */
async function renderMasterClaude(): Promise<{ rendered: boolean; reason?: string }> {
  const { existsSync } = await import("fs");
  const templatePath = `${REPO_ROOT}/master/CLAUDE.md.template`;
  const renderedPath = `${REPO_ROOT}/master/CLAUDE.md`;
  if (!existsSync(templatePath)) return { rendered: false, reason: "template 不存在" };

  // 从 .env 读 USER_NAME
  let userName = process.env.USER_NAME || "";
  if (!userName && existsSync(`${REPO_ROOT}/.env`)) {
    try {
      const envText = await Bun.file(`${REPO_ROOT}/.env`).text();
      const m = envText.match(/^USER_NAME\s*=\s*(.+)$/m);
      if (m) userName = m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* non-critical */ }
  }
  if (!userName) userName = "User";

  try {
    let tpl = await Bun.file(templatePath).text();
    tpl = tpl.replaceAll("{{USER_NAME}}", userName);
    await Bun.write(renderedPath, tpl);
    return { rendered: true };
  } catch (e) {
    return { rendered: false, reason: (e as Error).message };
  }
}

/**
 * 检测 pm2 startup 是不是已经配置好（开机自启）。
 * macOS 看 ~/Library/LaunchAgents/pm2.<user>.plist；
 * Linux 看 /etc/systemd/system/pm2-<user>.service。
 * 没有就返回一条给用户的 hint 字符串，已有返回 null。
 */
async function checkPm2Startup(): Promise<string | null> {
  const { existsSync } = await import("fs");
  const user = process.env.USER || "";
  const home = process.env.HOME || "";
  const macosPath = `${home}/Library/LaunchAgents/pm2.${user}.plist`;
  const linuxPath = `/etc/systemd/system/pm2-${user}.service`;
  if (existsSync(macosPath) || existsSync(linuxPath)) return null;

  // 跑一次 pm2 startup 看看它会打什么 sudo 命令，喂给用户
  const proc = Bun.spawn(["pm2", "startup"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const match = (out + "\n" + err).match(/^\s*(sudo [^\n]+)$/m);
  if (!match) return null;
  return `pm2 开机自启未配置。请跑一次下面的 sudo 命令，机器重启后服务才会自动回来：\n${match[1]}`;
}

async function cmdInviteLink(args: string[]) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) {
    output({ ok: false, error: "DISCORD_BOT_TOKEN 未设置，无法生成邀请链接" });
    return;
  }

  // Bot token 第一段是 base64(appId)。appId === bot user ID === client_id
  let appId = "";
  try {
    const firstSeg = token.split(".")[0];
    appId = Buffer.from(firstSeg, "base64").toString("utf-8");
    if (!/^\d{17,20}$/.test(appId)) throw new Error("decoded not snowflake");
  } catch {
    output({ ok: false, error: "从 DISCORD_BOT_TOKEN 解出 App ID 失败。token 格式可能不对" });
    return;
  }

  const isPeer = args.includes("--peer");

  // Discord 权限 bitfield：https://discord.com/developers/docs/topics/permissions
  // Owner 完整权限（建频道、发消息、附件、反应、改 role 等）
  const OWNER_PERMS =
    (1 << 10) +   // VIEW_CHANNEL       = 1024
    (1 << 11) +   // SEND_MESSAGES      = 2048
    (1 << 16) +   // READ_MESSAGE_HISTORY = 65536
    (1 <<  4) +   // MANAGE_CHANNELS    = 16
    (1 << 28) +   // MANAGE_ROLES       = 268435456  (v1.8.5+: 自动收紧 peer bot role 用)
    (1 << 15) +   // ATTACH_FILES       = 32768
    (1 <<  6) +   // ADD_REACTIONS      = 64
    (1 << 14);    // EMBED_LINKS        = 16384
  // Peer 最小权限（只够读 + 发消息）
  const PEER_PERMS =
    (1 << 10) + (1 << 11) + (1 << 16); // VIEW + SEND + READ_HISTORY

  const perms = isPeer ? PEER_PERMS : OWNER_PERMS;
  const scopes = ["bot", "applications.commands"];

  const params = new URLSearchParams({
    client_id: appId,
    permissions: String(perms),
    scope: scopes.join(" "),
  });
  const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;

  output({
    ok: true,
    kind: isPeer ? "peer" : "owner",
    appId,
    permissions: perms,
    scopes,
    url,
    message: isPeer
      ? `这是一个 **peer 最小权限** 邀请链接。把它发给朋友，他点一下就能把你的 bot 加到他的服务器（只能看被邀请进去的频道、发消息、读历史）。`
      : `这是一个 **owner 完整权限** 邀请链接（含 Manage Channels 等）。你自己安装 bot 到你服务器用这个；别给朋友用它（权限太大）。`,
  });
}

async function cmdPeerExpose(localAgent: string, peer: string, purpose: string) {
  const peers = await import("./lib/peers.js");
  const data = await peers.readPeers();

  // 解析 peer 标识：可以是 name 或 id 或 "all"
  let peerBotId: string | "all" = "all";
  if (peer !== "all") {
    const match = data.peerBots.find((p) => p.id === peer || p.name === peer);
    if (!match) {
      output({
        ok: false,
        error: `没找到 peer "${peer}"。已知 peer bots: ${data.peerBots.map((p) => p.name).join(", ") || "(无)"}`,
      });
      return;
    }
    peerBotId = match.id;
  }

  const exp = await peers.addExposure({ localAgent, peerBotId, purpose });

  // 通过 bridge HTTP 触发通告（bridge 会在 #agent-exchange 发一条带 PeerEvent 的消息）
  const port = process.env.BRIDGE_PORT || "3847";
  let bridgeOk = false;
  try {
    const resp = await fetch(`http://localhost:${port}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "grant", local: localAgent, peer: peerBotId, purpose }),
    });
    bridgeOk = resp.ok;
  } catch { /* non-critical */ }

  output({
    ok: true,
    exposure: exp,
    broadcasted: bridgeOk,
    message: bridgeOk
      ? `已开放 ${localAgent} 给 ${peer === "all" ? "所有 peer" : peer}，并在 #agent-exchange 通告`
      : `已开放 ${localAgent} 给 ${peer === "all" ? "所有 peer" : peer}，但通告失败（bridge 没运行？）peer 侧不会立即知道`,
  });
}

async function cmdPeerRevoke(localAgent: string, peer: string) {
  const peers = await import("./lib/peers.js");
  const data = await peers.readPeers();

  let peerBotId: string | "all" = "all";
  if (peer !== "all") {
    const match = data.peerBots.find((p) => p.id === peer || p.name === peer);
    if (!match) {
      output({ ok: false, error: `没找到 peer "${peer}"` });
      return;
    }
    peerBotId = match.id;
  }

  const removed = await peers.removeExposure(localAgent, peerBotId);

  const port = process.env.BRIDGE_PORT || "3847";
  let bridgeOk = false;
  try {
    const resp = await fetch(`http://localhost:${port}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "revoke", local: localAgent, peer: peerBotId }),
    });
    bridgeOk = resp.ok;
  } catch { /* non-critical */ }

  output({
    ok: true,
    removed,
    broadcasted: bridgeOk,
    message: removed
      ? `已撤销 ${localAgent} 对 ${peer === "all" ? "所有 peer" : peer} 的开放` + (bridgeOk ? "（peer 侧已通告）" : "（通告失败）")
      : `之前没有这条 exposure`,
  });
}

async function cmdPeerStatus() {
  const peers = await import("./lib/peers.js");
  const data = await peers.readPeers();
  output({
    ok: true,
    localAgentExchangeId: data.localAgentExchangeId,
    peerBots: data.peerBots,
    exposures: data.exposures,
    capabilities: data.capabilities,
  });
}

async function cmdCost(args: string[]) {
  const { rollupJsonl, projectJsonlPath, findJsonlBySessionId, mergeByModel } =
    await import("./lib/jsonl-cost.js");

  // 参数解析
  let agentFilter: string | null = null;
  let sinceTs = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else if (a === "--week") {
      sinceTs = Date.now() - 7 * 24 * 3600_000;
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[i + 1];
      i++;
    } else if (!a.startsWith("--")) {
      agentFilter = a;
    }
  }

  const reg = await loadRegistry();
  const rows: any[] = [];
  for (const [name, info] of Object.entries(reg.agents)) {
    if (agentFilter && name !== agentFilter) continue;
    if (!info.sessionId) continue;
    let path = info.cwd ? projectJsonlPath(info.cwd, info.sessionId) : "";
    if (!path || !(await Bun.file(path).exists())) {
      const found = findJsonlBySessionId(info.sessionId);
      if (found) path = found;
      else continue;
    }
    const usage = await rollupJsonl(path, sinceTs);
    for (const u of usage) {
      rows.push({ agent: name, ...u });
    }
  }

  // 按 agent 汇总
  const byAgent = new Map<string, any>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent) || {
      agent: r.agent, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0, models: new Set<string>(),
    };
    cur.input += r.input;
    cur.cacheCreation += r.cacheCreation;
    cur.cacheRead += r.cacheRead;
    cur.output += r.output;
    cur.requests += r.requests;
    cur.models.add(r.model);
    byAgent.set(r.agent, cur);
  }

  const perAgent = [...byAgent.values()].map((x) => ({
    agent: x.agent,
    models: [...x.models],
    input: x.input,
    cacheCreation: x.cacheCreation,
    cacheRead: x.cacheRead,
    output: x.output,
    totalTokens: x.input + x.cacheCreation + x.cacheRead + x.output,
    requests: x.requests,
  }));
  perAgent.sort((a, b) => b.totalTokens - a.totalTokens);

  const total = mergeByModel(rows);

  output({
    ok: true,
    scope: agentFilter ? `agent=${agentFilter}` : "all",
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    perAgent,
    byModel: total,
    grand: {
      input: perAgent.reduce((s, r) => s + r.input, 0),
      cacheCreation: perAgent.reduce((s, r) => s + r.cacheCreation, 0),
      cacheRead: perAgent.reduce((s, r) => s + r.cacheRead, 0),
      output: perAgent.reduce((s, r) => s + r.output, 0),
      totalTokens: perAgent.reduce((s, r) => s + r.totalTokens, 0),
      requests: perAgent.reduce((s, r) => s + r.requests, 0),
    },
  });
}

async function cmdMetrics(args: string[]) {
  const { readMetrics } = await import("./lib/metrics.js");

  // 参数
  let sinceTs = 0;
  let agentFilter: string | null = null;
  let rawOutput = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else if (a === "--week") {
      sinceTs = Date.now() - 7 * 24 * 3600_000;
    } else if (a === "--since" && args[i + 1]) {
      sinceTs = new Date(args[++i]).getTime();
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[++i];
    } else if (a === "--raw") {
      rawOutput = true;
    }
  }

  let records = await readMetrics(sinceTs);
  if (agentFilter) {
    records = records.filter((r) => r.agent === agentFilter || r.meta?.agent === agentFilter);
  }

  if (rawOutput) {
    output({ ok: true, records });
    return;
  }

  // 按 event 汇总
  const byEvent = new Map<string, number>();
  const byAgent = new Map<string, { [k: string]: number }>();
  for (const r of records) {
    byEvent.set(r.event, (byEvent.get(r.event) || 0) + 1);
    const key = r.agent || r.channelId || "unknown";
    const cur = byAgent.get(key) || {};
    cur[r.event] = (cur[r.event] || 0) + 1;
    byAgent.set(key, cur);
  }

  output({
    ok: true,
    total: records.length,
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    byEvent: Object.fromEntries(byEvent),
    byAgent: Object.fromEntries(byAgent),
  });
}

async function cmdTmuxScreenshot(name: string) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const bunPath = `${process.env.HOME}/.bun/bin/bun`;
  const srcDir = import.meta.dir;
  const ts = Date.now();
  const htmlPath = `/tmp/claude-orchestrator/tmux_${tmuxName}_${ts}.html`;
  const pngPath = `/tmp/claude-orchestrator/tmux_${tmuxName}_${ts}.png`;
  await mkdir("/tmp/claude-orchestrator", { recursive: true }).catch(() => {});

  const capture = Bun.spawn(
    ["tmux", "-S", SOCK, "capture-pane", "-t", windowTarget(tmuxName), "-p", "-e", "-S", "-50"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const a2h = Bun.spawn(
    [bunPath, "run", `${srcDir}/ansi2html.ts`, htmlPath],
    { stdin: capture.stdout, stdout: "pipe", stderr: "pipe" }
  );
  await a2h.exited;
  await Bun.spawn(
    [bunPath, "run", `${srcDir}/html2png.ts`, htmlPath, pngPath, "1200"],
    { stdout: "pipe", stderr: "pipe" }
  ).exited;

  const { existsSync } = await import("fs");
  if (!existsSync(pngPath)) {
    output({ ok: false, error: "截图生成失败" });
    return;
  }
  output({ ok: true, agent: tmuxName, path: pngPath });
}

async function cmdTmuxSendKeys(name: string, keys: string[]) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  // keys 可以是 "Enter" "Escape" "Left" "C-c" 或普通字符串（用 -l 字面模式）
  for (const k of keys) {
    const special = /^(Enter|Escape|Esc|Left|Right|Up|Down|Tab|BTab|BSpace|C-[a-z]|M-[a-z]|Space)$/i.test(k);
    const args = special
      ? ["send-keys", "-t", windowTarget(tmuxName), k]
      : ["send-keys", "-t", windowTarget(tmuxName), "-l", "--", k];
    await tmuxRaw(args);
    await Bun.sleep(50);
  }
  output({ ok: true, agent: tmuxName, keys });
}

async function cmdTmuxCapture(name: string, lines: number) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const pane = await tmuxCapture(windowTarget(tmuxName), lines);
  output({ ok: true, agent: tmuxName, lines, pane });
}

async function cmdTmuxWaitIdle(name: string, timeoutMs: number) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAgentIdle(tmuxName)) {
      output({ ok: true, agent: tmuxName, idle: true, waitedMs: timeoutMs - (deadline - Date.now()) });
      return;
    }
    await Bun.sleep(500);
  }
  output({ ok: false, agent: tmuxName, idle: false, error: `等待 ${timeoutMs}ms 超时`, timedOut: true });
}

async function cmdAutoUpdate(sub: string, ...rest: string[]) {
  const { readConfig, setAutoUpdate } = await import("./lib/config-store.js");

  if (sub === "status" || sub === "" || sub === "get") {
    const cfg = await readConfig();
    output({
      ok: true,
      autoUpdate: cfg.autoUpdate,
      message: `Claudestra: ${cfg.autoUpdate.claudestra ? "on" : "off"} · Claude Code: ${cfg.autoUpdate.claudeCode ? "on" : "off"}`,
    });
    return;
  }

  // auto-update claudestra on|off  |  auto-update claude on|off
  const targetAlias: Record<string, "claudestra" | "claudeCode"> = {
    claudestra: "claudestra",
    self: "claudestra",
    claude: "claudeCode",
    "claude-code": "claudeCode",
    claudecode: "claudeCode",
    cc: "claudeCode",
  };
  const target = targetAlias[sub.toLowerCase()];
  const state = rest[0]?.toLowerCase();

  if (!target || (state !== "on" && state !== "off")) {
    output({
      ok: false,
      error: `用法: auto-update <claudestra|claude> <on|off>  |  auto-update status`,
    });
    return;
  }

  const cfg = await setAutoUpdate(target, state === "on");
  output({
    ok: true,
    autoUpdate: cfg.autoUpdate,
    message: `${target} 自动更新已${state === "on" ? "开启" : "关闭"}`,
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

  case "auto-update": {
    const [sub, ...rest] = args;
    await cmdAutoUpdate(sub || "status", ...rest);
    break;
  }

  case "cost": {
    await cmdCost(args);
    break;
  }

  case "invite-link": {
    await cmdInviteLink(args);
    break;
  }

  case "peer-expose": {
    const [agent, peer, ...rest] = args;
    if (!agent || !peer) {
      output({ ok: false, error: '用法: peer-expose <agent> <peer-name|peer-id|all> [--purpose "..."]' });
      break;
    }
    let purpose = "";
    const pIdx = rest.findIndex((a) => a === "--purpose");
    if (pIdx >= 0 && rest[pIdx + 1]) purpose = rest[pIdx + 1];
    await cmdPeerExpose(agent, peer, purpose);
    break;
  }

  case "peer-revoke": {
    const [agent, peer] = args;
    if (!agent || !peer) {
      output({ ok: false, error: "用法: peer-revoke <agent> <peer-name|peer-id|all>" });
      break;
    }
    await cmdPeerRevoke(agent, peer);
    break;
  }

  case "peer-status":
  case "peer-list": {
    await cmdPeerStatus();
    break;
  }

  case "metrics": {
    await cmdMetrics(args);
    break;
  }

  case "tmux-screenshot": {
    const [name] = args;
    if (!name) { output({ ok: false, error: "用法: tmux-screenshot <agent>" }); break; }
    await cmdTmuxScreenshot(name);
    break;
  }

  case "tmux-send-keys": {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) { output({ ok: false, error: "用法: tmux-send-keys <agent> <keys...>" }); break; }
    await cmdTmuxSendKeys(name, rest);
    break;
  }

  case "tmux-capture": {
    const [name, linesArg] = args;
    if (!name) { output({ ok: false, error: "用法: tmux-capture <agent> [lines]" }); break; }
    const lines = parseInt(linesArg || "40", 10);
    await cmdTmuxCapture(name, lines);
    break;
  }

  case "tmux-wait-idle": {
    const [name, timeoutArg] = args;
    if (!name) { output({ ok: false, error: "用法: tmux-wait-idle <agent> [timeout_ms]" }); break; }
    const timeout = parseInt(timeoutArg || "30000", 10);
    await cmdTmuxWaitIdle(name, timeout);
    break;
  }

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
        "auto-update status              — 查看自动更新开关",
        "auto-update claudestra on|off   — Claudestra 自动更新开关（默认 on）",
        "auto-update claude on|off       — Claude Code 自动更新开关（默认 on）",
        "cost [--agent <name>] [--today|--week]  — 统计 agent / 全部 token 用量",
        "invite-link [--peer]            — 生成 Discord bot 邀请 URL（--peer 最小权限给朋友；不带参数给自己用）",
        "metrics [--today|--week|--since <ISO>] [--agent <n>] [--raw]  — 汇总 bridge 事件日志",
        "tmux-screenshot <agent>         — 截图某 agent 的 tmux window（返回 PNG 路径）",
        "tmux-send-keys <agent> <keys...>  — 发按键/文本到 agent（支持 Enter/Escape/Left/C-c 等）",
        "tmux-capture <agent> [lines]    — 读 agent pane 最后 N 行",
        "tmux-wait-idle <agent> [ms]     — 阻塞直到 agent 回到 idle 状态（默认 30s）",
      ],
    });
}
} catch (err) {
  output({ ok: false, error: (err as Error).message });
  process.exit(1);
}
