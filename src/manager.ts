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

import { hostname } from "os";
import { readFile, writeFile, mkdir, readdir, stat, rename } from "fs/promises";
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
  listWindowIdsByName,
  ensureSocketDir,
  isAutoConfirmableModal,
  detectSessionIdlePrompt,
  clearShellInitPrompts,
  isClaudeReady,
  isAtShell,
} from "./lib/tmux-helper.js";
import {
  buildClaudeCommand,
  resolveDisallowed,
  listPresets,
  isKnownPreset,
  DISALLOWED_PRESETS,
  DEFAULT_PRESET,
  PERMISSION_MODES,
  isKnownPermissionMode,
  resolveModelAlias,
  listModelAliases,
  KNOWN_EFFORT_LEVELS,
  isKnownEffort,
} from "./lib/claude-launch.js";
import { printTmuxGuide } from "./lib/tmux-guide.js";
import { projectsSlug } from "./lib/jsonl-cost.js";
import { archiveSession, listArchivedSessions } from "./lib/session-archive.js";

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
  /**
   * Session-scoped effort level（low/medium/high/xhigh/max/auto），由 launcher 启动 agent 时
   * 通过 `--effort <level>` CLI flag 传给 Claude Code。空 = 不传 flag → Claude Code 用
   * `~/.claude/settings.json` 全局 effortLevel。改完要 restart 才生效。
   */
  effort?: string;
  /**
   * 权限模式（default/acceptEdits/auto/bypassPermissions/dontAsk/plan），由启动时
   * 通过 `--permission-mode`（bypass 走 `--dangerously-skip-permissions`）传给
   * Claude Code。新建交互 agent 默认 auto；cron 用 bypass。空 = 老 agent（feature
   * 之前建的）→ 启动时回退 bypass，行为不变。改完要 restart 才生效。
   */
  permissionMode?: string;
  /**
   * v2.4.19+ 频道置顶公告（带「🖥 跳到 iTerm tab」focus 按钮）的 Discord message id。
   * create/resume 时发一次并记录；已有就跳过，防 restart 重复发。
   */
  focusMsgId?: string;
  /**
   * v2.4.20+ 按 agent 钉的模型（`--model`）。别名或 model id。空 = 跟随全局
   * ~/.claude/settings.json。改完 restart 生效（是启动 flag）。
   */
  model?: string;
  /**
   * v2.6.0+ R1：标记为「可对外暴露的专用 agent」（create --external）。
   * token-add 把未标 external 的 agent 加进 scope 时要求 --force —— 防止把
   * owner 日常在用、上下文里有机密的 agent 开放给外部人。
   */
  external?: boolean;
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

