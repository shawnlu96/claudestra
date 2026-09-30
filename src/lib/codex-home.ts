/**
 * manager / bridge 侧定位 Codex rollout 根的入口：生产与 codexSessionsRoot() 完全相同（CODEX_HOME || ~/.codex）；
 * 沙箱里 CODEX_HOME 缺失或不在沙箱根下就拒绝（lib/sandbox.ts sandboxCodexHomeProblem），不回落宿主 ~/.codex。
 * codex-session.ts 本身不带这道闸：它是纯定位，调用方各自走这里。tests/sandbox-codex-home.test.ts、tests/sandbox-codex-entries.test.ts。
 */
import { codexSessionsRoot } from "./codex-session.js";
import { assertSandboxCodexHome, sandboxCodexHomeProblem } from "./sandbox.js";

/** 拒绝时抛 SandboxViolation：用于调用方自己会 catch 的路径（额度、清扫、收编闸） */
export function codexRolloutRoot(env: NodeJS.ProcessEnv = process.env): string {
  assertSandboxCodexHome(env);
  return codexSessionsRoot(undefined, env);
}

const logged = new Set<string>();

/**
 * 拒绝时返回 null 并记一次日志（同一原因只记一次）：用于列表 / history 这类顺带查 Codex 的路径——
 * 沙箱配错时跳过 Codex 即可，不能让整条请求（含 Claude Code 会话的）500。
 */
export function codexRolloutRootOrSkip(what: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const p = sandboxCodexHomeProblem(env);
  if (!p) return codexSessionsRoot(undefined, env);
  if (!logged.has(p)) {
    logged.add(p);
    console.error(`[codex-home] 跳过${what}：${p}`);
  }
  return null;
}
