/**
 * ACP 协议版本与 initialize 回包的兼容判定（维护流程见 docs/runtimes/acp-maintenance.md）。
 * - 宿主只讲 ACP v1（规范里 V2 还是草案）：适配器回的 protocolVersion 不是 1 或者没回，就判不兼容、拒起，不猜着往下讲；
 * - 必要能力：接回已有线程要 sessionCapabilities.resume 或 loadSession 至少一个；fork 只在 fork 操作时才要；
 * - 可选能力（steering、cancelReturnsQueue、compaction_update…）缺了不拒，按降级表走（docs/runtimes/codex-acp.md「可选能力缺失时怎么降级」）。
 * 不兼容由 AcpSession.initialize 抛 AcpIncompatibleError：宿主出一张卡、不再重起适配器（host.ts），create / fork 的引导直接失败。
 * 本文件不 import 任何模块：scripts/acp-stub.ts 也引它，stub 不能加载会查沙箱 / bridge 地址的模块。tests/acp-protocol.test.ts。
 */

export const ACP_PROTOCOL_VERSION = 1;

/** initialize 回包里适配器报的身份（ACP 的 agentInfo；没报或形状不对就是 null） */
export interface AgentInfo {
  name: string;
  version: string;
}

type InitializeVerdict =
  | { ok: true; resume: boolean; fork: boolean; agentInfo: AgentInfo | null }
  | { ok: false; reason: string };

/** 协议不兼容：带着写给 owner 看的原因（会原样上卡） */
export class AcpIncompatibleError extends Error {}

type Rec = Record<string, any>;

function agentInfoOf(r: Rec): AgentInfo | null {
  const a = r.agentInfo;
  return a && typeof a === "object" && typeof a.name === "string" && a.name ? { name: a.name, version: typeof a.version === "string" ? a.version : "?" } : null;
}

/** 判 initialize 回包能不能用；need.fork = 这次是 fork 操作 */
export function checkInitialize(result: unknown, need: { fork?: boolean } = {}): InitializeVerdict {
  const r: Rec = result && typeof result === "object" ? (result as Rec) : {};
  const agentInfo = agentInfoOf(r);
  const caps: Rec = r.agentCapabilities && typeof r.agentCapabilities === "object" ? r.agentCapabilities : {};
  const resume = !!caps.sessionCapabilities?.resume;
  const fork = !!caps.sessionCapabilities?.fork;
  const who = agentInfo ? `（${agentInfo.name} ${agentInfo.version}）` : "";
  const refuse = (why: string) => ({ ok: false as const, reason: `ACP 适配器${who}协议不兼容，拒绝启动：${why}` });
  const v = r.protocolVersion;
  if (v === undefined) return refuse(`initialize 没回 protocolVersion，宿主只讲 ACP v${ACP_PROTOCOL_VERSION}`);
  if (v !== ACP_PROTOCOL_VERSION) return refuse(`initialize 回的 protocolVersion 是 ${JSON.stringify(v)}，宿主只讲 ACP v${ACP_PROTOCOL_VERSION}`);
  if (!resume && caps.loadSession !== true) return refuse("既没声明 sessionCapabilities.resume 也没声明 loadSession，接不回已有线程");
  if (need.fork && !fork) return refuse("没有声明 session/fork 能力");
  return { ok: true, resume, fork, agentInfo };
}
