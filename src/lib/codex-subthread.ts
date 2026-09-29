/**
 * Codex 线程的「子线程」判定与归属（纯函数，从 codex-session.ts 搬出以免它超 400 行）：session_meta 的 payload →
 * 是不是子线程、父会话是谁、来源是什么。单测 tests/codex-sub-sessions.test.ts。
 */
import type { SubSessionInfo } from "./runtimes/types.js";

type AnyRecord = Record<string, any>;

/** source 是 `{subagent: …}` 对象（Codex 的 SessionSource::SubAgent）时的子来源名；不是 = null */
function subagentSourceOf(p: AnyRecord): string | null {
  const s = p.source;
  if (!s || typeof s !== "object" || !("subagent" in s)) return null;
  return typeof s.subagent === "string" && s.subagent ? s.subagent : "subagent";
}

/**
 * session_meta 的 payload 是不是子线程，任一即算：id ≠ session_id；带 parent_thread_id；thread_source 存在且不是 user
 * （subagent / guardian_review，以及 codex 0.153 起的 memory_consolidation / review / compact / thread_spawn 等）；
 * source 是 `{subagent: …}` 对象。fork（只带 forked_from_id）、exec / vscode 会话、普通会话都是 thread_source=user 或没有，
 * 不能被当成子线程（tests/codex-sub-sessions.test.ts）。
 */
export function isCodexSubThread(p: AnyRecord): boolean {
  if (p.session_id && p.id && p.session_id !== p.id) return true;
  if (typeof p.parent_thread_id === "string" && p.parent_thread_id !== "") return true;
  return (typeof p.thread_source === "string" && p.thread_source !== "" && p.thread_source !== "user") || subagentSourceOf(p) !== null;
}

/** 子线程的直接父会话、来源（subagent / guardian_review 自动审查）与昵称（subagent 才有，如 Popper）；父会话不明 = "" */
export function codexSubOf(p: AnyRecord): SubSessionInfo {
  const root = p.session_id && p.session_id !== p.id ? p.session_id : "";
  const ts = typeof p.thread_source === "string" && p.thread_source && p.thread_source !== "user" ? p.thread_source : null;
  const sub: SubSessionInfo = { parentId: String(p.parent_thread_id || root), kind: ts ?? subagentSourceOf(p) ?? "subagent" };
  return typeof p.agent_nickname === "string" && p.agent_nickname ? { ...sub, nickname: p.agent_nickname } : sub;
}

/**
 * 程序跑 `codex exec` 留下的一次性会话（session_meta.source = "exec"）：不是人开的对话，一跑完就不再写，也没有父会话，
 * 会话列表里收进一个默认折叠的组、闲置满天数由归档扫描收走，和子线程同样处理。子线程另有归属，不算在这里。
 */
export const isCodexOneShot = (p: AnyRecord): boolean => p.source === "exec" && !isCodexSubThread(p);
