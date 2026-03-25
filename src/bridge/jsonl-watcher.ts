/**
 * JSONL Session File Watcher
 *
 * 监听 Claude Code 的 JSONL session 文件，tool use 和 Claude 文本实时推送到 Discord。
 * 简单设计：只显示，不追踪状态。
 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import { WATCHER_CONFIG } from "./config.js";

interface WatcherState {
  watcher: FSWatcher;
  lastSize: number;
  channelId: string;
  pending: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
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

async function flush(state: WatcherState, discord: Client) {
  if (state.pending.length === 0) return;
  const items = state.pending.splice(0);
  try {
    const ch = await discord.channels.fetch(state.channelId);
    if (ch && "send" in ch) {
      await (ch as TextChannel).send(items.map((t) => `-# ${t}`).join("\n"));
    }
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
    pending: [],
    flushTimer: null,
  };

  state.watcher = watch(jsonlPath, async (eventType) => {
    if (eventType !== "change") return;
    try {
      const newStat = await stat(jsonlPath);
      if (newStat.size <= state.lastSize) return;
      const newData = await Bun.file(jsonlPath).slice(state.lastSize, newStat.size).text();
      state.lastSize = newStat.size;

      for (const line of newData.split("\n").filter((l) => l.trim())) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "assistant") continue;
          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;

          const hasReply = content.some((b: any) => b.type === "tool_use" && isHiddenTool(b.name));

          for (const block of content) {
            if (block.type === "tool_use" && block.name && !isHiddenTool(block.name) && WATCHER_CONFIG.showToolUse) {
              state.pending.push(formatTool(block.name, block.input));
            }
            if (block.type === "text" && block.text?.trim() && WATCHER_CONFIG.showClaudeText && !hasReply) {
              const t = block.text.trim();
              if (t.length > 3 && t.length < 500) {
                state.pending.push(`💬 ${t.slice(0, 150)}`);
              }
            }
          }
        } catch { /* non-critical */ }
      }

      if (state.pending.length > 0) {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(() => flush(state, discord), WATCHER_CONFIG.debounceMs);
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
    if (state.flushTimer) clearTimeout(state.flushTimer);
    watchers.delete(workerName);
  }
}
