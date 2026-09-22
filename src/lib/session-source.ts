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
import { codexLineToClaudeShape, codexSessionsRoot, findCodexSessionPath, isCodexSessionPath } from "./codex-session.js";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
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
  if (runtime === "codex") return findCodexSessionPath(sessionId);
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
 * 拿到的都是一个路径，把 runtime 从 manager 一路透传到这几层要改六处签名。
 *
 * 判据分两层：
 *   1. 活会话：Pi 的根目录固定（`~/.pi/agent/sessions/`）⇒ 路径即判据；
 *      Claude Code 的根目录也固定（`~/.claude/projects/`）⇒ 直接判 undefined，零 I/O。
 *   2. **归档副本**（`~/.claude-orchestrator/archive/<agent>/`、`archived/`、`unmanaged/`）
 *      路径里两个根都没有 —— 原版只看路径，归档后的 Pi 会话被当成 Claude Code 行解析，
 *      一条都认不出来 → 历史面板永远为空（review #10 阻塞项）。这里改为读**头行**：
 *      Pi 的第一行固定是 `{type:"session", version:N, …}`，Claude Code 从不写这种行。
 *      按路径缓存（同一路径 runtime 不会变；归档 copy-if-larger 只会追加）。
 * 注意：**定位**（cwd+sessionId → 路径）仍然必须显式给 runtime —— 那个方向推不出来。
 */
export function runtimeForSessionPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  if (path.includes(`${piAgentDir()}/sessions/`)) return "pi";
  if (isCodexSessionPath(path)) return "codex";
  if (path.startsWith(CLAUDE_PROJECTS_ROOT)) return undefined;
  return sniffRuntimeFromHead(path);
}

const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects") + "/";
const headSniffCache = new Map<string, string | undefined>();

/** 读文件头 512 字节，Pi 的 header 行 ⇒ "pi"；其余（含读不了）⇒ undefined。结果按路径缓存。 */
function sniffRuntimeFromHead(path: string): string | undefined {
  if (headSniffCache.has(path)) return headSniffCache.get(path);
  let runtime: string | undefined;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    let n = 0;
    try { n = readSync(fd, buf, 0, 512, 0); } finally { closeSync(fd); }
    const first = buf.toString("utf8", 0, n).split("\n")[0];
    const rec = JSON.parse(first);
    if (rec && rec.type === "session" && typeof rec.version === "number") runtime = "pi";
    // 归档副本的路径不带任何根的特征，只能靠头行：Codex 的第一行恒为 session_meta
    else if (rec && rec.type === "session_meta") runtime = "codex";
  } catch {
    runtime = undefined;
  }
  headSniffCache.set(path, runtime);
  return runtime;
}

/** 一行原文 → Claude Code 形状的 entry（读不了/不是对话行返回 null） */
export function translateSessionLine(runtime: string | undefined, line: string): AnyRecord | null {
  // ⚠ codex 先判：它**不在** AgentRuntime 里（那是「能启动并对话的运行时」，
  //   Codex 只读不能跑，见 lib/codex-session.ts 开头），agentRuntime() 会把它
  //   归一成 claude-code，于是原样返回 Codex 的行、下游全解析不出来。
  if (runtime === "codex") return codexLineToClaudeShape(line);
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
