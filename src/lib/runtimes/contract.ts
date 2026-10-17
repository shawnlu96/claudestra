/**
 * 运行时的 ACP 契约：一个走 ACP 的运行时 = 一份 AcpRuntimeSpec（manager / bridge 侧）+ 其中的 AcpHostRuntime（宿主进程侧），
 * 在 runtimes/index.ts 的 RUNTIMES 里登记一行。宿主、就绪闸、运行时目录、transport 选择都只读这里的字段，不按 id 分支——
 * 新运行时不该改 runtimes/ 以外的文件（guard 的 pattern:runtime-literal 拦新增的按 id 判断）。
 * 照做的清单：docs/runtimes/adding-a-runtime.md；假运行时的整条链：tests/runtime-contract-fake.test.ts。
 */
import type { AdapterEnvSpec, AgentCommand } from "../acp/adapter-proc.js";
import type { AcpReady, AcpReadyDeps } from "../acp/readiness.js";
import type { AcpTranslatorOptions } from "../acp/updates.js";
import type { ManagedRuntimeAdapter } from "./types.js";

/** 宿主命令里点名运行时的环境变量（manager 的启动命令给，src/acp-host.ts 读）；不带 = codex（老命令照旧） */
export const ACP_RUNTIME_ENV = "CLAUDESTRA_ACP_RUNTIME";

/** ACP 的 stdio MCP server（session/new|resume 的 mcpServers 一项） */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** 宿主进程（src/acp-host.ts → lib/acp/host.ts）里按运行时不同的部分；其余（回合、出站确认、工具代理、失败分类）大家共用 */
export interface AcpHostRuntime {
  readonly id: string;
  /** 失败 / 授权卡与日志里的称呼 */
  readonly label: string;
  /** 适配器 stderr 的行前缀 */
  readonly logLabel: string;
  /** /clear 的新会话先跑这一轮（Codex：新线程跑完一轮才落盘）；不声明 = 开会话即可 */
  readonly clearBootstrap?: string;
  /** session/update 的翻译差异（lib/acp/updates.ts） */
  readonly translator: AcpTranslatorOptions;
  /** 起哪个适配器；clean = 出借 worker 的干净环境（不支持就返回 error） */
  agentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand;
  adapterEnv(spec: AdapterEnvSpec): Record<string, string>;
  /** 交给 session/new|resume|fork 的 mcpServers（channel-server 走配置文件的运行时给 []） */
  mcpServers(spec: AdapterEnvSpec): AcpMcpServer[];
}

/** 按 agent 配置拦切 acp 的那一道看的 registry 字段 */
interface AcpAgentInfo {
  cwd?: string;
  piEnv?: unknown;
}

/** 一个模型（OCR-3 填实现；前端的模型下拉按它出） */
export interface RuntimeModel {
  id: string;
  label?: string;
  /** 这个模型可选的推理强度；不声明 = 没有这一档 */
  efforts?: string[];
}

export interface AcpRuntimeSpec {
  /** transport=acp 的生命周期适配器（窗口里跑 ACP 宿主） */
  readonly managed: ManagedRuntimeAdapter;
  readonly host: AcpHostRuntime;
  /** 切 / 建 acp 前的就绪闸（transport 命令、create、doctor 同一判据）。autoInstall：可以顺手装缺的依赖 */
  ready(autoInstall: boolean, deps: AcpReadyDeps): Promise<AcpReady>;
  /** 按这个 agent 的配置再拦一道（Pi：同名 MCP、能力档筛掉 reply）；返回拒绝原因。不声明 = 不拦 */
  agentProblem?(info: AcpAgentInfo, env: Record<string, string | undefined>): string | null;
  /** 运行时目录（GET /runtimes）先跑它，过了就算可用（Codex：CLI 有 app-server）；不声明 = 只看适配器自己的 available() */
  catalogProbe?(): Promise<AcpReady>;
}
