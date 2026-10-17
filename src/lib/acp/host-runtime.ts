/**
 * ACP 宿主里按运行时不同的几处（docs/design/pi-acp-eval.md §6）：起哪个适配器、给它什么环境、channel-server 怎么交过去、
 * /clear 要不要引导轮、卡片和日志里怎么称呼。其余（回合、出站确认、工具代理、失败分类）两家共用宿主的同一套。
 * 宿主命令不带 CLAUDESTRA_ACP_RUNTIME = codex（老命令照旧）；认不出的值直接抛，不猜。tests/acp-host-runtime.test.ts。
 * OpenCode 直连 `opencode acp`，没有适配器进程；它和宿主契约的三处差距在 translator 里补（docs/runtimes/opencode-acp.md）。
 */
import { BOOTSTRAP_PROMPT } from "../codex-launch.js";
import { acpAgentCommand, adapterEnv, channelServerEnv, hostEnvBase, type AdapterEnvSpec, type AgentCommand } from "./adapter-proc.js";
import { selectedCodexAdapter } from "./codex-compat.js";
import { OPENCODE_BIN_ENV, opencodeBin, opencodeDirsEnv, OPENCODE_INSTALL_HINT } from "./opencode-bin.js";
import { PI_ACP_ADAPTER_MAIN } from "./pi-adapter/main.js";
import { sandboxPiEnv, sandboxPiProblem } from "./pi-adapter/sandbox-policy.js";
import type { CompactSource, TranslatorOptions } from "./updates.js";

export const ACP_RUNTIME_ENV = "CLAUDESTRA_ACP_RUNTIME";
/** Pi 的能力档等参数（JSON 字符串数组），由 runtimes/pi-acp.ts 的启动命令给，原样排在适配器的 pi 参数前面 */
export const PI_ARGS_ENV = "CLAUDESTRA_PI_ARGS";

/** ACP 的 stdio MCP server（session/new|resume 的 mcpServers 一项） */
interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpRuntime {
  readonly id: "codex" | "pi" | "opencode";
  /** 失败 / 授权卡与日志里的称呼 */
  readonly label: string;
  /** 适配器 stderr 的行前缀 */
  readonly logLabel: string;
  /** /clear 的新会话先跑这一轮：Codex 新线程跑完一轮才落盘；Pi 的 --session-id 开会话即可，不要 */
  readonly clearBootstrap?: string;
  agentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand;
  adapterEnv(spec: AdapterEnvSpec): Record<string, string>;
  /** 交给 session/new|resume|fork 的 mcpServers */
  mcpServers(spec: AdapterEnvSpec): AcpMcpServer[];
  /** 压缩完成认哪个来源（updates.ts CompactSource）：Pi 是适配器的中性记号，Codex 是 ACP compaction_update，OpenCode 什么都不发 */
  readonly compactFrom: CompactSource["from"];
  /** translator 的按运行时差异；不给 = 现行行为 */
  translator?(mcpName: string): TranslatorOptions;
}

function piAgentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 Pi 的 ACP 适配器" };
  let args: unknown = null;
  try {
    args = JSON.parse(env[PI_ARGS_ENV] || "[]");
  } catch {
    /* 不是 JSON：落到下面报错 */
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { error: `${PI_ARGS_ENV} 要是 JSON 字符串数组` };
  const refused = sandboxPiProblem(env, args); // 沙箱：目录钉在沙箱根、只用最小发现集（manager 那头已按同一规则拼过，这里再查一遍）
  return refused ? { error: refused } : { cmd: [bunBin, PI_ACP_ADAPTER_MAIN, ...args], stub: false };
}

/** Pi / OpenCode 只认 mcpServers：回环代理的地址和 token 只在这里（交给运行时起的 channel-server），不进适配器的环境 */
function stdioMcpServers(runtime: string): (s: AdapterEnvSpec) => AcpMcpServer[] {
  return (s) => {
    if (!s.channel || s.clean) return [];
    const env = Object.entries(channelServerEnv(s.channel, s.mcpName, runtime)).map(([name, value]) => ({ name, value }));
    return [{ name: s.mcpName, command: s.bunBin, args: [s.channelServer], env }];
  };
}

/** 宿主的工作目录就是会话 cwd（manager 在 agent 窗口里起它）；路径用启动命令带来的 OPENCODE_BIN（窗口不继承 manager 的 PATH） */
function opencodeAgentCommand(env: Record<string, string | undefined>, _bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 OpenCode" };
  const bin = opencodeBin(env);
  return bin ? { cmd: [bin, "acp", "--cwd", process.cwd()], stub: false } : { error: OPENCODE_INSTALL_HINT };
}

/**
 * OpenCode 不收 -m：缺省模型经 OPENCODE_CONFIG_CONTENT 给（不写盘），不给就是它自己的免费缺省 big-pickle——所以模型必填（manager 早拒），
 * 接上后宿主再按 CLAUDESTRA_ACP_MODEL set_config_option 校一次。权限对齐 Codex 的 agent-full-access：全放行（含 cwd 外的
 * external_directory、doom_loop），question 拒（无人值守，问了也没人答）。后写的规则覆盖 OpenCode 的内置缺省（debug agent build 实测）
 */
export function opencodeConfigContent(model: string | undefined): string {
  const permission = { "*": "allow", external_directory: "allow", doom_loop: "allow", question: "deny" };
  return JSON.stringify({ ...(model ? { model } : {}), permission, autoupdate: false });
}

const RUNTIMES: Record<string, AcpRuntime> = {
  codex: {
    id: "codex", label: "Codex", logLabel: "codex-acp", clearBootstrap: BOOTSTRAP_PROMPT, compactFrom: "compaction-update",
    // 选择开关按 agent 读（宿主环境里的 CLAUDESTRA_AGENT）：全局一处 + 单个 agent 覆盖（codex-compat-switch.ts）
    agentCommand: (env, bunBin, clean) => acpAgentCommand(env, bunBin, undefined, clean, selectedCodexAdapter(env.CLAUDESTRA_AGENT?.trim() || undefined)),
    adapterEnv,
    // channel-server 已在 CODEX_CONFIG 里；codex-acp 会丢掉和 config 同名的 mcpServers 项，传了也白传
    mcpServers: () => [],
  },
  pi: {
    id: "pi", label: "Pi", logLabel: "pi-acp", compactFrom: "claudestra-meta", agentCommand: piAgentCommand,
    adapterEnv: (s) => sandboxPiEnv(hostEnvBase(s), s.base), mcpServers: stdioMcpServers("pi"),
  },
  opencode: {
    id: "opencode", label: "OpenCode", logLabel: "opencode", compactFrom: "command-end", agentCommand: opencodeAgentCommand,
    adapterEnv: (s) => {
      const env = hostEnvBase(s);
      delete env[OPENCODE_BIN_ENV];
      return { ...env, ...opencodeDirsEnv(s.base), OPENCODE_CONFIG_CONTENT: opencodeConfigContent(s.base.CLAUDESTRA_ACP_MODEL?.trim() || undefined) };
    },
    mcpServers: stdioMcpServers("opencode"),
    translator: (mcpName) => ({ deferPendingTools: true, mcpUnderscoreServers: [mcpName] }),
  },
};

export function acpRuntime(id?: string): AcpRuntime {
  const rt = RUNTIMES[id || "codex"];
  if (!rt) throw new Error(`ACP 宿主不认识的运行时「${id}」（${ACP_RUNTIME_ENV} 只能是 ${Object.keys(RUNTIMES).join(" / ")}）`);
  return rt;
}
