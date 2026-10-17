/**
 * CODEXPROBE1 探测的生产依赖。二进制按出借 worker 同一口径解析（resolveCodexBinary：CODEX_TUI_BIN → 登录 shell 的 codex，npm 壳换原生；
 * acp/readiness.ts 同款），解析不出再退回 ask_codex 的 findCodexBin（CODEX_BIN / ChatGPT.app）——只认后者的话，只装了 npm / TUI Codex
 * 的出借机每次探测都「Codex CLI 不存在」。参数用 codex.ts buildCodexArgs（只读沙箱、不加载全局 MCP），进程经 lend-deps 注入的 runBounded 起
 * （不手写 spawn，超时整组杀）；工作目录是系统临时目录，不在任何仓库里；最终回复不落盘（-o /dev/null）。tests/lend-codex-probe.test.ts。
 */
import { tmpdir } from "node:os";
import { buildCodexArgs, findCodexBin } from "./codex.js";
import { resolveCodexBinary } from "./codex-launch.js";
import { defaultRunner } from "./codex-thread.js";
import { codexProbeMode, type CodexPauseProbe } from "./lend-codex-probe.js";
import type { ObservedAction } from "./recovery-policy.js";
import type { BoundedResult } from "./run-bounded.js";
import { sandboxDisabled } from "./sandbox.js";

const PROBE_TIMEOUT_MS = 3 * 60_000;
/** 不带仓库内容、路径、凭据；不要工具、不派子 agent：只要一条带 rate_limits 的 rollout */
const PROBE_PROMPT = "Reply with the single word OK. Do not run any commands or tools.";

/** exec：起进程的口，生产由 lend-deps.ts 接 runBounded（进程副作用记在那边）；resolveBin 缺省按 worker 口径解析 */
export interface ProbeRunPorts {
  resolveBin?: () => Promise<string | null>;
  exec: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<BoundedResult>;
}
const workerCodexBin = async (): Promise<string | null> => (await resolveCodexBinary(defaultRunner).catch(() => null))?.real ?? findCodexBin();

/** 跑一次最小 Codex 调用；ok=false 含找不到二进制、超时、非零退出 */
export async function runProbeCall(ports: ProbeRunPorts): Promise<{ ok: boolean; message: string }> {
  const off = sandboxDisabled("Codex 额度探测");
  if (off) return { ok: false, message: off };
  const bin = await (ports.resolveBin ?? workerCodexBin)();
  if (!bin) return { ok: false, message: "Codex CLI 不存在：登录 shell 的 PATH 里没有 codex，也没设 CODEX_TUI_BIN / CODEX_BIN" };
  const cwd = tmpdir();
  // prompt 作位置参数（runBounded 不接 stdin）：替掉 buildCodexArgs 末尾读 stdin 的 "-"
  const args = [...buildCodexArgs({ prompt: PROBE_PROMPT, sandbox: "read-only", cwd, isolateMcp: true }, null, "/dev/null").slice(0, -1), PROBE_PROMPT];
  const r = await ports.exec([bin, ...args], { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.timedOut) return { ok: false, message: `Codex 超时(${PROBE_TIMEOUT_MS / 1000}s)被终止` };
  if (r.code !== 0) return { ok: false, message: `Codex 退出码 ${r.code}：${(r.stderr || r.stdout).trim().slice(-200)}` };
  return { ok: true, message: "OK" };
}

export function codexPauseProbeDeps(o: { ports: ProbeRunPorts; observe?: (a: ObservedAction) => void }): CodexPauseProbe {
  return {
    mode: () => codexProbeMode(),
    call: () => runProbeCall(o.ports),
    ...(o.observe ? { observe: o.observe } : {}),
  };
}