let regWriteSeq = 0;
async function saveRegistry(reg: Registry) {
  await mkdir(`${process.env.HOME}/.claude-orchestrator`, { recursive: true });
  // 原子写：同目录临时文件 + rename（POSIX 下 rename 原子）。防并发 reader 读到
  // 半写文件（JSON.parse 抛错），也防单次写被撕裂。tmp 名带 pid + 进程内递增序号，
  // 两个 manager 进程 / 同进程连续写都不撞同一 tmp。
  // 注：这解决"半写/撕裂"，但不消除跨进程 read-modify-write 的 lost-update 窗口
  // （两进程各自 load→mutate→save 精确交错时后写覆盖先写）——该窗口概率低，
  // 真出问题再上文件锁。bridge 侧后台写者（clear 轮转）已尽量避开活跃 agent。
  const tmp = `${REGISTRY_PATH}.${process.pid}.${regWriteSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2));
  await rename(tmp, REGISTRY_PATH);
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

/**
 * v2.4.19+ 在 agent 频道发置顶公告（带「🖥 跳到 iTerm tab」focus 按钮）。
 * messageId 记进 registry.focusMsgId，已有就不重发（restart 沿用同一频道）。
 * bridge 没跑 / 发失败都静默 —— 公告是 nice-to-have，不该挡 create/resume。
 */
async function announceFocusButton(tmuxName: string, channelId: string): Promise<void> {
  try {
    const reg = await loadRegistry();
    if (reg.agents[tmuxName]?.focusMsgId) return;
    const result = await bridgeRequest({
      type: "announce_focus",
      channelId,
      agentName: tmuxName,
    });
    if (result?.messageId && reg.agents[tmuxName]) {
      reg.agents[tmuxName].focusMsgId = result.messageId;
      await saveRegistry(reg);
    }
  } catch { /* non-critical */ }
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


/** 从 argv 提取 --effort <level>，支持 --effort=foo */
function extractEffortFlag(args: string[]): { rest: string[]; effort?: string } {
  const rest: string[] = [];
  let effort: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--effort") {
      effort = args[++i];
    } else if (a.startsWith("--effort=")) {
      effort = a.slice("--effort=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, effort };
}

/** 从 argv 提取 --mode <permission-mode>，支持 --mode=foo */
function extractModeFlag(args: string[]): { rest: string[]; mode?: string } {
  const rest: string[] = [];
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode") {
      mode = args[++i];
    } else if (a.startsWith("--mode=")) {
      mode = a.slice("--mode=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, mode };
}

/** v2.4.20+ 从 argv 提取 --model <model>，支持 --model=foo */
function extractModelFlag(args: string[]): { rest: string[]; model?: string } {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") {
      model = args[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, model };
}

/** v2.6.0+ 从 argv 提取布尔 flag（--external / --force 这类无值开关） */
function extractBoolFlag(args: string[], flag: string): { rest: string[]; value: boolean } {
  const rest: string[] = [];
  let value = false;
  for (const a of args) {
    if (a === flag) value = true;
    else rest.push(a);
  }
  return { rest, value };
}

// ============================================================
// 命令实现
// ============================================================

async function cmdCreate(
  name: string,
  dir: string,
  purpose: string = "",
  perms: { preset?: string; disallowedRaw?: string } = {},
  effort?: string,
  permissionMode?: string,
  model?: string,
  external?: boolean,
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

  if (effort && !isKnownEffort(effort)) {
    output({
      ok: false,
      error: `未知的 effort level: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  // v2.4.11+: 新建 agent 默认 bypassPermissions（v2.1.0 - v2.4.10 默认 auto，回退）。
  // 实测 auto classifier 在 Claudestra 语境下是负优化：classifier 模型（Opus 4.7）
  // 过载会 fallback deny 全部 tool call、误判 reply 是"擅自向外发布"、每装一个新
  // MCP server 都得 install-cli 重写 allow list、每次 tool call 加几百 ms 延迟。
  // 真危险命令（rm -rf / git push --force / git reset --hard / chmod 777 等）已经
  // 在 --disallowedTools 硬黑名单里跟 permission mode 正交，bypass 也拦得住。
  // worker 都是 owner 主动 manager.ts create 创建 + agent prompt owner 写的，没
  // "路过 agent 偷跑命令"的威胁模型。auto 净亏。
  // v2.4.13+ 彻底把 "auto" 当 deprecated alias 归一到 bypassPermissions，老 registry
  // 里残留的 `permissionMode: "auto"` 显式值也不再让它复活。
  let mode = (permissionMode && permissionMode.trim()) || "bypassPermissions";
  if (mode === "auto") mode = "bypassPermissions";
  if (!isKnownPermissionMode(mode)) {
    output({
      ok: false,
      error: `未知的权限模式: "${mode}"。可用: ${PERMISSION_MODES.join(", ")}`,
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
      effort,
      permissionMode: mode,
      model,
    });
    // 新 tmux window 起来后 .zshrc / .bashrc 可能弹 oh-my-zsh / homebrew 的 Y/n
    // update prompt，会吞掉 send-keys 第一个字符。先清掉再发命令。
    await clearShellInitPrompts(target);
    await tmuxSendLine(target, cmd);

    // 4. 轮询等待就绪 — 与 restart 的 startClaudeInWindow 对齐（CLAUDE_READY_ROUNDS）
    let sessionIdlePicked = false;
    for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不卡着等用户点按钮
      if (detectSessionIdlePrompt(pane)) {
        if (!sessionIdlePicked) {
          await pickFullResume(target);
          sessionIdlePicked = true;
          await Bun.sleep(1500);
        }
        continue;
      }
      if (hasPromptToConfirm(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        await Bun.sleep(500);
        continue;
      }
      if (isClaudeReady(pane)) {
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

  // v2.5.4: 会话内补发 /model，确保 pin 真正生效（--model 对 resume 场景不可靠）
  await enforceSessionModel(tmuxName, model);

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
    effort,
    permissionMode: mode,
    ...(model ? { model } : {}),
    ...(external ? { external: true } : {}),
  };
  await saveRegistry(reg);

  await triggerSkillsRescan("add", tmuxName, expandedDir);
  await announceFocusButton(tmuxName, channelId);

  output({
    ok: true,
    agent: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    preset: perms.preset || DEFAULT_PRESET,
    effort: effort || "(inherits ~/.claude/settings.json)",
    permissionMode: mode,
    message: ready
      ? `Agent ${tmuxName} 已创建，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已创建，但 Claude Code 可能还在启动中`,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code 就绪轮询预算：240 轮 × 500ms = 120s。曾是 60s，2026-07-10 实测
// 大 session（数 MB jsonl）resume + MCP 连接可超 60s，导致实际启动成功却报
// 「启动超时」（restart 还会误标 recreated）。
const CLAUDE_READY_ROUNDS = 240;

async function cmdResume(
  name: string,
  sessionId: string,
  dir?: string,
  perms: { preset?: string; disallowedRaw?: string } = {},
  effort?: string,
  permissionMode?: string,
  model?: string,
  // v2.7+ --fork：--fork-session 分支副本（收编野生 bg 会话 / 源 session 被
  // bg agent 占用时）。就绪后探测实际新 session id 写 registry。
  forkSession = false,
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

  if (effort && !isKnownEffort(effort)) {
    output({
      ok: false,
      error: `未知的 effort level: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  // v2.4.11+: resume 也回 bypassPermissions 默认（同 cmdCreate 注释里的理由）。
  // v2.4.13+: "auto" → bypassPermissions 归一，老 registry 里的显式 auto 不再复活。
  let mode = (permissionMode && permissionMode.trim()) || "bypassPermissions";
  if (mode === "auto") mode = "bypassPermissions";
  if (!isKnownPermissionMode(mode)) {
    output({
      ok: false,
      error: `未知的权限模式: "${mode}"。可用: ${PERMISSION_MODES.join(", ")}`,
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
  let forkBefore: Set<string> | null = null;

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
      forkSession,
      displayName,
      disallowedPreset: perms.preset,
      disallowedRaw: perms.disallowedRaw,
      effort,
      permissionMode: mode,
      model,
    });
    await clearShellInitPrompts(target);
    if (forkSession) forkBefore = await listSessionJsonls(resolvedDir);
    await tmuxSendLine(target, cmd);

    // 轮询等待 — 与 restart 的 startClaudeInWindow 对齐（CLAUDE_READY_ROUNDS）
    let sessionIdlePicked = false;
    for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不卡着等用户点按钮
      if (detectSessionIdlePrompt(pane)) {
        if (!sessionIdlePicked) {
          await pickFullResume(target);
          sessionIdlePicked = true;
          await Bun.sleep(1500);
        }
        continue;
      }
      if (hasPromptToConfirm(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        await Bun.sleep(500);
        continue;
      }
      if (isClaudeReady(pane)) {
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

  // v2.5.4: 会话内补发 /model —— resume 是 --model 失效的重灾区（session 保留原模型）
  await enforceSessionModel(tmuxName, model);

  // v2.7+ fork 模式：registry 必须记 fork 出的实际新 session id，不是源 id
  let actualSessionId = sessionId;
  if (forkSession && forkBefore) {
    const newId = await waitForNewSessionId(resolvedDir, forkBefore);
    if (newId) {
      actualSessionId = newId;
      console.log(`[resume] --fork 探测到新 session ${newId.slice(0, 8)}（源 ${sessionId.slice(0, 8)}）`);
    } else {
      console.log(`[resume] ⚠️ --fork 未探测到新 session id，registry 暂记源 id`);
    }
  }

  // 更新 registry
  const reg = await loadRegistry();
  // v2.8+ 同名 agent 换 session：旧 session 退役先归档快照
  const prior = reg.agents[tmuxName];
  if (prior?.sessionId && prior.sessionId !== actualSessionId) {
    await archiveSession(tmuxName, prior.cwd, prior.sessionId).catch(() => {});
  }
  reg.agents[tmuxName] = {
    project: dir || resolvedDir.replace(process.env.HOME || "", "~"),
    purpose: `resumed: ${sessionId.slice(0, 8)}${forkSession ? " (fork)" : ""}`,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: `claude session: ${actualSessionId}${forkSession ? ` (forked from ${sessionId.slice(0, 8)})` : ""}`,
    sessionId: actualSessionId,
    cwd: resolvedDir,
    displayName: channelName,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
    effort,
    permissionMode: mode,
    ...(model ? { model } : {}),
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
    permissionMode: mode,
    message: ready
      ? `Agent ${tmuxName} 已恢复，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已恢复，但 Claude Code 可能还在启动中`,
  });
  await triggerSkillsRescan("add", tmuxName, resolvedDir);
  await announceFocusButton(tmuxName, channelId);
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
  // v2.8+ 会话退役 → 归档 jsonl 快照（CC 的 cleanupPeriodDays 会清源文件）
  if (info?.sessionId) {
    await archiveSession(tmuxName, info.cwd, info.sessionId).catch(() => {});
  }
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

  // v2.4.16+ 通知 bridge 清掉所有 inter-agent / cross-peer pending（避免被 kill
  // 的 agent 在别处被 resume 后吃陈年 pushback / nudge）。restart 走另一条路，
  // 不调这里。bridge 没启也无所谓 —— 静默失败。
  if (info?.channelId) {
    const port = process.env.BRIDGE_PORT || "3847";
    try {
      await fetch(`http://localhost:${port}/agent/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: info.channelId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* bridge 可能未运行 */ }
  }

  output({
    ok: true,
    agent: tmuxName,
    message: `${tmuxName} 已销毁。`,
  });
}

/**
 * v2.10+ 永久移除（owner 2026-07-14:「临时起的 agent 不想在列表里污染我」）:
 * kill 收尾(归档 session/删频道/清 pending) + registry 条目整个删除——列表不再
 * 显示。归档文件保留(~/.claude-orchestrator/archive/):删列表 ≠ 删档案,
 * 会话历史仍可人工翻查;误删的 agent 用 create + resume --fork 可以重建。
 */
async function cmdRemove(name: string) {
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info && !(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  if (await windowExists(tmuxName)) {
    await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
  }
  if (info?.sessionId) {
    await archiveSession(tmuxName, info.cwd, info.sessionId).catch(() => {});
  }
  if (info?.channelId) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId: info.channelId });
    } catch { /* 已 kill 过的频道早删了,静默 */ }
  }
  delete reg.agents[tmuxName];
  for (const key of Object.keys(reg.agents)) {
    if (key.toLowerCase() === tmuxName && key !== tmuxName) delete reg.agents[key];
  }
  await saveRegistry(reg);
  await triggerSkillsRescan("remove", tmuxName);
  if (info?.channelId) {
    const port = process.env.BRIDGE_PORT || "3847";
    try {
      await fetch(`http://localhost:${port}/agent/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: info.channelId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* bridge 可能未运行 */ }
  }
  output({ ok: true, agent: tmuxName, message: `${tmuxName} 已永久移除（会话归档保留）。` });
}

/**
 * 重命名一个 agent：tmux window 名 + registry key + Discord 频道名 + displayName 全部同步。
 * 不重启 Claude Code（内部显示名会在下次 restart 时更新到新名）。
 */
async function cmdRename(oldName: string, newName: string) {
  // 校验新名字合法 + 规范化
  try {
    assertValidNewName(newName);
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
    return;
  }
  const oldTmux = normalizeName(oldName);
  const newTmux = normalizeName(newName);

  if (oldTmux === newTmux) {
    output({ ok: false, error: "新旧名字相同，没啥可改的" });
    return;
  }

  const reg = await loadRegistry();
  const info = reg.agents[oldTmux];
  if (!info) {
    output({ ok: false, error: `registry 里没有 ${oldTmux}` });
    return;
  }
  if (reg.agents[newTmux]) {
    output({ ok: false, error: `${newTmux} 已存在，换个名字` });
    return;
  }

  const newChannelName = newTmux.replace(AGENT_PREFIX, "");
  const steps: any[] = [];

  // 1. tmux window rename（只有 window 还在的时候才做）
  if (await windowExists(oldTmux)) {
    const r = await tmuxRaw(["rename-window", "-t", windowTarget(oldTmux), newTmux]).catch((e) => `error: ${e.message}`);
    steps.push({ step: "tmux rename-window", ok: !r || !r.toString().startsWith("error"), raw: r || "ok" });
  } else {
    steps.push({ step: "tmux rename-window", ok: false, skipped: "tmux window 不存在" });
  }

  // 2. registry 迁移
  reg.agents[newTmux] = { ...info, displayName: newChannelName };
  delete reg.agents[oldTmux];
  await saveRegistry(reg);
  steps.push({ step: "registry", ok: true });

  // 3. Discord 频道 rename
  if (info.channelId) {
    try {
      await bridgeRequest({ type: "rename_channel", channelId: info.channelId, name: newChannelName });
      steps.push({ step: "discord channel rename", ok: true });
    } catch (e) {
      steps.push({ step: "discord channel rename", ok: false, reason: (e as Error).message });
    }
  }

  // 4. 通知 bridge 刷 skill registry（agent 名字变了，skill 映射的 agentName 要同步）
  await triggerSkillsRescan("full");

  output({
    ok: true,
    from: oldTmux,
    to: newTmux,
    channelName: newChannelName,
    steps,
    hint: "Claude Code 内部 session 的显示名会在下次 restart 时更新到新名（现在仍是旧的，不影响功能）。",
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
/**
 * Agent 用：几何识别 modal 自动确认；session-idle 不自动按（permission-watcher
 * 会发 Discord 按钮让用户决定）。
 */
const hasPromptToConfirm = (pane: string) => isAutoConfirmableModal(pane);

// ────────────────────────────────────────────────
// v2.7+ fork-session 自愈（Claude Code agents 模式适配）
// ────────────────────────────────────────────────
//
// session 被 Claude Code 的 bg agent 占用时无法 --resume（bg daemon 会把被杀
// 的占用者 respawn 回来，进程层面赢不了 —— 2026-07-09 事故实证）。唯一可靠
// 破局是 `--resume <id> --fork-session` 分支副本。fork 出的新 session id 上游
// 不直接告知，靠启动前后 diff projects 目录探测，拿到后回写 registry。

/** cwd → ~/.claude/projects/<slug>/（slug 规则与 jsonl-watcher.getJsonlPath 一致） */
function projectsDirFor(cwd: string): string {
  return join(process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd));
}

async function listSessionJsonls(cwd: string): Promise<Set<string>> {
  try {
    return new Set(
      (await readdir(projectsDirFor(cwd))).filter((f) => f.endsWith(".jsonl")),
    );
  } catch {
    return new Set();
  }
}

/** 启动前 diff：projects 目录里新出现的 jsonl → 新 session id（多个取 mtime 最新） */
async function detectNewSessionId(
  cwd: string,
  before: Set<string>,
): Promise<string | null> {
  try {
    const dir = projectsDirFor(cwd);
    const fresh = (await readdir(dir)).filter(
      (f) => f.endsWith(".jsonl") && !before.has(f),
    );
    if (fresh.length === 0) return null;
    if (fresh.length === 1) return fresh[0].replace(/\.jsonl$/, "");
    const withMtime = await Promise.all(
      fresh.map(async (f) => ({
        f,
        m: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0,
      })),
    );
    withMtime.sort((a, b) => b.m - a.m);
    return withMtime[0].f.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
}

/** 轮询探测 fork 出的新 session（jsonl 落盘可能滞后于 TUI 就绪） */
async function waitForNewSessionId(
  cwd: string,
  before: Set<string>,
  timeoutMs = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await detectNewSessionId(cwd, before);
    if (found) return found;
    await Bun.sleep(1_000);
  }
  return null;
}

/**
 * v2.0.22+: 检测到 session-idle 弹窗时自动选「恢复完整会话」(option 2)。
 *
 *   ❯ 1. Resume from summary (recommended)   ← 默认高亮 = compact，丢上下文
 *     2. Resume full session as-is            ← 我们要的
 *     3. Don't ask me again
 *
 * 这个 modal **不接受 digit 跳转**（按 "2" 没用，Enter 还是确认高亮的 option 1），
 * 只能 arrow nav：Down 一次到 option 2 再 Enter。startClaudeInWindow / cmdCreate /
 * cmdResume 三个就绪轮询都用它，不再卡着等用户点 Discord 按钮。
 */
async function pickFullResume(target: string) {
  await tmuxRaw(["send-keys", "-t", target, "Down"]);
  await Bun.sleep(150);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);
}

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

/**
 * 在已有的 tmux window 里启动 Claude Code，处理所有确认弹窗。
 * 返回 ready（是否就绪）+ recoveredFullSession（是否自动选了「恢复完整会话」，
 * 用于给频道发一条正面"已恢复"信号，取代 watcher 的按钮噪音）。
 */
/**
 * v2.5.4: 启动就绪后在会话内补一发 `/model`，强制 pin 的模型真正生效。
 *
 * 根因：`--model` 对 `--resume` 的会话经常不生效 —— session 保留它原来的模型，
 * registry 里的 model 只是"意图"。实测 12 个 agent 里 6 个 registry 写 fable、
 * 实际还在 opus。会话内 `/model` 是 TUI 层面的切换，可靠且幂等（已在目标模型时
 * 直接确认不弹框；换模型时弹 "Switch model?" 确认框，❯ 默认在 Yes，Enter 即可）。
 * 失败不阻塞启动 —— 看板显示的是 jsonl 真相，漂了能看见。
 *
 * ⚠ CC 2.1.x 起 TUI `/model` 会「saved as your default for new sessions」——直接
 * 改写 ~/.claude/settings.json 的 model,把这个 agent 的钉值传染给之后所有不带
 * --model 的新 session(2026-07-16 实测,test-eff 补发 haiku 把全局从 fable 改成了
 * haiku)。per-agent pin 不该有全局副作用:补发前快照全局值,补发后原样写回。
 */
const GLOBAL_CLAUDE_SETTINGS = `${process.env.HOME}/.claude/settings.json`;

async function enforceSessionModel(name: string, model?: string): Promise<boolean> {
  if (!model?.trim()) return true;
  const target = windowTarget(name);
  const resolved = resolveModelAlias(model.trim());
  // 快照全局默认。null = 读失败(文件不存在/坏 JSON),跳过恢复,别越修越坏。
  let globalModel: string | undefined | null = null;
  try {
    const s = JSON.parse(await Bun.file(GLOBAL_CLAUDE_SETTINGS).text());
    globalModel = typeof s.model === "string" ? s.model : undefined;
  } catch {
    /* 无快照就不恢复 */
  }
  try {
    await tmuxRaw(["send-keys", "-t", target, "-l", `/model ${resolved}`]);
    await Bun.sleep(400);
    await tmuxRaw(["send-keys", "-t", target, "Enter"]);
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(700);
      const pane = await captureLast(name, 15);
      if (/Switch model\?/i.test(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        continue;
      }
      if (/Set model to/i.test(pane)) return true;
    }
  } catch {
    /* 失败不阻塞启动 */
  } finally {
    if (globalModel !== null) {
      // CC 落盘晚于 TUI 反馈渲染(实测:检测到「Set model to」立即恢复仍被后到的
      // 写盘覆盖)——多轮延迟复查,漂了就写回。重读再只改 model 字段,期间 CC
      // 可能写过其它字段,拿旧快照全量覆盖会丢。
      for (let i = 0; i < 3; i++) {
        await Bun.sleep(1200);
        try {
          const s = JSON.parse(await Bun.file(GLOBAL_CLAUDE_SETTINGS).text());
          if (s.model !== globalModel) {
            if (globalModel === undefined) delete s.model;
            else s.model = globalModel;
            await Bun.write(GLOBAL_CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
          }
        } catch {
          /* 恢复失败不阻塞 */
        }
      }
    }
  }
  return false;
}

async function startClaudeInWindow(
  name: string,
  claudeCmd: string
): Promise<{ ready: boolean; recoveredFullSession: boolean; bgOccupied?: boolean }> {
  const target = windowTarget(name);

  // 确保在 shell 提示符
  const preLaunch = await captureLast(name, 3);
  if (!isAtShell(preLaunch)) {
    // 等一下 shell
    await Bun.sleep(2000);
    const retry = await captureLast(name, 3);
    if (!isAtShell(retry)) return { ready: false, recoveredFullSession: false };
  }

  // 发送启动命令前先清掉 shell init 阶段可能存在的 Y/n 交互（oh-my-zsh / homebrew）
  await clearShellInitPrompts(target);
  await tmuxSendLine(target, claudeCmd);

  // 轮询处理各种确认提示（预算见 CLAUDE_READY_ROUNDS）
  let sessionIdlePicked = false;
  for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // Claude Code 就绪
    if (isClaudeReady(pane)) return { ready: true, recoveredFullSession: sessionIdlePicked };

    // v2.7+: session 被 bg agent 占用 → claude 报错退出。提前返回 bgOccupied，
    // 让 cmdRestart 走 --fork-session 自愈重试（见 projectsDirFor 上方注释）。
    if (/currently running as a background agent/i.test(pane)) {
      return { ready: false, recoveredFullSession: false, bgOccupied: true };
    }

    // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不再卡着等用户点按钮。
    // picked 标记防止重复发键；发完给加载留窗口，下轮再判 ready。
    if (detectSessionIdlePrompt(pane)) {
      if (!sessionIdlePicked) {
        await pickFullResume(target);
        sessionIdlePicked = true;
        await Bun.sleep(1500);
      }
      continue;
    }

    // 有确认提示 → 按 Enter
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  // 最后再捕一次：用同样的严格条件兜底（不靠循环结束的瞬时状态）。
  // 严格条件 isClaudeReady 同时要求 ❯ 和 "bypass permissions"，避免 ❯ 出现在
  // "❯ 1. I am using this for local development" 这类选项菜单里被误判。
  const final = await captureLast(name, 10);
  return { ready: isClaudeReady(final), recoveredFullSession: sessionIdlePicked };
}

/**
 * v2.7+ 收编（分身替换）：把指定 session（典型来源是 agents 视图误触 fork 出的
 * bg 分身，其上下文比正式 agent 新）立为该 agent 的正式会话，然后走 cmdRestart
 * 拉起。restart 的 bg 占用自愈路径会自动 --fork-session 并回写实际新 session id，
 * 所以这里只需要改 registry —— 占用与否都能正确拉起。
 */
async function cmdAdopt(name: string, sessionId: string) {
  if (!UUID_RE.test(sessionId)) {
    output({ ok: false, error: `非法 sessionId: "${sessionId}"（应为 UUID 格式）` });
    return;
  }
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `${tmuxName} 不在 registry（野生会话收编请用 resume <新名> <sessionId> --fork）` });
    return;
  }
  const oldId = info.sessionId;
  // v2.8+ 被替换的旧 session 先归档快照
  if (oldId && oldId !== sessionId) {
    await archiveSession(tmuxName, info.cwd, oldId).catch(() => {});
  }
  info.sessionId = sessionId;
  info.notes = `claude session: ${sessionId} (adopted${oldId ? `, was ${oldId.slice(0, 8)}` : ""})`;
  await saveRegistry(reg);
  console.log(`[adopt] ${tmuxName} sessionId ${oldId?.slice(0, 8) ?? "(无)"} → ${sessionId.slice(0, 8)}，restart 拉起`);
  await cmdRestart(tmuxName);
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

    // 1. 看同名 window 数量决定路径。永远不要用 ambiguous name target 做 kill
    //    —— v2.4.2 之前这里走 `kill-window -t master:<name>`，tmux 遇到多份同名
    //    会报 "more than one window" 错误，外层 `.catch(() => {})` 吞掉错误后
    //    无条件 new-window，导致 launcher periodic 每分钟净增 1 个 zombie。
    //    关键：永远不创建新 Discord 频道，复用 info.channelId
    let recreated = false;
    const dupIds = await listWindowIdsByName(tmuxName);

    if (dupIds.length === 0) {
      // 真 dead，直接 new
      recreated = true;
    } else if (dupIds.length === 1) {
      // 正常一份 —— 优雅退出，失败 by-id kill 这一份再 new
      const exited = await gracefulExit(tmuxName);
      if (!exited) {
        console.log(`[restart] ${tmuxName} 优雅退出超时，kill-window @${dupIds[0]} + 重建`);
        await tmuxRaw(["kill-window", "-t", dupIds[0]]).catch(() => {});
        await Bun.sleep(500);
        recreated = true;
      }
    } else {
      // 多份 zombie（历史 race / restart 死循环遗留）—— 全部 by-id kill 再 new
      console.log(`[restart] ${tmuxName} 发现 ${dupIds.length} 个同名 zombie window，全部 kill 后重建`);
      for (const id of dupIds) {
        await tmuxRaw(["kill-window", "-t", id]).catch(() => {});
      }
      await Bun.sleep(500);
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
      effort: info.effort,
      // 老 agent（feature 前建的）info.permissionMode 为空 → buildClaudeCommand
      // 回退 bypassPermissions，行为不变。新 agent 沿用 registry 里存的模式。
      permissionMode: info.permissionMode,
      // v2.4.20+ restart 沿用 registry 里钉的模型（这是"改全局无效"的解法：
      // 显式 --model 覆盖 --resume 钉死的会话原模型）。
      model: info.model,
    });

    let started = await startClaudeInWindow(tmuxName, cmd);

    // v2.7+ 自愈：session 被 bg agent 占用 → --fork-session 分支副本重试，
    // 就绪后探测 fork 出的新 session id 并回写 registry（否则 watcher/下次
    // restart 又会盯回被占用的旧 id）。
    if (!started.ready && started.bgOccupied) {
      const cwd = info.cwd || process.env.HOME || "/";
      console.log(`[restart] ${tmuxName} 的 session 被 bg agent 占用，改用 --fork-session 重试`);
      const before = await listSessionJsonls(cwd);
      const forkCmd = buildClaudeCommand({
        channelId: info.channelId,
        bridgeUrl: BRIDGE_URL,
        resumeId: info.sessionId,
        forkSession: true,
        displayName,
        disallowedPreset: info.disallowedPreset,
        disallowedRaw: info.disallowedRaw,
        effort: info.effort,
        permissionMode: info.permissionMode,
        model: info.model,
      });
      started = await startClaudeInWindow(tmuxName, forkCmd);
      if (started.ready) {
        const newId = await waitForNewSessionId(cwd, before);
        if (newId) {
          // v2.8+ fork 换代：旧 session 从 registry 退役，先归档快照
          await archiveSession(tmuxName, cwd, info.sessionId).catch(() => {});
          reg.agents[tmuxName].sessionId = newId;
          reg.agents[tmuxName].notes = `claude session: ${newId} (forked from ${info.sessionId.slice(0, 8)})`;
          await saveRegistry(reg);
          console.log(`[restart] ${tmuxName} fork 出新 session ${newId.slice(0, 8)}，registry 已回写`);
        } else {
          console.log(`[restart] ⚠️ ${tmuxName} fork 成功但未探测到新 session id，registry 未更新`);
        }
        await bridgeRequest({
          type: "reply",
          chatId: info.channelId,
          text: `🔀 ${displayName} 原 session 被后台 agent 占用，已自动 fork 副本恢复（上下文完整）${newId ? "" : "，⚠️ 新 session id 探测失败请查 registry"}`,
        }).catch(() => {});
      }
    }

    // v2.5.4: 会话内补发 /model，restart 也是 --resume（同样会漂回 session 原模型）
    if (started.ready) await enforceSessionModel(tmuxName, info.model);

    results.push({
      name: tmuxName,
      ok: started.ready,
      error: started.ready ? undefined : "启动超时",
      recreated: recreated || undefined,
    });

    // v2.0.23+: 自动恢复了完整会话 → 给该 agent 频道发一条正面"已恢复"信号，
    // 取代 permission-watcher 那条让人摸不清状态的 session-idle 按钮消息。
    // 只在确实命中 session-idle 弹窗时发；普通秒级重启不打扰。
    if (started.ready && started.recoveredFullSession) {
      await bridgeRequest({
        type: "reply",
        chatId: info.channelId,
        text: `✅ ${displayName} 已重启，自动恢复完整会话（无 compact，上下文保留）`,
      }).catch(() => { /* 通知失败不影响重启结果 */ });
    }
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

async function cmdCronAdd(name: string, schedule: string, dir: string, prompt: string, reportChannelId?: string, targetAgent?: string) {
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
    ...(reportChannelId ? { reportChannelId } : {}),
    ...(targetAgent ? { targetAgent } : {}),
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
      ...(j.targetAgent ? { targetAgent: j.targetAgent } : {}),
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
// Effort level 管理（per-agent --effort）
// ============================================================

async function cmdEffort(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        effort: info.effort || "(inherit)",
      }));
    output({ ok: true, agents: rows, hint: "(inherit) = 跟随 ~/.claude/settings.json 全局 effortLevel" });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "用法: effort get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    output({
      ok: true,
      agent: tmuxName,
      effort: info.effort || "(inherit)",
    });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "用法: effort reset <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.effort = undefined;
    await saveRegistry(reg);
    output({
      ok: true,
      agent: tmuxName,
      effort: "(inherit)",
      hint: `已清除。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  // 默认形式：effort <agent> <level> 或 effort set <agent> <level>
  let agentName: string;
  let level: string;
  if (sub === "set") {
    [agentName, level] = rest;
  } else {
    agentName = sub;
    level = rest[0];
  }

  if (!agentName || !level) {
    output({
      ok: false,
      error: "用法: effort <agent> <level>｜effort reset <agent>｜effort list",
      validLevels: KNOWN_EFFORT_LEVELS,
    });
    return;
  }

  if (!isKnownEffort(level)) {
    output({
      ok: false,
      error: `未知的 effort level: "${level}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `找不到 agent: ${tmuxName}` });
    return;
  }
  info.effort = level;
  await saveRegistry(reg);
  output({
    ok: true,
    agent: tmuxName,
    effort: level,
    hint: `已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
  });
}

/**
 * mode 子命令 —— 查看 / 改 agent 的权限模式（--permission-mode）。
 * 用法对齐 cmdEffort：
 *   mode list                列出所有 agent 的模式
 *   mode get <agent>         查单个
 *   mode <agent> <mode>      改（= mode set <agent> <mode>）
 * 改完要 restart 才生效（是启动 flag）。
 */
async function cmdMode(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        permissionMode: info.permissionMode || "(bypass, 老 agent)",
      }));
    output({
      ok: true,
      agents: rows,
      validModes: PERMISSION_MODES,
      hint: "(bypass, 老 agent) = feature 前建的，启动回退 bypassPermissions",
    });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "用法: mode get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    output({
      ok: true,
      agent: tmuxName,
      permissionMode: info.permissionMode || "(bypass, 老 agent)",
    });
    return;
  }

  // 默认形式：mode <agent> <mode> 或 mode set <agent> <mode>
  let agentName: string;
  let modeVal: string;
  if (sub === "set") {
    [agentName, modeVal] = rest;
  } else {
    agentName = sub;
    modeVal = rest[0];
  }

  if (!agentName || !modeVal) {
    output({
      ok: false,
      error: "用法: mode <agent> <mode>｜mode get <agent>｜mode list",
      validModes: PERMISSION_MODES,
    });
    return;
  }

  if (!isKnownPermissionMode(modeVal)) {
    output({
      ok: false,
      error: `未知的权限模式: "${modeVal}"。可用: ${PERMISSION_MODES.join(", ")}`,
    });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `找不到 agent: ${tmuxName}` });
    return;
  }
  info.permissionMode = modeVal;
  await saveRegistry(reg);
  output({
    ok: true,
    agent: tmuxName,
    permissionMode: modeVal,
    hint: `已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
  });
}

/**
 * v2.4.20+ model 子命令 —— 查看 / 改 agent 的模型（--model）。用法对齐 cmdEffort：
 *   model list                  列出所有 agent 的模型 + 可用别名
 *   model get <agent>           查单个
 *   model <agent> <model>       改（= model set <agent> <model>）
 *   model reset <agent>         清除（跟随全局 settings.json）
 *   model all <model>           一把把所有 active agent 钉到同一模型
 * 改完要 restart 才生效（是启动 flag）。
 */
async function cmdModel(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        model: info.model ? resolveModelAlias(info.model) : "(inherit)",
      }));
    output({
      ok: true,
      agents: rows,
      aliases: listModelAliases(),
      hint: "(inherit) = 跟随 ~/.claude/settings.json 全局模型。别名或完整 model id 都可用。",
    });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) { output({ ok: false, error: "用法: model get <name>" }); return; }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
    output({ ok: true, agent: tmuxName, model: info.model ? resolveModelAlias(info.model) : "(inherit)" });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) { output({ ok: false, error: "用法: model reset <name>" }); return; }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
    info.model = undefined;
    await saveRegistry(reg);
    output({
      ok: true, agent: tmuxName, model: "(inherit)",
      hint: `已清除。restart ${tmuxName.replace(AGENT_PREFIX, "")} 生效。`,
    });
    return;
  }

  // model all <model> —— 一把钉所有 active agent（满足"把所有 agent 切 fable"）
  if (sub === "all") {
    const [modelVal] = rest;
    if (!modelVal) { output({ ok: false, error: "用法: model all <model>", aliases: listModelAliases() }); return; }
    const resolved = resolveModelAlias(modelVal);
    const reg = await loadRegistry();
    const changed: string[] = [];
    for (const [name, info] of Object.entries(reg.agents)) {
      if (info.status === "active") {
        info.model = modelVal;
        changed.push(name);
      }
    }
    await saveRegistry(reg);
    // v2.5.4: idle 的 agent 顺手在会话内立即生效（忙的跳过，restart 时会补发）
    const applied: string[] = [];
    for (const name of changed) {
      if ((await isAgentIdle(name).catch(() => false)) && (await enforceSessionModel(name, modelVal))) {
        applied.push(name);
      }
    }
    output({
      ok: true,
      model: resolved,
      changed,
      appliedLive: applied,
      hint: `已钉 ${changed.length} 个 active agent 到 ${resolved}；${applied.length} 个 idle 的已当场生效，其余在下次 restart 时自动补发 /model。`,
    });
    return;
  }

  // 默认：model <agent> <model> 或 model set <agent> <model>
  let agentName: string;
  let modelVal: string;
  if (sub === "set") {
    [agentName, modelVal] = rest;
  } else {
    agentName = sub;
    modelVal = rest[0];
  }

  if (!agentName || !modelVal) {
    output({ ok: false, error: "用法: model <agent> <model>｜model reset <agent>｜model all <model>｜model list", aliases: listModelAliases() });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
  info.model = modelVal;
  await saveRegistry(reg);
  // v2.5.4: idle 就当场在会话内生效；忙就等下次 restart 自动补发
  const appliedLive =
    (await isAgentIdle(tmuxName).catch(() => false)) && (await enforceSessionModel(tmuxName, modelVal));
  output({
    ok: true,
    agent: tmuxName,
    model: resolveModelAlias(modelVal),
    appliedLive,
    hint: appliedLive
      ? `已写入 registry 并当场生效（会话内 /model）。`
      : `已写入 registry。agent 正忙，会在下次 restart 时自动补发 /model 生效。`,
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

  // v2.4.0+: 不再 pm2 restart。install-cli 用 launchctl bootout+bootstrap 来
  // reload 三个 daemon plist，每次都生效新代码；如果检测到老 pm2 进程也会顺手
  // stop 掉避免双跑。pm2 从启动链彻底解耦。

  // 6b. 告诉正在跑的 master Claude Code 退出，launcher 会用新 CLAUDE.md 重启它
  //     （daemon reload 只重启 bridge/launcher/cron 三个后台进程，不会动 tmux 里
  //      的 master session — 不这么做的话老 master 会继续跑着旧的 CLAUDE.md 上下文）
  await Bun.sleep(500);
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch(() => {});

  // 7. install-cli —— 写 CLI wrapper + 3 个 daemon plist + 迁移老 pm2/老 autostart
  //    plist + stop 老 pm2 daemon + launchctl bootstrap 三个新 plist（这一步等同于
  //    重启 daemon，自动加载新代码）。Idempotent —— 每次 update 跑一次都安全；老用户
  //    从 v2.3.x 升级到 v2.4.0 的第一次 update 就把所有迁移做完，全无感。
  const { installClaudestraCli } = await import("./lib/cli-install.js");
  const cliInstall = await installClaudestraCli(REPO_ROOT);

  output({
    ok: true,
    from: `v${local}`,
    to: release.tag,
    message: `已更新到 ${release.tag} 并 reload 三个 launchd daemon`,
    masterReRendered: rendered,
    cliInstalled: cliInstall.errors.length === 0,
    cliWrapper: cliInstall.cliWrapper || undefined,
    daemons: cliInstall.daemons.map((d) => ({ label: d.label, loaded: d.loaded, warning: d.warning })),
    pm2Stopped: cliInstall.pm2Stopped.length > 0 ? cliInstall.pm2Stopped : undefined,
    oldAutostartPlist: cliInstall.oldAutostartPlist,
    oldPm2StartupPlist: cliInstall.oldPm2StartupPlist,
    migratedHookCommand: cliInstall.migratedHookCommand || undefined,
    bumpedTmuxDashboardLimit: cliInstall.bumpedTmuxDashboardLimit,
    allowedMcpTools: cliInstall.allowedMcpTools,
    cliErrors: cliInstall.errors.length > 0 ? cliInstall.errors : undefined,
    cliWarnings: cliInstall.warnings.length > 0 ? cliInstall.warnings : undefined,
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

// ============================================================
// v2.6.0+ HTTP API token（多前端架构 Phase B，设计 §3.4 / §5.1 / R1）
// ============================================================

/**
 * token-add <name> --agents a,b [--force] [--no-mirror]
 * 生成一个 API token，scope 限定在指定 agent。secret 只显示这一次。
 * R1 防呆：目标 agent 未标 external:true（create --external）时要求 --force。
 */
async function cmdTokenAdd(name: string, agentsCsv: string, force: boolean, noMirror: boolean, terminal: boolean) {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } =
    await import("./lib/principals.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!name || agents.length === 0) {
    output({ ok: false, error: 'token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]' });
    return;
  }

  // scope 里的 agent 校验：存在性 + R1 external 检查（"*" 跳过存在性，仍警告）
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) {
        output({
          ok: false,
          error: `--agents "*" 会把全部 agent 开放给这个 token（master 除外）。上下文共享有泄密风险（R1），确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"*" scope：所有普通 agent 都对此 token 可见`);
      continue;
    }
    // [fork] "master" 是特殊 scope 值（大总管不在 registry）：显式列出 + --force 才放行
    if (a === "master") {
      if (!force) {
        output({
          ok: false,
          error: `--agents 含 "master" 会把大总管开放给这个 token（上下文最敏感，R1）。确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"master" scope：大总管对此 token 可见`);
      continue;
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) {
      output({ ok: false, error: `agent "${a}" 不存在（registry 里没有 ${a} / agent-${a}）` });
      return;
    }
    if (!info.external && !force) {
      output({
        ok: false,
        error:
          `agent "${a}" 未标记为对外专用（external）。把日常在用的 agent 开放给外部 token，` +
          `对方可以套出该 agent 上下文里的既有内容（R1 共享上下文风险）。` +
          `建议：为外部用途新建专用 agent（create <name> <dir> --external）；` +
          `确实要开放这个就加 --force。`,
      });
      return;
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }

  if (terminal) {
    warnings.push(`--terminal：此 token 可开远程终端（往 agent 的 tmux 注入按键 = 宿主 shell 级访问，可绕过 --disallowedTools）`);
  }

  const file = await readPrincipals();
  const p = newTokenPrincipal(name, agents, { terminal });
  if (noMirror) p.mirror = false;
  file.principals.push(p);
  await writePrincipals(file);

  output({
    ok: true,
    tokenId: tokenIdOf(p),
    name,
    agents,
    mirror: p.mirror,
    terminal: p.terminal === true,
    secret: p.secret,
    secretNote: "⚠️ secret 只显示这一次，请立即保存。调用方式: Authorization: Bearer <secret>",
    warnings,
    usage: `curl -H "Authorization: Bearer ${p.secret}" -X POST http://<bridge>/api/v1/agents/${agents[0] === "*" ? "<agent>" : agents[0]}/messages -H "Content-Type: application/json" -d '{"text":"你好","wait":60}'`,
  });
}

