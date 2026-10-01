/**
 * 沙箱里 Pi 适配器的边界（docs/architecture/pi-acp-sandbox.md）。只在 CLAUDESTRA_SANDBOX=1 时起作用，生产的参数和环境逐字节不变。
 * - 参数：扩展 / 技能 / 提示模板的发现全关，也不收会从别处加载代码或配置的参数。适配器自己的 -e builtin:mcp 与挂载扩展
 *   由 args.ts 排在这些参数之后，不受影响；
 * - 环境：HOME 换成沙箱里的（同 Codex 的 ACP 链），Pi 目录按沙箱根重算，不做启动时的联网杂务，不发遥测。
 * 目录钉没钉住由 lib/sandbox.ts 判（manager 起之前、宿主起适配器之前各查一次）。tests/pi-acp-sandbox.test.ts。
 */
import { isSandbox, sandboxPiAgentDir, sandboxPiAgentDirProblem, SANDBOX_ROOT_ENV } from "../../sandbox.js";
import { sandboxAcpHome } from "../stub.js";

type Env = Record<string, string | undefined>;

/** 沙箱里交给 pi 的发现开关（= 能力档 minimal）；runtimes/pi-acp.ts 在沙箱里用它替掉 registry 的能力档 */
export const SANDBOX_PI_FLAGS: readonly string[] = ["--no-extensions", "--no-skills", "--no-prompt-templates"];

/**
 * 沙箱里不收的 pi 参数：-e / --extension 的 npm: / git: 源会下包执行，路径源会加载沙箱外的代码；--mcp-config 可能指向 owner 的
 * 真实 MCP 配置（mem0 之类会写真数据）；--session-dir 会让会话落到钉住的目录之外。`--x=值` 的写法按同名算。
 */
const REFUSED = new Set(["-e", "--extension", "--skill", "--prompt-template", "--theme", "--mcp-config", "--session-dir"]);

/** 宿主起适配器前调：沙箱里目录没钉住、少了发现开关、带了上面那些参数就返回原因；非沙箱 null */
export function sandboxPiProblem(env: Env, args: readonly string[]): string | null {
  if (!isSandbox(env)) return null;
  const dir = sandboxPiAgentDirProblem(env);
  if (dir) return dir;
  const missing = SANDBOX_PI_FLAGS.find((f) => !args.includes(f));
  if (missing) return `沙箱里起 pi 必须带 ${missing}（不发现 owner 全局的扩展 / 技能 / 提示模板）`;
  const bad = args.find((a) => REFUSED.has(a.split("=")[0]!));
  return bad ? `沙箱里不收 pi 的 ${bad.split("=")[0]}（会从钉住的目录之外加载代码、配置或写会话）` : null;
}

/**
 * 适配器（及它起的 pi、pi 起的 channel-server）的环境：在宿主环境底（hostEnvBase）上改几项。非沙箱原样返回。
 * BRIDGE_URL 留着、BRIDGE_PORT 不留：适配器进程加载 lib/paths.ts 时沙箱总闸要一个非生产的 bridge 地址，缺了就按生产默认端口算、
 * 加载即抛；BRIDGE_PORT 若传到 pi 起的 channel-server，会跟它拿到的回环代理地址对不上，被同一道闸拒。
 */
export function sandboxPiEnv(env: Record<string, string>, base: Env): Record<string, string> {
  if (!isSandbox(base)) return env;
  const root = base[SANDBOX_ROOT_ENV]?.trim();
  const out: Record<string, string> = { ...env, HOME: sandboxAcpHome(root).HOME, PI_CODING_AGENT_DIR: sandboxPiAgentDir(root), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  if (base.BRIDGE_URL) out.BRIDGE_URL = base.BRIDGE_URL;
  delete out.PI_CODING_AGENT_SESSION_DIR; // 会话只能落在钉住的目录里：bridge 的会话发现、set-session 的核对都只在那里找
  return out;
}
