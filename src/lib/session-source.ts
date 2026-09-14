/**
 * 会话记录的统一入口（runtime 感知）—— v2.23+。
 *
 * 全系统有五个地方在读 agent 的会话 jsonl：jsonl-watcher（流式喂 Discord/web）、
 * session-history（历史面板）、session-archive（退役快照）、jsonl-cost / agent-stats
 * （用量）、bridge 的「忘了 reply 就兜底抽正文」。它们原先都写死 Claude Code 的
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` 与行格式。
 *
 * 这里只提供两个纯函数（定位 + 逐行翻译），调用方按 runtime 走：
 *   - Claude Code：路径可预测、行就是最终形状 → 原样返回
 *   - Pi：文件名带时间戳前缀，**只能扫目录**（所以 locate 可能返回 null，要轮询）；
 *     行要翻译成 Claude Code 形状，下游五个消费者一行都不用改
 *
 * 为什么不把翻译做进各个消费者：五个消费者里有一堆与格式无关的逻辑（去抖、分组、
 * 归档语义、成本归并），把它们改成中立的中间层是大手术；而 Pi 的行 → CC 形状是纯
 * 函数、可单测。哪天中间层出现，删掉这里的 translate 即可。
 */

import { agentRuntime } from "./registry.js";
import { findJsonlBySessionId, projectJsonlPath, projectsDir } from "./jsonl-cost.js";
import {
  findPiSessionBySessionId,
  piAgentDir,
  listPiSessionJsonls,
  piLineToClaudeShape,
  piSessionPath,
} from "./pi-session.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

type AnyRecord = Record<string, any>;

/** 定位 agent 当前会话的记录文件。找不到返回 null（Pi 的文件名带时间戳，只能扫目录） */
export function sessionJsonlPath(
  runtime: string | undefined,
  cwd: string,
  sessionId: string,
): string | null {
  if (agentRuntime({ runtime }) === "pi") return piSessionPath(cwd, sessionId);
  return projectJsonlPath(cwd, sessionId);
}

/** 全库兜底查找（cwd 记错或路径推断失准时用） */
export function findSessionJsonlBySessionId(runtime: string | undefined, sessionId: string): string | null {
  if (agentRuntime({ runtime }) === "pi") return findPiSessionBySessionId(sessionId);
  return findJsonlBySessionId(sessionId);
}

/** 列出某工作目录下的会话文件（fork 前后 diff、归档扫描用） */
export function listSessionJsonls(runtime: string | undefined, cwd: string): string[] {
  if (agentRuntime({ runtime }) === "pi") return listPiSessionJsonls(cwd);
  return listJsonlsInClaudeProjects(cwd);
}

/**
 * 从**已知的会话文件路径**反推 runtime。
 *
 * 为什么要这个：解析侧（历史面板 / 用量 / 归档 / 会话尾巴 / cron 摘要 / reply 兜底）
 * 拿到的都是一个路径，把 runtime 从 manager 一路透传到这几层要改六处签名；而 Pi 的
 * 会话根目录是固定的（`~/.pi/agent/sessions/`），路径本身就是充分判据。
 * 注意：**定位**（cwd+sessionId → 路径）仍然必须显式给 runtime —— 那个方向推不出来。
 */
export function runtimeForSessionPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  return path.includes(`${piAgentDir()}/sessions/`) ? "pi" : undefined;
}

/** 一行原文 → Claude Code 形状的 entry（读不了/不是对话行返回 null） */
export function translateSessionLine(runtime: string | undefined, line: string): AnyRecord | null {
  if (agentRuntime({ runtime }) === "pi") return piLineToClaudeShape(line);
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as AnyRecord) : null;
  } catch {
    return null;
  }
}

/** Claude Code 侧的目录列举 */
function listJsonlsInClaudeProjects(cwd: string): string[] {
  const dir = projectsDir(cwd);
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}