// ── v2.11+ HTTP peer 握手（docs/design-http-peers.md §3）─────────────────

/** peer 名校验:名字要进 `x@peer` / `peer:name.agent` 寻址语法,"@" "." 空白都会
 *  撞分隔符(review 2026-07-19 #11) */
function validPeerName(name: string): boolean {
  return /^[\w-]{1,32}$/.test(name);
}

/** 握手串自报名:对方界面上「谁邀请的我」。USER_NAME 是 setup 时配置的称呼。 */
function selfPeerName(): string {
  return (process.env.USER_NAME || "").trim().replace(/[^\w-]/g, "") || hostname().split(".")[0];
}

/** invite/join 共用的 scope 校验（token-add 同款 R1 规则,不动原函数避免回归） */
async function checkPeerScope(agents: string[], force: boolean): Promise<{ error?: string; warnings: string[] }> {
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) return { error: `--agents "*" 会把全部 agent 开放给 peer（R1 共享上下文风险）。确认请加 --force。`, warnings };
      warnings.push(`"*" scope：所有普通 agent 都对此 peer 可见`);
      continue;
    }
    if (a === "master") {
      if (!force) return { error: `把大总管开放给 peer 风险极高（R1）。确认请加 --force。`, warnings };
      warnings.push(`"master" scope：大总管对此 peer 可见`);
      continue;
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) return { error: `agent "${a}" 不存在`, warnings };
    if (!info.external && !force) {
      return { error: `agent "${a}" 未标 external——peer 可套出其上下文既有内容（R1）。建议为 peer 用途 create --external 专用 agent；确实要开放就加 --force。`, warnings };
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }
  return { warnings };
}

