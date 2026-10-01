/**
 * Pi 的 ACP 版适配器（transport=acp）。只能经 `manager transport <agent> acp` 切过来，Pi 缺省仍是 tmux（runtimes/pi.ts）。
 * 会话来源和 tmux 版同一套（pi 的会话文件照写，历史 / 归档照读）；生命周期换成窗口里跑 ACP 宿主（src/acp-host.ts），
 * 宿主再起仓库里的 Pi 适配器（lib/acp/pi-adapter/）。和 Codex 版的差别：pi 的 --session-id 是 open-or-create，
 * new / resume / restart 同一条命令，没有引导轮；/clear 由适配器换新 id 重起 pi；就绪标记、退出序列与 Codex 版相同。
 * tests/pi-acp-runtime.test.ts。
 */
import { join } from "node:path";
import { channelInstructions } from "../channel-instructions.js";
import { acpCallerCredAssignment } from "../caller-cred-launch.js";
import { shellEscape } from "../claude-launch.js";
import { codexDeveloperInstructions } from "../codex-launch.js";
import { pathOverrideAssignments } from "../paths.js";
import { normalizePiEnvProfile, piActivateTools, piBinName, piEnvFlags, type PiEnvProfile } from "../pi-env.js";
import { isPiThinkingLevel } from "../pi-launch.js";
import { piAgentDirOf } from "../pi-path.js";
import { assertSandboxRuntime, isSandbox } from "../sandbox.js";
import { ACP_RUNTIME_ENV, PI_ARGS_ENV } from "../acp/host-runtime.js";
import { piMcpClash } from "../acp/pi-adapter/mcp-clash.js";
import { keepReplyTool } from "../acp/pi-adapter/reply-tool.js";
import { SANDBOX_PI_FLAGS } from "../acp/pi-adapter/sandbox-policy.js";
import { probePiAcp } from "../acp/readiness.js";
import { REPO_ROOT } from "../repo-root.js";
import { ACP_CONTROL, acpExitPrelude } from "./acp-control.js";
import { piAdapter } from "./pi.js";
import type { LaunchSpec, ManagedRuntimeAdapter } from "./types.js";

const mcpName = (env: Record<string, string | undefined>) => env.MCP_NAME || "claudestra";

/**
 * 交给适配器的 pi 参数（排在它自己的 rpc / 挂 MCP / 会话 id 之前）：信任开关与能力档同 tmux 版；职责和回复规则走
 * --append-system-prompt，每次起 pi（含 /clear 换的新会话）都带，所以不需要 Codex 那种重启前言。
 * 沙箱里不认 registry 的能力档（它能加 npm 包、指向 owner 的 MCP 配置），固定最小发现集（acp/pi-adapter/sandbox-policy.ts）。
 * 能力档先过 keepReplyTool（reply-tool.ts）：白名单补上 reply 的 pi 工具名，禁了 reply、MCP_NAME 保证不了就抛。
 */
export function piAcpArgs(spec: LaunchSpec, agent: string, repoRoot: string, sandbox = false, mcp = "claudestra"): string[] {
  const piEnv = keepReplyTool(sandbox ? undefined : (spec.extras?.piEnv as PiEnvProfile | undefined), mcp);
  const prompt = codexDeveloperInstructions({ agentName: agent, purpose: spec.purpose, projectContext: spec.projectContext, channelRules: channelInstructions(repoRoot) });
  const flags = sandbox ? SANDBOX_PI_FLAGS : piEnvFlags(piEnv);
  return [piEnv?.trustProject === false ? "--no-approve" : "--approve", ...flags, "--name", agent, "--append-system-prompt", prompt];
}

