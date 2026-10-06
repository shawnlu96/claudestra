/**
 * 当班 PM 本人用 send_to_agent 点名发给本项目某位 agent（多半是兼着监工的前任 PM）：不按 PM 角色转交——
 * 否则 pmRedirect 把它转回当班 PM 自己（PMDIR1 自身回转）。
 * 身份只认 bridge 侧的调用方凭据（bridge/caller-identity.ts callerOf，T85）：发信的那条连接此刻已验证、注册的正是
 * 信封上 bridge 自己填的发送频道、频道主人就是本项目 activePm。自报的 agentName、正文、meta 一概不看；
 * 别的来源（未验证、非当班 PM、跨项目、API / peer、人类直聊、回程、转交）一律走原来的角色转交。
 */
import { callerOf } from "./caller-identity.js";
import type { CallerIdentity } from "../lib/caller-identity.js";
import { pmPointer } from "../lib/pm-role.js";
import type { RegistryAgent } from "../lib/registry.js";
import type { Database } from "bun:sqlite";
import type { Envelope } from "./router.js";
import { isCallerPushback, isHumanDirect } from "./pm-held-transfer.js";

/** 连接 → 调用方身份与它注册的频道（默认就是 callerOf；测试注入夹具） */
export type CallerOf = (ws: object) => { identity: CallerIdentity; channelId: string | undefined };

/**
 * 记在 env.pmDirected（和 pmTransfer 一样随押后队列落盘）：哪位当班 PM 从哪个频道点名发的。它不授予任何东西——
 * 每次投递都按凭据重核；它只让「之前核过、当班 PM 没变、现在却核不过」的一封明确拒收，而不是退回角色转交投给发信人自己
 */
interface PmDirected { by: string; channelId: string }
type Marked = Envelope & { pmDirected?: PmDirected };

/** directed = 照点名的收件人投；refused = 曾核过的点名信现在核不过（会话 / 凭据 / 项目漂移），拒收；null = 按原 PM 角色规则 */
export type PmDirectedVerdict = "directed" | "refused" | null;

export function pmDirectedVerdict(env: Envelope, original: Pick<RegistryAgent, "name" | "projectId">, db: Database,
  agents: readonly RegistryAgent[], identityOf: CallerOf = (ws) => callerOf(ws)): PmDirectedVerdict {
  const from = env.from;
  if (from.kind !== "local" || !original.projectId || env.meta.triggerKind !== "agent_tool" || env.intent !== "request"
    || env.meta.forwarded || isCallerPushback(env) || isHumanDirect(env)) return null;
  const pointer = pmPointer(db, original.projectId);
  if (!pointer || pointer === original.name) return null;
  const t = env as Marked, mark = t.pmDirected;
  const sender = agents.find((a) => a.name === pointer && a.projectId === original.projectId);
  let caller: ReturnType<CallerOf> | undefined;
  try {
    caller = from.ws && typeof from.ws === "object" ? identityOf(from.ws) : undefined;
  } catch (e) {
    console.error("[pm-directed] caller identity check failed", (e as Error).message);
  }
  const verified = !!sender?.channelId && sender.channelId === from.channelId && caller?.channelId === from.channelId
    && !!caller.identity.verified && caller.identity.agent === pointer && (!mark || mark.channelId === from.channelId);
  if (verified) {
    t.pmDirected = { by: pointer, channelId: from.channelId };
    return "directed";
  }
  return mark && mark.by === pointer ? "refused" : null;
}
