/**
 * 当班 PM 本人用 send_to_agent 点名发给本项目某位 agent（多半是兼着监工的前任 PM）：不按 PM 角色转交——
 * 否则 pmRedirect 把它转回当班 PM 自己（PMDIR1 自身回转）。
 * 只有 bridge.ts route_to_agent 入口亲手打过戳（notePmDirectedFrame）的那封原信封才可能享受；身份只认 bridge 侧的调用方凭据
 * （bridge/caller-identity.ts callerOf，T85），连同入口帧的代理降级（ACP 非 MCP 起的连接逐帧 callerDowngraded）一起重核：
 * 发信的那条连接此刻已验证、注册的正是信封上 bridge 自己填的发送频道、频道主人就是本项目 activePm。
 * 自报的 agentName、正文、meta 一概不看；别的来源（未打戳、未验证、非当班 PM、跨项目、API / peer、人类直聊、回程、转交）一律走原来的角色转交。
 */
import { callerOf } from "./caller-identity.js";
import type { CallerIdentity } from "../lib/caller-identity.js";
import { pmPointer } from "../lib/pm-role.js";
import type { RegistryAgent } from "../lib/registry.js";
import type { Database } from "bun:sqlite";
import type { Envelope } from "./router.js";
import { isCallerPushback, isHumanDirect } from "./pm-held-transfer.js";

/** 入口帧里和身份有关的字段（只此一项，由 ACP 代理决定）：打戳时拷下来，不留可变的 msg 引用 */
interface EntryFrame { callerDowngraded: boolean }
/** 连接 + 入口帧 → 调用方身份与它注册的频道（默认就是 callerOf；测试注入夹具） */
export type CallerOf = (ws: object, frame: EntryFrame) => { identity: CallerIdentity; channelId: string | undefined };

/**
 * route_to_agent 入口构造的那一个信封对象 → 入口帧的身份字段。只在进程内（不落盘、不在 Envelope 上）：
 * 拷贝出来的信封、重启读回的押后信封都查不到，一律不享例外。打戳不等于已验证——每次投递都按 callerOf 重核
 */
const entryFrames = new WeakMap<Envelope, EntryFrame>();
export function notePmDirectedFrame(env: Envelope, frame: Record<string, unknown>): void {
  entryFrames.set(env, { callerDowngraded: frame.callerDowngraded === true });
}

/**
 * 记在 env.pmDirected（和 pmTransfer 一样随押后队列落盘）：哪位当班 PM 从哪个频道、在哪个项目点名发给了谁。它不授予任何东西——
 * 每次投递都按凭据重核；它只让「之前核过、现在核不过（发信人凭据 / 会话、目标项目 / 频道 / 会话漂移）」的一封明确拒收，
 * 而不是退回角色转交投给发信人自己，或回落成普通投递投给已不在本项目的目标
 */
interface PmDirected { by: string; channelId: string; projectId?: string; target?: string; targetChannelId?: string; targetSessionId?: string }
type Marked = Envelope & { pmDirected?: PmDirected };

/** directed = 照点名的收件人投；refused = 曾核过的点名信现在核不过，拒收；null = 按原 PM 角色规则 */
export type PmDirectedVerdict = "directed" | "refused" | null;

/** 目标此刻还是打标记时那位（同项目、同名、同频道、会话没换）：旧标记没记的字段只能证明不了，按漂移算 */
const sameTarget = (mark: PmDirected, original: Pick<RegistryAgent, "name" | "projectId" | "channelId" | "sessionId">): boolean =>
  mark.projectId === original.projectId && mark.target === original.name && mark.targetChannelId === original.channelId
  && (mark.targetSessionId ?? null) === (original.sessionId ?? null);

export function pmDirectedVerdict(env: Envelope, original: Pick<RegistryAgent, "name" | "projectId" | "channelId" | "sessionId"> | undefined,
  db: Database | null | undefined, agents: readonly RegistryAgent[], identityOf: CallerOf = (ws, frame) => callerOf(ws, { ...frame })): PmDirectedVerdict {
  const from = env.from;
  if (from.kind !== "local" || env.meta.triggerKind !== "agent_tool" || env.intent !== "request"
    || env.meta.forwarded || isCallerPushback(env) || isHumanDirect(env)) return null;
  const t = env as Marked, mark = t.pmDirected;
  // 核过的点名信：目标从注册表消失、换了项目 / 频道 / 会话，或项目已没有当班 PM 可核，就不再投（不回落成普通投递）
  if (mark && (!original || !sameTarget(mark, original))) return "refused";
  if (!original?.projectId) return null;
  if (!db) return mark ? "refused" : null;
  const pointer = pmPointer(db, original.projectId);
  if (!pointer) return mark ? "refused" : null;
  let caller: ReturnType<CallerOf> | undefined;
  const identity = (): ReturnType<CallerOf> | undefined => {
    if (caller) return caller;
    const frame = entryFrames.get(env);
    try {
      caller = frame && from.ws && typeof from.ws === "object" ? identityOf(from.ws, frame) : undefined;
    } catch (e) {
      console.error("[pm-directed] caller identity check failed", (e as Error).message);
    }
    return caller;
  };
  /** 发信的那条连接此刻已验证、注册的正是信封上 bridge 填的发送频道、身份就是 agent */
  const source = (agent: string): boolean => {
    const c = identity();
    return c?.channelId === from.channelId && !!c.identity.verified && c.identity.agent === agent;
  };
  // 核过的点名信先重核当初那位发信人：指针怎么变都不能掩盖它的凭据 / 会话失效（失效就拒收，不回落成普通投递或角色转交）
  if (mark && !(mark.channelId === from.channelId && source(mark.by))) return "refused";
  if (pointer === original.name) return null;
  const sender = agents.find((a) => a.name === pointer && a.projectId === original.projectId);
  const verified = !!sender?.channelId && sender.channelId === from.channelId && source(pointer) && (!mark || mark.by === pointer);
  if (verified) {
    t.pmDirected = { by: pointer, channelId: from.channelId, projectId: original.projectId, target: original.name,
      targetChannelId: original.channelId, targetSessionId: original.sessionId };
    return "directed";
  }
  // 当班 PM 已换成别人：B 的这封按角色交给新的当班 PM（带转交抬头），和别的发给前任的信一样
  return mark && mark.by === pointer ? "refused" : null;
}