/** 启动命令：环境变量前缀 + bun acp-host.ts（窗口的 cwd 就是会话的 cwd）。纯函数，单测逐字钉住 */
export function buildPiAcpHostCommand(spec: LaunchSpec, o: { bunBin: string; repoRoot: string; env?: Record<string, string | undefined> }): string {
  const env = o.env ?? process.env;
  assertSandboxRuntime("pi", env, "acp"); // 沙箱里 PI_CODING_AGENT_DIR 没钉在沙箱根就拒（docs/architecture/pi-acp-sandbox.md）
  const sandbox = isSandbox(env);
  const agent = spec.agentName || spec.settingsName;
  if (!agent) throw new Error("ACP 宿主需要 agent 名（LaunchSpec.agentName / settingsName）");
  if (!spec.sessionId) throw new Error("ACP 宿主需要会话 id");
  const effort = spec.effort?.trim();
  const pairs: [string, string | undefined][] = [
    ["DISCORD_CHANNEL_ID", spec.channelId],
    ["BRIDGE_URL", spec.bridgeUrl],
    ["CLAUDESTRA_AGENT", agent],
    ["CLAUDESTRA_SESSION_ID", spec.sessionId],
    ["MCP_NAME", mcpName(env)],
    // 0.99 的 codemode / tool_search 注册但不激活，光 -e 加载是空操作 ⇒ 把要激活的工具名
    // 交给 activate-tools 扩展（它在 session_start 里 setActiveTools）
    [
      "CLAUDESTRA_PI_ACTIVATE",
      piActivateTools(
        keepReplyTool(sandbox ? undefined : (spec.extras?.piEnv as PiEnvProfile | undefined), mcpName(env)),
      ).join(",") || undefined,
    ],
    [ACP_RUNTIME_ENV, "pi"],
    // 与 piAvailable() 的探测同源：窗口不继承 manager 的 env，PI_BIN 不带过去就会预检通过、窗口里找不到 pi
    ["PI_BIN", piBinName()],
    ["CLAUDESTRA_ACP_MODEL", spec.model?.trim() || undefined],
    ["CLAUDESTRA_ACP_EFFORT", effort && isPiThinkingLevel(effort) ? effort : undefined], // 同 tmux 版：只放 pi 认的档位
    [PI_ARGS_ENV, JSON.stringify(piAcpArgs(spec, agent, o.repoRoot, sandbox, mcpName(env)))],
    // 窗口不继承 manager 的 env（继承 tmux server 的）：沙箱里把上面核过的目录显式带过去，宿主起适配器前会再核一遍
    ["PI_CODING_AGENT_DIR", sandbox ? env.PI_CODING_AGENT_DIR : undefined],
  ];
  const prefix = pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${shellEscape(v!)}`).join(" ");
  const cred = acpCallerCredAssignment(spec.callerCredFile, shellEscape);
  return `${prefix}${cred}${pathOverrideAssignments(shellEscape, env)} ${shellEscape(o.bunBin)} ${shellEscape(join(o.repoRoot, "src/acp-host.ts"))}`;
}

/**
 * 起之前就拒、别等模型发现没有 reply：pi 的 mcp.json 里有同名 server 会静默顶掉 channel-server（mcp-clash.ts，agent 目录按 Pi 的
 * 规则算），能力档会把 reply 筛掉（reply-tool.ts）。piEnv 是 registry 里的原始能力档。
 */
export function piAcpClash(cwd: string | undefined, env: Record<string, string | undefined> = process.env, piEnv?: unknown): string | null {
  const clash = piMcpClash([mcpName(env)], cwd ?? "", piAgentDirOf(env, cwd || undefined));
  if (clash) return clash;
  try {
    keepReplyTool(isSandbox(env) ? undefined : normalizePiEnvProfile(piEnv), mcpName(env)); // 沙箱起 pi 时不认 registry 的能力档
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const piAcpAdapter: ManagedRuntimeAdapter = {
  ...piAdapter,
  control: ACP_CONTROL,
  inbound: "acp-host",
  turnEnd: "acp-host",
  exitCommand: "",
  callerCred: "env",
  async available() {
    const r = await probePiAcp();
    return r.ok ? { ok: true } : { ok: false, hint: r.reason };
  },
  buildLaunchCommand(spec) {
    const clash = piAcpClash(spec.cwd);
    if (clash) throw new Error(clash);
    return buildPiAcpHostCommand(spec, { bunBin: process.execPath, repoRoot: REPO_ROOT }); // 与 Codex 版同：manager 自己的 bun
  },
  exitPrelude: acpExitPrelude,
  registryFields: (spec) => ({ ...piAdapter.registryFields(spec), transport: "acp" }),
};
