/**
 * JSONL Session File Watcher
 *
 * 监听 Claude Code 的 JSONL session 文件，实时提取 tool use 过程推送到 Discord。
 * 批量合并连续 tool calls，避免刷屏。
 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import { TMUX_SOCK, WATCHER_CONFIG } from "./config.js";
import { typingIntervals } from "./components.js";

interface WatcherState {
  watcher: FSWatcher;
  lastSize: number;
  channelId: string;
  jsonlPath: string;
  workerName: string;
  pendingItems: string[];  // 待发送的所有项（tool use + text + tool result）
  flushTimer: ReturnType<typeof setTimeout> | null;
  idleChecker: ReturnType<typeof setInterval> | null;
  activeTools: Map<string, string>; // tool_use_id → summary
  toolMsgIds: Map<string, string>; // tool_use_id → Discord message ID（用于 edit）
  lastToolMsgId: string | null; // 最后一条 tool 状态消息的 Discord ID
  lastToolMsgContent: string; // 最后一条 tool 状态消息的内容
  hasSeenActivity: boolean;
  lastActivityAt: number; // 最后一次活动的时间戳
  onIdle?: () => void;
}

const watchers = new Map<string, WatcherState>();

// MCP 和 Discord 相关的 tool，不展示
const HIDDEN_TOOLS = new Set([
  "reply", "react", "edit_message", "fetch_messages", "download_attachment",
  // MCP 工具前缀
]);

function isHiddenTool(name: string): boolean {
  if (HIDDEN_TOOLS.has(name)) return true;
  // 过滤所有 mcp__ 前缀的工具（MCP server 调用）
  if (name.startsWith("mcp__")) return true;
  return false;
}

function cwdToProjectDir(cwd: string): string {
  return "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
}

function getJsonlPath(cwd: string, sessionId: string): string {
  const projectDir = cwdToProjectDir(cwd);
  return join(
    process.env.HOME || "~",
    ".claude",
    "projects",
    projectDir,
    `${sessionId}.jsonl`
  );
}

function formatToolSummary(name: string, input: any): string {
  const EMOJI: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "💻",
    Glob: "🔍", Grep: "🔎", Agent: "🤖", WebSearch: "🌐",
    WebFetch: "🌐", Skill: "⚡",
  };
  const emoji = EMOJI[name] || "🔧";

  switch (name) {
    case "Read":
      return `${emoji} Read ${input?.file_path?.split("/").pop() || ""}`;
    case "Edit":
      return `${emoji} Edit ${input?.file_path?.split("/").pop() || ""}`;
    case "Write":
      return `${emoji} Write ${input?.file_path?.split("/").pop() || ""}`;
    case "Bash": {
      const cmd = (input?.command || "").replace(/\n/g, " ").trim();
      if (input?.description) {
        // 描述 + spoiler 隐藏完整命令
        return `${emoji} ${input.description} ||${cmd.slice(0, 200)}||`;
      }
      return `${emoji} ${cmd.split("&&")[0].trim()}`;
    }
    case "Glob":
      return `${emoji} Glob ${input?.pattern || ""}`;
    case "Grep":
      return `${emoji} Grep ${input?.pattern || ""}`;
    default:
      return `${emoji} ${name}`;
  }
}

/** 发送积攒的项到 Discord，记录消息 ID 用于后续 edit */
async function flushPending(state: WatcherState, discord: Client) {
  if (state.pendingItems.length === 0) return;

  const items = state.pendingItems.splice(0);
  const formatted = items.map((t) => `-# ${t}`).join("\n");

  try {
    const channel = await discord.channels.fetch(state.channelId);
    if (!channel || !("send" in channel)) return;
    const tc = channel as TextChannel;

    // 如果有上一条 tool 消息且内容可以追加，edit 它
    if (state.lastToolMsgId) {
      try {
        const msg = await tc.messages.fetch(state.lastToolMsgId);
        const newContent = state.lastToolMsgContent + "\n" + formatted;
        if (newContent.length < 1900) {
          await msg.edit(newContent);
          state.lastToolMsgContent = newContent;
          return;
        }
      } catch { /* non-critical: msg deleted or too old */ }
    }

    // 发新消息
    const sent = await tc.send(formatted);
    state.lastToolMsgId = sent.id;
    state.lastToolMsgContent = formatted;
  } catch { /* non-critical */ }
}

/** tool 完成时：先改 pending 队列，如果已发出则 edit 消息 */
async function markToolComplete(
  state: WatcherState,
  discord: Client,
  toolId: string,
  isError: boolean
) {
  const summary = state.activeTools.get(toolId);
  if (!summary) return;
  state.activeTools.delete(toolId);

  const icon = isError ? "❌" : "✅";

  // 先看 pending 队列里有没有（还没 flush 到 Discord）
  const pendingIdx = state.pendingItems.findIndex((t) => t === `⏳ ${summary}`);
  if (pendingIdx >= 0) {
    state.pendingItems[pendingIdx] = `${icon} ${summary}`;
    return;
  }

  // 已经发出到 Discord → edit 消息
  if (!state.lastToolMsgId) return;

  try {
    const channel = await discord.channels.fetch(state.channelId);
    if (!channel || !("messages" in channel)) return;
    const msg = await (channel as TextChannel).messages.fetch(state.lastToolMsgId);

    const oldLine = `-# ⏳ ${summary}`;
    const newLine = `-# ${icon} ${summary}`;
    const updated = state.lastToolMsgContent.replace(oldLine, newLine);

    if (updated !== state.lastToolMsgContent) {
      await msg.edit(updated);
      state.lastToolMsgContent = updated;
    }
  } catch { /* non-critical */ }
}