/** 为 peer 签 token 并登记 principal。返回 {tokenId, secret} */
async function issuePeerToken(peerName: string, agents: string[]): Promise<{ tokenId: string; secret: string }> {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } = await import("./lib/principals.js");
  const file = await readPrincipals();
  // 同名 peer 的旧 token 先禁用（重跑握手不留悬空凭据）
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) p.disabled = true;
  }
  const p = newTokenPrincipal(`peer-${peerName}`, agents, { peer: peerName });
  file.principals.push(p);
  await writePrincipals(file);
  return { tokenId: tokenIdOf(p), secret: p.secret! };
}

async function cmdPeerHttpInvite(peerName: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, encodePeerHandshake, findHttpPeer } = await import("./lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || agents.length === 0 || !myUrl) {
    output({ ok: false, error: "peer-http-invite <peerName> --agents <a,b> --url <我方bridge地址,如 http://100.x.y.z:3847> [--force] [--rotate]" });
    return;
  }
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)——"@" "." 空格会撞 send_to_agent 的寻址语法` });
    return;
  }
  // 重跑保护:签新 token 会禁用旧 token,已完成握手的 peer 会立刻断联(review #9)
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 invite 会作废对方手里的 token(对方立刻断联,需重新走完三步)。确认轮换请加 --rotate。` });
      return;
    }
  }
  if (!/^https?:\/\//.test(myUrl)) {
    output({ ok: false, error: `--url 必须是 http(s):// 开头的对外可达地址（Tailscale IP / 内网 IP / 反代域名）` });
    return;
  }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, inTokenId: tokenId });
  const invite = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, exposedAgents: agents, inTokenId: tokenId, warnings: check.warnings,
    invite,
    next: `把 invite 串发给对方 → 对方跑: peer-http-join <你的名字> '<invite串>' --agents <他开放的> --url <他的地址> → 他把回执串发回 → 你跑: peer-http-accept ${peerName} '<回执串>'`,
  });
}

