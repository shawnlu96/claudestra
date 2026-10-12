/**
 * 按 `manager list` 的结果找 agent，list 失败时明确报「不可用」而不是当成「没有这个 agent」。
 * runManager 超时 / 失败不抛、只回 {ok:false}；以前调用方 `agents || []` 会把它变成 no_target / 404 / 空列表，
 * 发送方以为对方不存在、不会重试。叶子模块：只依赖 src/lib，bridge.ts 与 api-routes.ts 各一行接线。
 */
import { agentsFromList } from "../lib/run-manager.js";

export type RouteLookup =
  | { agents: any[]; target: any; targetName: string }
  | { error: string; rejected: "list_unavailable" | "no_target" };

/**
 * route_to_agent 的目标查找。两种拒绝都在投递前，bridge-client 会标成 sent:false，调用方可安全重排；
 * list_unavailable 与 no_target 分开，是为了不让「暂时查不了」被当成「目标不存在」放弃。
 */
export function lookupRouteTarget(listResult: unknown, rawTarget: string): RouteLookup {
  const targetName = rawTarget.startsWith("agent-") ? rawTarget : `agent-${rawTarget}`;
  let agents: any[];
  try {
    agents = agentsFromList(listResult);
  } catch (e) {
    return { error: `agent 列表暂时不可用，稍后重试（${(e as Error).message}）`, rejected: "list_unavailable" };
  }
  const target = agents.find((a) => a.name === targetName);
  if (!target) return { error: `Agent '${targetName}' 不存在或未在 registry 中`, rejected: "no_target" };
  return { agents, target, targetName };
}

/** /api/v1 按名字找 agent（带不带 agent- 前缀都认）。list 失败抛 ListUnavailableError，由 apiErrorResponse 映射成 503 */
export function findListedAgent(listResult: unknown, name: string): any | null {
  const agents = agentsFromList(listResult);
  return agents.find((a) => a.name === name || a.name === `agent-${name}` || `agent-${a.name}` === name) ?? null;
}
