/**
 * 会话记录的统一入口（runtime 感知）—— v2.23+，v2.24 起改由适配器注册表实现。
 *
 * 全系统有五个地方在读 agent 的会话 jsonl：jsonl-watcher（流式喂 Discord/web）、
 * session-history（历史面板）、session-archive（退役快照）、jsonl-cost / agent-stats
 * （用量）、bridge 的「忘了 reply 就兜底抽正文」。它们都写死过 Claude Code 的
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` 与行格式。
 *
 * 这里只提供四个纯函数（定位 / 列举 / 反推 / 逐行翻译），**具体怎么做由适配器回答**
 * （见 lib/runtimes/）。v2.24 之前这个文件里是一串 `if (runtime === "pi") … if
 * (runtime === "codex") …`，每加一种运行时就要在四个函数里各补一条分支；现在加运行时
 * 只改 lib/runtimes/index.ts 的注册数组，这里一行不用动。
 *
 * 为什么不把翻译做进各个消费者：五个消费者里有一堆与格式无关的逻辑（去抖、分组、
 * 归档语义、成本归并），把它们改成中立的中间层是大手术；而「某运行时的行 → CC 形状」
 * 是纯函数、可单测。哪天中间层出现，删掉 translate 即可。
 */

import { sourceFor, sourceIdForPath } from "./runtimes/index.js";

type AnyRecord = Record<string, any>;

/**
 * 定位 agent 当前会话的记录文件。**找不到返回 null** —— Pi 与 Codex 的文件名都带
 * 时间戳前缀，光有 cwd+id 拼不出路径，调用方要转去全库扫描或轮询。
 */
export function sessionJsonlPath(
  runtime: string | undefined,
  cwd: string,
  sessionId: string,
): string | null {
  return sourceFor(runtime).sessionPath(cwd, sessionId);
}

/** 全库兜底查找（cwd 记错或路径推断失准时用） */
export function findSessionJsonlBySessionId(runtime: string | undefined, sessionId: string): string | null {
  return sourceFor(runtime).findSessionById(sessionId);
}

/** 列出某工作目录下的会话文件（fork 前后 diff、归档扫描用） */
export function listSessionJsonls(runtime: string | undefined, cwd: string): string[] {
  return sourceFor(runtime).listSessionsForCwd(cwd);
}

/**
 * 从**已知的会话文件路径**反推 runtime（认不出 / 是 Claude Code ⇒ undefined）。
 *
 * 为什么要这个：解析侧（历史面板 / 用量 / 归档 / 会话尾巴 / cron 摘要 / reply 兜底）
 * 拿到的都是一个路径，把 runtime 从 manager 一路透传到这几层要改六处签名。
 *
 * 两层判据都在注册表里：先按各家根目录（零 I/O），**归档副本**的路径两个根都不沾
 * （它躺在 `~/.claude-orchestrator/archive/` 下），只能读首行让各家自己认——原版只
 * 看路径时，归档后的 Pi 会话被当成 Claude Code 行解析、一条都认不出来，历史面板
 * 永远为空（review #10 阻塞项）。
 */
export function runtimeForSessionPath(path: string | undefined | null): string | undefined {
  return sourceIdForPath(path);
}

/** 一行原文 → Claude Code 形状的 entry（读不了/不是对话行返回 null） */
export function translateSessionLine(runtime: string | undefined, line: string): AnyRecord | null {
  return sourceFor(runtime).translateLine(line);
}