async function cmdPeerHttpJoin(peerName: string, handshakeStr: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, parsePeerHandshake, encodePeerHandshake, findHttpPeer } = await import("./lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || !handshakeStr || agents.length === 0 || !myUrl) {
    output({ ok: false, error: "peer-http-join <peerName> '<邀请串>' --agents <a,b> --url <我方地址> [--force] [--rotate]" });
    return;
  }
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)` });
    return;
  }
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 join 会作废双方 token。确认轮换请加 --rotate。` });
      return;
    }
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "邀请串无法解析（应为 peer-http-invite 输出的 base64 串）" }); return; }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token, inTokenId: tokenId });
  const receipt = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, peerUrl: hs.url, exposedAgents: agents, inTokenId: tokenId, warnings: check.warnings,
    receipt,
    next: `把 receipt 串发回对方 → 对方跑: peer-http-accept <你在他那的名字> '<receipt串>'。然后双方各自 peer-http-test 验证。`,
  });
}

async function cmdPeerHttpAccept(peerName: string, handshakeStr: string) {
  const { findHttpPeer, upsertHttpPeer, parsePeerHandshake } = await import("./lib/peers.js");
  if (!peerName || !handshakeStr) {
    output({ ok: false, error: "peer-http-accept <peerName> '<回执串>'" });
    return;
  }
  const existing = await findHttpPeer(peerName);
  if (!existing) {
    output({ ok: false, error: `HTTP peer "${peerName}" 不存在——先跑 peer-http-invite ${peerName} ...` });
    return;
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "回执串无法解析" }); return; }
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token });
  output({ ok: true, peer: peerName, peerUrl: hs.url, note: `握手完成。跑 peer-http-test ${peerName} 验证连通。` });
}

