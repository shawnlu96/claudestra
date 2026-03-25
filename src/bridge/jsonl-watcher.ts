/**
 * JSONL Session File Watcher
 *
 * 监听 Claude Code 的 JSONL session 文件，实时提取 tool use 过程推送到 Discord。
 * 作为 Channel reply 的补充——Claude 的正式回复走 reply tool，
 * 中间过程（tool 调用、执行结果）走 JSONL 监听。
 */

import { watch, type FSWatcher } from "fs";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";

interface WatcherState {
  watcher: FSWatcher;
  lastSize: number;
  channelId: string;
  jsonlPath: string;
}

const watchers = new Map<string, WatcherState>();

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

/** 格式化 tool use 为简短摘要 */
function formatToolSummary(name: string, input: any): string {
  const EMOJI: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "💻",
    Glob: "🔍", Grep: "🔎", Agent: "🤖", WebSearch: "🌐",
  };
  const emoji = EMOJI[name] || "🔧";

  switch (name) {
    case "Read":
      return `${emoji} Read \`${input?.file_path?.split("/").pop() || ""}\``;
    case "Edit":
      return `${emoji} Edit \`${input?.file_path?.split("/").pop() || ""}\``;
    case "Write":
      return `${emoji} Write \`${input?.file_path?.split("/").pop() || ""}\``;
    case "Bash": {
      const cmd = input?.command || "";
      return `${emoji} \`${cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd}\``;
    }
    case "Glob":
      return `${emoji} Glob \`${input?.pattern || ""}\``;
    case "Grep":
      return `${emoji} Grep \`${input?.pattern || ""}\``;
    default:
      return `${emoji} ${name}`;
  }
}

/** 开始监听一个 agent 的 JSONL 文件 */
export async function startWatching(
  workerName: string,
  cwd: string,
  sessionId: string,
  channelId: string,
  discord: Client
) {
  // 停止旧的 watcher
  stopWatching(workerName);

  const jsonlPath = getJsonlPath(cwd, sessionId);
  if (!existsSync(jsonlPath)) {
    console.log(`⚠️ JSONL 不存在: ${jsonlPath}`);
    return;
  }

  const fileStat = await stat(jsonlPath);
  let lastSize = fileStat.size;

  const watcher = watch(jsonlPath, async (eventType) => {
    if (eventType !== "change") return;

    try {
      const newStat = await stat(jsonlPath);
      if (newStat.size <= lastSize) return;

      // 读取新增部分
      const fd = Bun.file(jsonlPath);
      const newData = await fd.slice(lastSize, newStat.size).text();
      lastSize = newStat.size;

      // 解析新行
      const lines = newData.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          await handleEntry(entry, channelId, discord);
        } catch { /* non-critical: malformed JSON line */ }
      }
    } catch { /* non-critical: file read error */ }
  });

  watchers.set(workerName, { watcher, lastSize, channelId, jsonlPath });
  console.log(`👁 开始监听: ${workerName} → ${jsonlPath}`);
}

/** 停止监听 */
export function stopWatching(workerName: string) {
  const state = watchers.get(workerName);
  if (state) {
    state.watcher.close();
    watchers.delete(workerName);
  }
}

/** 处理一条 JSONL entry */
async function handleEntry(
  entry: any,
  channelId: string,
  discord: Client
) {
  // 只处理 assistant 消息中的 tool_use
  if (entry.type !== "assistant") return;

  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  const toolSummaries: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      // 跳过 reply/react/edit_message/fetch_messages（这些是 Discord 操作，不需要展示）
      if (["reply", "react", "edit_message", "fetch_messages", "download_attachment"].includes(block.name)) {
        continue;
      }
      toolSummaries.push(formatToolSummary(block.name, block.input));
    }
  }

  if (toolSummaries.length === 0) return;

  // 发到 Discord（灰色小字，不打扰）
  try {
    const channel = await discord.channels.fetch(channelId);
    if (channel && "send" in channel) {
      const text = toolSummaries.join("\n");
      await (channel as TextChannel).send({
        content: `> ${text.replace(/\n/g, "\n> ")}`,
      });
    }
  } catch { /* non-critical */ }
}

/** 获取所有活跃的 watcher 名 */
export function getActiveWatchers(): string[] {
  return [...watchers.keys()];
}
