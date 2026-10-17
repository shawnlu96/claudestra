/**
 * CODEXPROBE1 探测的生产依赖：经 codex.ts runCodex 起（不手写 spawn）。单放一个文件，让 lend-health → lend-codex-probe 这条调度器可达的链
 * 不连到 codex.ts 的进程副作用（bun run skip-effects --check）。工作目录是系统临时目录，不在任何仓库里。tests/lend-codex-probe.test.ts。
 */
import { tmpdir } from "node:os";
import { runCodex } from "./codex.js";
import { codexProbeMode, type CodexPauseProbe } from "./lend-codex-probe.js";
import type { ObservedAction } from "./recovery-policy.js";

const PROBE_TIMEOUT_MS = 3 * 60_000;
/** 不带仓库内容、路径、凭据；不要工具、不派子 agent：只要一条带 rate_limits 的 rollout */
const PROBE_PROMPT = "Reply with the single word OK. Do not run any commands or tools.";

export function codexPauseProbeDeps(o: { observe?: (a: ObservedAction) => void } = {}): CodexPauseProbe {
  return {
    mode: () => codexProbeMode(),
    call: () => runCodex({ prompt: PROBE_PROMPT, sandbox: "read-only", cwd: tmpdir(), isolateMcp: true, timeoutMs: PROBE_TIMEOUT_MS }),
    ...(o.observe ? { observe: o.observe } : {}),
  };
}
