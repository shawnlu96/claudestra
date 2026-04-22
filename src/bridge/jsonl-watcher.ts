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
import { WATCHER_CONFIG, MCP_TOOL_PREFIX } from "./config.js";

interface ToolEntry {
  id: string;
  summary: string;
  done: boolean;
  error: boolean;
}

interface WatcherState {
  watcher: FSWatcher;
  jsonlPath: string;
  lastSize: number;
  channelId: string;
  tools: ToolEntry[];
  toolMsgId: string | null;
  textQueue: string[];
  textTimer: ReturnType<typeof setTimeout> | null;
  agentName: string;
  /** 并发锁：processNewData 同时只能跑一份 */
  processing: boolean;
  /** 2s poll 兜底的 interval handle */
  pollInterval: ReturnType<typeof setInterval> | null;
}

const watchers = new Map<string, WatcherState>();

const HIDDEN_TOOLS = new Set([
  "reply", "react", "edit_message", "fetch_messages", "download_attachment",
]);

function isHiddenTool(name: string): boolean {
  if (HIDDEN_TOOLS.has(name)) return true;
  // 只隐藏 Discord 通信相关的 MCP 工具
  if (name.startsWith(MCP_TOOL_PREFIX)) return true;
  if (name.startsWith("mcp__plugin_discord_discord__")) return true;
  return false;
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
    default: {
      // mcp__server__tool → server/tool
      const short = name.startsWith("mcp__") ? name.replace("mcp__", "").replace("__", "/") : name;
      return `${e} ${short}`;
    }
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
    // 每条文本加 -# 前缀，拼接后按 1900 字符分块发送
    let buf = "";
    for (const item of items) {
      const line = `-# ${item}`;
      if (buf.length + line.length + 1 > 1900) {
        if (buf) await ch.send(buf);
        buf = line;
      } else {
        buf = buf ? buf + "\n" + line : line;
      }
    }
    if (buf) await ch.send(buf);
    state.toolMsgId = null;
    state.tools = state.tools.filter(t => !t.done);
  } catch { /* non-critical */ }
}

function getJsonlPath(cwd: string, sessionId: string): string {
  const dir = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  return join(process.env.HOME || "~", ".claude", "projects", dir, `${sessionId}.jsonl`);
}

/**
 * 处理 jsonl 新增数据：读新字节、解析 entry、推 tool/text 到队列。
 * 并发时以 state.processing 作锁。hoist 到模块级，Stop hook 也能直接调来"强制
 * 吃完 jsonl 再 flush"（见 drainChannelWatcher）。
 */
async function processNewData(state: WatcherState, discord: Client): Promise<void> {
  if (state.processing) return;
  state.processing = true;
  try {
    const newStat = await stat(state.jsonlPath);
    if (newStat.size <= state.lastSize) return;
    const newData = await Bun.file(state.jsonlPath).slice(state.lastSize, newStat.size).text();
    state.lastSize = newStat.size;

    let toolsChanged = false;

    for (const line of newData.split("\n").filter((l) => l.trim())) {
      try {
        const entry = JSON.parse(line);

        // 显示思考时长（仅展示，不用于完成判断）
        if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
          const secs = (entry.durationMs / 1000).toFixed(0);
          state.textQueue.push(`⏱ 尼了 ${secs} 秒`);
        }

        if (entry.type === "assistant") {
          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;
          const hasReply = content.some((b: any) => b.type === "tool_use" && isHiddenTool(b.name));
          const hasNewTools = content.some((b: any) => b.type === "tool_use" && b.name && !isHiddenTool(b.name));

          // 新一批 tool 到来 → 清空旧 tools，每轮独立一条 Discord 消息
          if (hasNewTools) {
            state.tools = [];
            state.toolMsgId = null;
          }

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
              if (t.length > 3) {
                state.textQueue.push(`💬 ${t}`);
              }
            }
          }
        }

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

    if (toolsChanged) {
      if (state.textQueue.length > 0) {
        if (state.textTimer) { clearTimeout(state.textTimer); state.textTimer = null; }
        await flushText(state, discord);
      }
      await syncToolMsg(state, discord);
    }

    if (state.textQueue.length > 0) {
      if (state.textTimer) clearTimeout(state.textTimer);
      state.textTimer = setTimeout(() => flushText(state, discord), WATCHER_CONFIG.debounceMs);
    }
  } catch { /* non-critical */ }
  finally { state.processing = false; }
}

/**
 * Stop hook 触发时同步 drain 一个 channel 的 watcher：
 * - 立刻读一次 jsonl 到最新（即便 fs.watch / 2s poll 都还没 fire）
 * - 取消 pending 的 debounce timer
 * - 立刻 flush textQueue 到 Discord
 *
 * 这样 turn 结束的"快速一句话"场景不会因为 watcher debounce 1.5s 还没过就被
 * Stop 吞掉，同时也不需要 rescue 做第二遍代发。
 */
export async function drainChannelWatcher(channelId: string, discord: Client): Promise<boolean> {
  for (const state of watchers.values()) {
    if (state.channelId !== channelId) continue;
    try {
      await processNewData(state, discord);
    } catch { /* non-critical */ }
    if (state.textTimer) {
      clearTimeout(state.textTimer);
      state.textTimer = null;
    }
    if (state.textQueue.length > 0) {
      try { await flushText(state, discord); } catch { /* non-critical */ }
    }
    return true;
  }
  return false;
}

export async function startWatching(
  agentName: string, cwd: string, sessionId: string,
  channelId: string, discord: Client
) {
  stopWatching(agentName);
  const jsonlPath = getJsonlPath(cwd, sessionId);
  if (!existsSync(jsonlPath)) return;

  const fileStat = await stat(jsonlPath);
  const state: WatcherState = {
    watcher: null as any,
    jsonlPath,
    lastSize: fileStat.size,
    channelId,
    tools: [],
    toolMsgId: null,
    textQueue: [],
    textTimer: null,
    agentName,
    processing: false,
    pollInterval: null,
  };

  // fs.watch 主监听
  state.watcher = watch(jsonlPath, (eventType) => {
    if (eventType === "change") processNewData(state, discord);
  });

  // 2 秒轮询兜底（macOS fs.watch 偶尔丢事件）
  const pollInterval = setInterval(() => processNewData(state, discord), 2000);
  state.pollInterval = pollInterval;

  // 空闲检测由 Claude Code hooks (Stop/Notification) 处理，不再用 tmux 屏幕比较

  watchers.set(agentName, state);
  console.log(`👁 开始监听: ${agentName} → ${jsonlPath}`);
}

export function stopWatching(agentName: string) {
  const state = watchers.get(agentName);
  if (state) {
    state.watcher.close();
    if (state.textTimer) clearTimeout(state.textTimer);
    if (state.pollInterval) clearInterval(state.pollInterval);
    watchers.delete(agentName);
  }
}

/** 根据 channelId 查找并停止 watcher（websocket 断开时兜底用） */
export function stopWatchingByChannel(channelId: string): boolean {
  for (const [agentName, state] of watchers.entries()) {
    if (state.channelId === channelId) {
      stopWatching(agentName);
      return true;
    }
  }
  return false;
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
