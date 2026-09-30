/**
 * manager / bridge 侧定位 Codex rollout 根的入口：生产与 codexSessionsRoot() 完全相同（CODEX_HOME || ~/.codex）；
 * 沙箱里 CODEX_HOME 缺失或不在沙箱根下就抛 SandboxViolation（lib/sandbox.ts sandboxCodexHomeProblem），
 * 不回落宿主 ~/.codex。codex-session.ts 本身不带这道闸：它是纯定位，调用方各自走这里。tests/sandbox-codex-home.test.ts。
 */
import { codexSessionsRoot } from "./codex-session.js";
import { assertSandboxCodexHome } from "./sandbox.js";

export function codexRolloutRoot(env: NodeJS.ProcessEnv = process.env): string {
  assertSandboxCodexHome(env);
  return codexSessionsRoot(undefined, env);
}
