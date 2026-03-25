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
  activeTools: Map<string, string>; // tool_use_id → summary（跟踪运行中的 tool）
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

/** 发送积攒的项到 Discord */
async function flushPending(state: WatcherState, discord: Client) {
  if (state.pendingItems.length === 0) return;

  const items = state.pendingItems.splice(0);

  try {
    const channel = await discord.channels.fetch(state.channelId);
    if (channel && "send" in channel) {
      const formatted = items.map((t) => `-# ${t}`).join("\n");
      await (channel as TextChannel).send(formatted);
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

          // tool_result：标记工具完成
          if (entry.type === "user" && WATCHER_CONFIG.showToolResult) {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const summary = state.activeTools.get(block.tool_use_id);
                if (summary) {
                  state.activeTools.delete(block.tool_use_id);
                  const isError = block.is_error;
                  state.pendingItems.push(`${isError ? "❌" : "✅"} ${summary}`);
                }
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
  // 记录 typing 开始时间，前 8 秒不检查（给 Claude 启动时间）
  let typingStartedAt = 0;
  state.idleChecker = setInterval(async () => {
    if (!typingIntervals.has(state.channelId)) {
      typingStartedAt = 0;
      return;
    }
    // 记录 typing 开始时间
    if (typingStartedAt === 0) typingStartedAt = Date.now();
    if (Date.now() - typingStartedAt < WATCHER_CONFIG.idleGracePeriodMs) return;
    try {
      const idle = await checkTmuxIdle(workerName);
      if (idle && state.onIdle) state.onIdle();
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

/** 获取所有活跃的 watcher 名 */
export function getActiveWatchers(): string[] {
  return [...watchers.keys()];
}