async function cmdPeerHttpTest(peerName: string) {
  const { findHttpPeer } = await import("./lib/peers.js");
  const peer = await findHttpPeer(peerName);
  if (!peer) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  if (!peer.outToken || !peer.baseUrl) {
    output({ ok: false, error: `握手未完成（${!peer.baseUrl ? "缺对方地址" : "缺 outToken"}）——invite 后要等 accept 回执` });
    return;
  }
  try {
    const res = await fetch(`${peer.baseUrl}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${peer.outToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      output({ ok: false, error: `对方返回 ${res.status}: ${body?.error || "未知"}`, hint: res.status === 401 ? "token 无效/已 revoke——重新握手" : undefined });
      return;
    }
    const agents = (body?.agents || []).map((a: any) => ({ name: a.name, status: a.status }));
    output({ ok: true, peer: peerName, url: peer.baseUrl, reachable: true, remoteAgents: agents, note: `send_to_agent 用法: target="<对方agent>@${peerName}"` });
  } catch (e) {
    output({ ok: false, error: `连接失败: ${(e as Error).message}`, hint: "确认对方 bridge 在线、BRIDGE_BIND 对外可达、URL/端口正确" });
  }
}

async function cmdPeerHttpList() {
  const { readPeers } = await import("./lib/peers.js");
  const data = await readPeers();
  const peers = (data.httpPeers || []).map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl || "(等待对方回执)",
    handshakeDone: !!(p.outToken && p.baseUrl),
    inTokenId: p.inTokenId,
    disabled: !!p.disabled,
    addedAt: p.addedAt,
  }));
  output({ ok: true, count: peers.length, httpPeers: peers });
}

async function cmdPeerHttpRemove(peerName: string) {
  const { removeHttpPeer } = await import("./lib/peers.js");
  const { readPrincipals, writePrincipals } = await import("./lib/principals.js");
  const removed = await removeHttpPeer(peerName);
  if (!removed) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  // 我签出去的 token 一并禁用——对方立刻失去入站能力
  const file = await readPrincipals();
  let revoked = 0;
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) { p.disabled = true; revoked++; }
  }
  if (revoked) await writePrincipals(file);
  output({ ok: true, removed: peerName, tokensRevoked: revoked, note: "对方持有的 token 已失效;我方存的对方 token 已删除" });
}

async function cmdTokenList() {
  const { readPrincipals, tokenIdOf } = await import("./lib/principals.js");
  const file = await readPrincipals();
  const tokens = file.principals
    .filter((p) => p.id.startsWith("token:"))
    .map((p) => ({
      tokenId: tokenIdOf(p),
      name: p.name,
      agents: p.agents,
      disabled: !!p.disabled,
      mirror: p.mirror !== false,
      createdAt: p.createdAt,
      secretPreview: p.secret ? `${p.secret.slice(0, 8)}…` : "",
    }));
  output({ ok: true, count: tokens.length, tokens });
}

async function cmdTokenRevoke(idOrName: string) {
  const { readPrincipals, writePrincipals, findToken, tokenIdOf } =
    await import("./lib/principals.js");
  const file = await readPrincipals();
  const p = findToken(file, idOrName);
  if (!p) {
    output({ ok: false, error: `找不到 token: ${idOrName}（token-list 查看现有的）` });
    return;
  }
  file.principals = file.principals.filter((x) => x !== p);
  await writePrincipals(file);
  output({ ok: true, revoked: tokenIdOf(p), name: p.name, message: "token 已删除，立即失效" });
}

async function cmdPeerExpose(localAgent: string, peer: string, purpose: string, mode: "direct" | "via_master" = "direct") {
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

  const exp = await peers.addExposure({ localAgent, peerBotId, purpose, mode });

  // 通过 bridge HTTP 触发通告（bridge 会在 #agent-exchange 发一条带 PeerEvent 的消息）
  const port = process.env.BRIDGE_PORT || "3847";
  let bridgeOk = false;
  try {
    const resp = await fetch(`http://localhost:${port}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "grant", local: localAgent, peer: peerBotId, purpose, mode }),
    });
    bridgeOk = resp.ok;
  } catch { /* non-critical */ }

  const modeNote = mode === "direct"
    ? "（direct 模式：peer 请求由 bridge 直接路由给 agent，绕过 master）"
    : "（via_master 模式：peer 请求先进 master，master 用 send_to_agent 转）";

  output({
    ok: true,
    exposure: exp,
    broadcasted: bridgeOk,
    message: bridgeOk
      ? `已开放 ${localAgent} 给 ${peer === "all" ? "所有 peer" : peer} ${modeNote}，并在 #agent-exchange 通告`
      : `已开放 ${localAgent} 给 ${peer === "all" ? "所有 peer" : peer} ${modeNote}，但通告失败（bridge 没运行？）peer 侧不会立即知道`,
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
    const { rest: afterExternal, value: external } = extractBoolFlag(args, "--external");
    const { rest: afterModel, model } = extractModelFlag(afterExternal);
    const { rest: afterMode, mode } = extractModeFlag(afterModel);
    const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterEffort);
    const [name, dir, ...purposeParts] = posArgs;
    if (!name || !dir) {
      output({
        ok: false,
        error: 'create <name> <dir> [purpose] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>] [--external]',
      });
      break;
    }
    await cmdCreate(name, dir, purposeParts.join(" "), { preset, disallowedRaw }, effort, mode, model, external);
    break;
  }

  // v2.6.0+ HTTP API token 管理（多前端架构 Phase B）
  case "token-add": {
    const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
    const { rest: afterMirror, value: noMirror } = extractBoolFlag(afterForce, "--no-mirror");
    const { rest: afterTerm, value: terminal } = extractBoolFlag(afterMirror, "--terminal");
    // --agents a,b（也接受 --agents=a,b）
    let agentsCsv = "";
    const posArgs: string[] = [];
    for (let i = 0; i < afterTerm.length; i++) {
      const a = afterTerm[i];
      if (a === "--agents") agentsCsv = afterTerm[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice("--agents=".length);
      else posArgs.push(a);
    }
    await cmdTokenAdd(posArgs.join(" "), agentsCsv, force, noMirror, terminal);
    break;
  }
  case "token-list":
    await cmdTokenList();
    break;
  case "token-revoke": {
    const [idOrName] = args;
    if (!idOrName) {
      output({ ok: false, error: "token-revoke <tokenId|name>" });
      break;
    }
    await cmdTokenRevoke(idOrName);
    break;
  }

  case "resume": {
    const { rest: afterFork, value: fork } = extractBoolFlag(args, "--fork");
    const { rest: afterModel, model } = extractModelFlag(afterFork);
    const { rest: afterMode, mode } = extractModeFlag(afterModel);
    const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterEffort);
    const [name, sessionId, dir] = posArgs;
    if (!name || !sessionId) {
      output({
        ok: false,
        error: 'resume <name> <sessionId> [dir] [--fork] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>]',
      });
      break;
    }
    await cmdResume(name, sessionId, dir, { preset, disallowedRaw }, effort, mode, model, fork);
    break;
  }

  // v2.7+ 收编：adopt <name> <sessionId> —— 把 bg 分身/任意 session 立为正式会话并重启
  case "adopt": {
    const [name, sessionId] = args;
    if (!name || !sessionId) {
      output({ ok: false, error: "用法: adopt <name> <sessionId> — 把指定 session（如 bg 分身）收编为该 agent 的正式会话并重启拉起" });
      break;
    }
    await cmdAdopt(name, sessionId);
    break;
  }

  // v2.8+ 手动归档：archive <name> —— 立即快照该 agent 当前 session 的 jsonl
  case "archive": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "用法: archive <name> — 立即归档该 agent 当前 session 的对话 jsonl" });
      break;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info?.sessionId) {
      output({ ok: false, error: `${tmuxName} 不在 registry 或无 sessionId` });
      break;
    }
    const r = await archiveSession(tmuxName, info.cwd, info.sessionId);
    const all = await listArchivedSessions(tmuxName);
    output({ ok: r.ok, note: r.note, archived: r.archived, sessions: all });
    break;
  }

  // [fork] set-session：把 agent 的官方 sessionId 切到新值（先归档旧会话）。
  // 供 bridge 的 clear 端点用：TUI 里 /clear 会轮转 sessionId，registry 若不跟着
  // 换，jsonl-watcher 会盯死文件。registry 写入必须经 manager（唯一写者不变式）。
  case "set-session": {
    const [name, newSid] = args;
    if (!name || !newSid) {
      output({ ok: false, error: "用法: set-session <name> <sessionId>" });
      break;
    }
    if (!/^[0-9a-f-]{8,64}$/i.test(newSid)) {
      output({ ok: false, error: `sessionId 形状非法: ${newSid}` });
      break;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `${tmuxName} 不在 registry` });
      break;
    }
    const oldSid = info.sessionId || null;
    // 旧会话退役 → 归档快照（对齐 kill/fork 轮转的退役语义）
    if (oldSid && oldSid !== newSid) {
      await archiveSession(tmuxName, info.cwd, oldSid).catch(() => {});
    }
    info.sessionId = newSid;
    await saveRegistry(reg);
    output({ ok: true, name: tmuxName, sessionId: newSid, previousSessionId: oldSid });
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

  case "remove": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "用法: remove <name>（kill + 从列表永久移除,归档保留）" });
      break;
    }
    await cmdRemove(name);
    break;
  }

  case "rename": {
    const [oldName, newName] = args;
    if (!oldName || !newName) {
      output({ ok: false, error: "用法: rename <old-name> <new-name>" });
      break;
    }
    await cmdRename(oldName, newName);
    break;
  }

  case "list":
    await cmdList();
    break;

  // v2.4.19+ 给现存 active agent 补发置顶 focus 公告（新建/恢复的自动发，这个
  // 是给"feature 上线前就在跑"的老 agent 用的一次性 backfill）
  case "announce-focus": {
    const [nameArg] = args;
    const reg = await loadRegistry();
    const targets = Object.entries(reg.agents).filter(([n, info]) =>
      info.status === "active" && info.channelId &&
      (!nameArg || n === normalizeName(nameArg))
    );
    const results: Record<string, string> = {};
    for (const [n, info] of targets) {
      if (info.focusMsgId) { results[n] = "已有，跳过"; continue; }
      await announceFocusButton(n, info.channelId);
      const after = await loadRegistry();
      results[n] = after.agents[n]?.focusMsgId ? "✅ 已发" : "❌ 失败";
    }
    output({ ok: true, results });
    break;
  }

  case "sessions":
    await cmdSessions(args.join(" ") || undefined);
    break;

  case "restart": {
    const [name] = args;
    await cmdRestart(name || undefined);
    break;
  }

  case "cron-add": {
    const [name, schedule, ...restRaw] = args;
    const rest = [...restRaw];
    // --channel <id>：结果通知发到指定频道（默认 CONTROL_CHANNEL_ID）
    let reportChannelId: string | undefined;
    const chIdx = rest.indexOf("--channel");
    if (chIdx >= 0) {
      reportChannelId = rest[chIdx + 1];
      rest.splice(chIdx, 2);
    }
    // v2.4.18+ --target-agent <name>：把 prompt 打到已存在的 agent（继承上下文/记忆），
    // 不再 spawn 临时 agent。设了这个的话，<dir> 参数可省（agent 有自己的 cwd）。
    let targetAgent: string | undefined;
    const taIdx = rest.indexOf("--target-agent");
    if (taIdx >= 0) {
      targetAgent = rest[taIdx + 1];
      rest.splice(taIdx, 2);
    }
    let dir: string | undefined;
    if (targetAgent) {
      // 有 target-agent 时下一个位置参数只有看着像路径才当 dir，否则并入 prompt
      if (rest.length >= 1 && (rest[0].startsWith("/") || rest[0].startsWith("~") || rest[0].startsWith("."))) {
        dir = rest.shift();
      } else {
        dir = "-"; // 占位，不会被 executeOnExistingAgent 实际使用
      }
    } else {
      dir = rest.shift();
    }
    if (!name || !schedule || !dir || rest.length === 0) {
      output({ ok: false, error: '用法: cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>]\n  --target-agent 设了的话 <dir> 可省' });
      break;
    }
    await cmdCronAdd(name, schedule, dir, rest.join(" "), reportChannelId, targetAgent);
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

  case "peer-expose":
  case "peer-revoke": {
    output({ ok: false, error: "Discord peer 已移除(v2.11)。请用 HTTP peer: peer-http-invite/join/accept/test/list/remove(docs/design-http-peers.md)" });
    break;
  }
  case "peer-expose-removed": {
    const [agent, peer, ...rest] = args;
    if (!agent || !peer) {
      output({ ok: false, error: '用法: peer-expose <agent> <peer-name|peer-id|all> [--purpose "..."] [--mode direct|via_master]' });
      break;
    }
    let purpose = "";
    const pIdx = rest.findIndex((a) => a === "--purpose");
    if (pIdx >= 0 && rest[pIdx + 1]) purpose = rest[pIdx + 1];

    // v1.9.21+: --mode 默认 direct。老用户想保留旧行为可传 --mode via_master
    let mode: "direct" | "via_master" = "direct";
    const mIdx = rest.findIndex((a) => a === "--mode");
    if (mIdx >= 0 && rest[mIdx + 1]) {
      const m = rest[mIdx + 1];
      if (m === "direct" || m === "via_master") mode = m;
      else {
        output({ ok: false, error: `未知 mode "${m}"，支持 direct / via_master` });
        break;
      }
    }
    await cmdPeerExpose(agent, peer, purpose, mode);
    break;
  }

  case "peer-revoke-removed": {
    const [agent, peer] = args;
    if (!agent || !peer) {
      output({ ok: false, error: "用法: peer-revoke <agent> <peer-name|peer-id|all>" });
      break;
    }
    await cmdPeerRevoke(agent, peer);
    break;
  }

  // v2.11+ HTTP peer 握手/管理（docs/design-http-peers.md）
  case "peer-http-invite": {
    const { rest: afterRotateI, value: rotate } = extractBoolFlag(args, "--rotate");
    const { rest: afterForce, value: force } = extractBoolFlag(afterRotateI, "--force");
    let agentsCsv = "", myUrl = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
      else pos.push(a);
    }
    await cmdPeerHttpInvite(pos[0] || "", agentsCsv, myUrl, force, rotate);
    break;
  }
  case "peer-http-join": {
    const { rest: afterRotateJ, value: rotate } = extractBoolFlag(args, "--rotate");
    const { rest: afterForce, value: force } = extractBoolFlag(afterRotateJ, "--force");
    let agentsCsv = "", myUrl = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
      else pos.push(a);
    }
    await cmdPeerHttpJoin(pos[0] || "", pos[1] || "", agentsCsv, myUrl, force, rotate);
    break;
  }
  case "peer-http-accept":
    await cmdPeerHttpAccept(args[0] || "", args[1] || "");
    break;
  case "peer-http-test":
    await cmdPeerHttpTest(args[0] || "");
    break;
  case "peer-http-list":
    await cmdPeerHttpList();
    break;
  case "peer-http-remove":
    await cmdPeerHttpRemove(args[0] || "");
    break;
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

  case "effort": {
    const [sub, ...rest] = args;
    await cmdEffort(sub || "list", ...rest);
    break;
  }

  case "mode": {
    const [sub, ...rest] = args;
    await cmdMode(sub || "list", ...rest);
    break;
  }

  case "model": {
    const [sub, ...rest] = args;
    await cmdModel(sub || "list", ...rest);
    break;
  }

  case "install-cli": {
    // v2.3.0+: 把 `claudestra` 命令装到 PATH + 配 LaunchAgent 开机自启。
    // 给现有装机的人；首次 setup.ts 安装末尾也会跑这同一份逻辑。
    const { installClaudestraCli } = await import("./lib/cli-install.js");
    const REPO = `${import.meta.dir}/..`;
    const result = await installClaudestraCli(REPO);
    if (result.errors.length > 0) {
      output({ ok: false, error: result.errors.join("; "), warnings: result.warnings, result });
    } else {
      output({
        ok: true,
        cliWrapper: result.cliWrapper,
        daemons: result.daemons.map((d) => ({ label: d.label, loaded: d.loaded, warning: d.warning })),
        pm2Stopped: result.pm2Stopped.length > 0 ? result.pm2Stopped : undefined,
        oldAutostartPlist: result.oldAutostartPlist,
        oldPm2StartupPlist: result.oldPm2StartupPlist,
        removedOldAutostartWrapper: result.removedOldAutostartWrapper || undefined,
        migratedHookCommand: result.migratedHookCommand || undefined,
        bumpedTmuxDashboardLimit: result.bumpedTmuxDashboardLimit,
        allowedMcpTools: result.allowedMcpTools,
        warnings: result.warnings,
        hint: "打 `claudestra` 试试 —— launchd 3 个 daemon + 进 master TUI。重启机器后服务也会自动起来。",
      });
    }
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
        "rename <old-name> <new-name>    — 重命名 agent（tmux window + registry + Discord 频道）",
        "restart [name]                  — 重启 agent（不指定则重启所有）",
        "list                            — 列出所有 agent",
        "sessions [search]               — 浏览历史 Claude Code 会话",
        'cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>] — 添加定时任务（--target-agent 让 prompt 打到已存在的 agent、继承其上下文/记忆；不设则每次建临时 agent）',
        "cron-list                       — 列出所有定时任务",
        "cron-remove <name|id>           — 删除定时任务",
        "cron-toggle <name|id>           — 启用/暂停定时任务",
        "cron-history [name|id]          — 查看执行历史",
        "permissions list                — 列出所有 agent 的权限预设",
        "permissions presets             — 列出所有可用预设",
        "permissions get <name>          — 查看单个 agent 的详细权限",
        'permissions set <name> --preset <preset>｜--disallowed "..."',
        "permissions reset <name>        — 恢复默认预设",
        "effort list                     — 列出所有 agent 的 effort 设置",
        "effort get <name>               — 查看单个 agent 的 effort",
        "effort <name> <low|medium|high|xhigh|max|auto>  — 设置 agent 的 effort（要 restart 生效）",
        "effort reset <name>             — 清除 agent effort 覆盖（回到 settings.json 全局）",
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