async function checkTmuxIdle(workerName: string): Promise<boolean> {
  const target = `master:${workerName}`;
  const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "capture-pane", "-t", target, "-p"], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return /❯/.test(out.split("\n").slice(-5).join("\n"));
}

/** 开始监听一个 agent 的 JSONL 文件 */
export async function startWatching(
  workerName: string,
  cwd: string,
  sessionId: string,
  channelId: string,
  discord: Client,
  onIdle?: () => void
) {
  stopWatching(workerName);

  const jsonlPath = getJsonlPath(cwd, sessionId);
  if (!existsSync(jsonlPath)) {
    console.log(`⚠️ JSONL 不存在: ${jsonlPath}`);
    return;
  }

  const fileStat = await stat(jsonlPath);

  const state: WatcherState = {
    watcher: null as any,
    lastSize: fileStat.size,
    channelId,
    jsonlPath,
    workerName,
    pendingItems: [],
    flushTimer: null,
    idleChecker: null,
    activeTools: new Map(),
    toolMsgIds: new Map(),
    lastToolMsgId: null,
    lastToolMsgContent: "",
    hasSeenActivity: false,
    lastActivityAt: 0,
    onIdle,
  };

  state.watcher = watch(jsonlPath, async (eventType) => {
    if (eventType !== "change") return;

    try {
      const newStat = await stat(jsonlPath);
      if (newStat.size <= state.lastSize) return;

      const fd = Bun.file(jsonlPath);
      const newData = await fd.slice(state.lastSize, newStat.size).text();
      state.lastSize = newStat.size;

      const lines = newData.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // 只有 assistant entry 才标记 Claude 开始工作
          if (entry.type === "assistant") {
            state.hasSeenActivity = true;
            state.lastActivityAt = Date.now();
          }

          // assistant 消息：text blocks + tool_use blocks
          if (entry.type === "assistant") {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;

            // 检查这条消息是否包含 reply tool（如果是，text 是回复内容，不重复显示）
            const hasReplyTool = content.some(
              (b: any) => b.type === "tool_use" && isHiddenTool(b.name)
            );

            for (const block of content) {
              // Claude 说的话（非 reply 前缀）
              if (block.type === "text" && block.text?.trim() && WATCHER_CONFIG.showClaudeText && !hasReplyTool) {
                const text = block.text.trim();
                if (text.length > 3 && text.length < 500) {
                  state.pendingItems.push(`💬 ${text.slice(0, 150)}`);
                }
              }
              // Tool use 开始
              if (block.type === "tool_use" && block.name && !isHiddenTool(block.name) && WATCHER_CONFIG.showToolUse) {
                const summary = formatToolSummary(block.name, block.input);
                state.pendingItems.push(`⏳ ${summary}`);
                if (block.id) state.activeTools.set(block.id, summary);
              }
            }
          }

          // tool_result：edit 消息标记完成
          if (entry.type === "user" && WATCHER_CONFIG.showToolResult) {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                await markToolComplete(state, discord, block.tool_use_id, !!block.is_error);
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // Debounce
      if (state.pendingItems.length > 0) {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(() => flushPending(state, discord), WATCHER_CONFIG.debounceMs);
      }
    } catch { /* non-critical */ }
  });

  // 定期检查 tmux idle 状态（每 3 秒）
  // 只有 JSONL 检测到 Claude 开始工作后才检查 idle
  state.idleChecker = setInterval(async () => {
    // 没有在 typing → 重置状态
    if (!typingIntervals.has(state.channelId)) {
      state.hasSeenActivity = false;
      state.lastToolMsgId = null;
      state.lastToolMsgContent = "";
      state.activeTools.clear();
      return;
    }
    // Claude 还没开始工作 → 不检查（避免误判）
    if (!state.hasSeenActivity) return;
    // 最后一次活动后 10 秒内不检查（Claude 可能在两步之间短暂空闲）
    if (Date.now() - state.lastActivityAt < 10000) return;
    try {
      const idle = await checkTmuxIdle(workerName);
      if (idle && state.onIdle) {
        state.hasSeenActivity = false;
        state.onIdle();
      }
    } catch { /* non-critical */ }
  }, 3000);

  watchers.set(workerName, state);
  console.log(`👁 开始监听: ${workerName} → ${jsonlPath}`);
}

/** 停止监听 */
export function stopWatching(workerName: string) {
  const state = watchers.get(workerName);
  if (state) {
    state.watcher.close();
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (state.idleChecker) clearInterval(state.idleChecker);
    watchers.delete(workerName);
  }
}

/** 标记某个频道有活动（由 bridge reply handler 调用） */
export function markChannelActivity(channelId: string) {
  for (const state of watchers.values()) {
    if (state.channelId === channelId) {
      state.hasSeenActivity = true;
      state.lastActivityAt = Date.now();
    }
  }
}

/** 获取所有活跃的 watcher 名 */
export function getActiveWatchers(): string[] {
  return [...watchers.keys()];
}
