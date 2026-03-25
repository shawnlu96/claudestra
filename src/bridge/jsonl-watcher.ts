/**
 * JSONL Session File Watcher
 *
 * 监听 Claude Code 的 JSONL session 文件。
 * Tool use 实时推送到 Discord，一条消息持续 edit 更新状态。
 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import { WATCHER_CONFIG } from "./config.js";

interface ToolEntry {
  id: string;
  summary: string;
  done: boolean;
  error: boolean;
}

interface WatcherState {
  watcher: FSWatcher;
  lastSize: number;
  channelId: string;
  tools: ToolEntry[];
  toolMsgId: string | null; // 当前 tool 消息的 Discord ID
  textQueue: string[];      // Claude 说的话（debounce 后发）
  textTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, WatcherState>();

const HIDDEN_TOOLS = new Set([
  "reply", "react", "edit_message", "fetch_messages", "download_attachment",
]);

function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name) || name.startsWith("mcp__");
}

function formatTool(name: string, input: any): string {
  const E: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "💻",
    Glob: "🔍", Grep: "🔎", Agent: "🤖", WebSearch: "🌐",
  };
  const e = E[name] || "🔧";
  switch (name) {
    case "Read": return `${e} Read ${input?.file_path?.split("/").pop() || ""}`;
    case "Edit": return `${e} Edit ${input?.file_path?.split("/").pop() || ""}`;
    case "Write": return `${e} Write ${input?.file_path?.split("/").pop() || ""}`;
    case "Bash":
      if (input?.description) return `${e} ${input.description} ||${(input?.command || "").replace(/\n/g, " ").slice(0, 200)}||`;
      return `${e} ${(input?.command || "").split("\n")[0].split("&&")[0].trim()}`;
    case "Glob": return `${e} Glob ${input?.pattern || ""}`;
    case "Grep": return `${e} Grep ${input?.pattern || ""}`;
    default: return `${e} ${name}`;
  }
}

/** 渲染 tool 列表为 Discord 消息 */
function renderToolMsg(tools: ToolEntry[]): string {
  return tools.map((t) => {
    const icon = t.done ? (t.error ? "❌" : "✅") : "⏳";
    return `-# ${icon} ${t.summary}`;
  }).join("\n");
}

/** 发送或编辑 tool 消息 */
async function syncToolMsg(state: WatcherState, discord: Client) {
  if (state.tools.length === 0) return;
  const content = renderToolMsg(state.tools);

  try {
    const ch = await discord.channels.fetch(state.channelId) as TextChannel;
    if (state.toolMsgId) {
      // edit 已有消息
      const msg = await ch.messages.fetch(state.toolMsgId);
      await msg.edit(content);
    } else {
      // 发新消息
      const msg = await ch.send(content);
      state.toolMsgId = msg.id;
    }
  } catch { /* non-critical */ }
}

/** 发 Claude 的文本 */
async function flushText(state: WatcherState, discord: Client) {
  if (state.textQueue.length === 0) return;
  const items = state.textQueue.splice(0);
  try {
    const ch = await discord.channels.fetch(state.channelId) as TextChannel;
    await ch.send(items.map((t) => `-# ${t}`).join("\n"));
  } catch { /* non-critical */ }
}

function getJsonlPath(cwd: string, sessionId: string): string {
  const dir = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  return join(process.env.HOME || "~", ".claude", "projects", dir, `${sessionId}.jsonl`);
}

export async function startWatching(
  workerName: string, cwd: string, sessionId: string,
  channelId: string, discord: Client
) {
  stopWatching(workerName);
  const jsonlPath = getJsonlPath(cwd, sessionId);
  if (!existsSync(jsonlPath)) return;

  const fileStat = await stat(jsonlPath);
  const state: WatcherState = {
    watcher: null as any,
    lastSize: fileStat.size,
    channelId,
    tools: [],
    toolMsgId: null,
    textQueue: [],
    textTimer: null,
  };

  state.watcher = watch(jsonlPath, async (eventType) => {
    if (eventType !== "change") return;
    try {
      const newStat = await stat(jsonlPath);
      if (newStat.size <= state.lastSize) return;
      const newData = await Bun.file(jsonlPath).slice(state.lastSize, newStat.size).text();
      state.lastSize = newStat.size;

      let toolsChanged = false;

      for (const line of newData.split("\n").filter((l) => l.trim())) {
        try {
          const entry = JSON.parse(line);

          // assistant 消息：tool_use + text
          if (entry.type === "assistant") {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            const hasReply = content.some((b: any) => b.type === "tool_use" && isHiddenTool(b.name));

            for (const block of content) {
              if (block.type === "tool_use" && block.name && !isHiddenTool(block.name) && WATCHER_CONFIG.showToolUse) {
                state.tools.push({
                  id: block.id,
                  summary: formatTool(block.name, block.input),
                  done: false,
                  error: false,
                });
                toolsChanged = true;
              }
              if (block.type === "text" && block.text?.trim() && WATCHER_CONFIG.showClaudeText && !hasReply) {
                const t = block.text.trim();
                if (t.length > 3 && t.length < 500) {
                  state.textQueue.push(`💬 ${t.slice(0, 150)}`);
                }
              }
            }
          }

          // tool_result
          if (entry.type === "user") {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const tool = state.tools.find((t) => t.id === block.tool_use_id);
                if (tool && !tool.done) {
                  tool.done = true;
                  tool.error = !!block.is_error;
                  toolsChanged = true;
                }
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // tool 有变化 → 立即同步到 Discord
      if (toolsChanged) {
        await syncToolMsg(state, discord);
      }

      // text 用 debounce
      if (state.textQueue.length > 0) {
        if (state.textTimer) clearTimeout(state.textTimer);
        state.textTimer = setTimeout(() => flushText(state, discord), WATCHER_CONFIG.debounceMs);
      }
    } catch { /* non-critical */ }
  });

  watchers.set(workerName, state);
  console.log(`👁 开始监听: ${workerName} → ${jsonlPath}`);
}

export function stopWatching(workerName: string) {
  const state = watchers.get(workerName);
  if (state) {
    state.watcher.close();
    if (state.textTimer) clearTimeout(state.textTimer);
    watchers.delete(workerName);
  }
}

/** 重置 tool 追踪（新一轮对话开始时调用） */
export function resetToolTracking(channelId: string) {
  for (const state of watchers.values()) {
    if (state.channelId === channelId) {
      state.tools = [];
      state.toolMsgId = null;
    }
  }
}
