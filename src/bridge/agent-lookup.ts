/**
 * 按 `manager list` 的结果找 agent，list 失败时明确报「不可用」而不是当成「没有这个 agent」。
 * runManager 超时 / 失败不抛、只回 {ok:false}；以前调用方 `agents || []` 会把它变成 no_target / 404 / 空列表，
 * 发送方以为对方不存在、不会重试。叶子模块：只依赖 src/lib，bridge.ts 与 api-routes.ts 各一行接线。
 */
import { agentsFromList, listAgentsStrict, runManagerProcess } from "../lib/run-manager.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";

/**
 * route_to_agent 查 list 的预算，比 runManager 给 list 的 20s 短：拒绝必须赶在调用方超时之前回去（bridgeSend 默认 10s、
 * step-wake 15s），否则调用方先超时记成 sent:true「结果不明」不再重试，目标却一条都没收到（tests/agent-lookup-route-timeout.test.ts）。
 * 调长之前先看最短的调用方等待预算。
 */
export const ROUTE_LIST_BUDGET_MS = 6_000;

const listForRoute = () => runManagerProcess(["list"], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: ROUTE_LIST_BUDGET_MS });

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

/** /api/v1 按名字找 agent（带不带 agent- 前缀都认）。list 失败 / 抛错都抛 ListUnavailableError，由 apiErrorResponse 映射成 503 */
export async function findListedAgent(list: () => Promise<unknown>, name: string): Promise<any | null> {
  const agents = await listAgentsStrict(list);
  const hit = agents.find((a) => a.name === name || a.name === `agent-${name}` || `agent-${a.name}` === name);
  return hit ? { ...hit } : null; // 名单可能是 api-routes 的共享缓存：交出副本，调用方改字段不串到别的请求
}

/** route_to_agent 入口：查不到目标就把拒绝帧（投递前，sent:false）回给调用方并返回 null，bridge.ts 随即 break */
export async function routeLookupOrReject(
  ws: { send(data: string): unknown },
  requestId: unknown,
  rawTarget: string,
  list: () => Promise<unknown> = listForRoute,
): Promise<Extract<RouteLookup, { target: unknown }> | null> {
  // list 调用本身抛错（spawn / 读管道失败）也在投递前，同样回 list_unavailable，不能冒到外层 catch 变成 sent:true 的普通 error
  const listResult = await list().catch((e: unknown) => ({ ok: false, error: `manager list 调用异常: ${(e as Error).message}` }));
  const found = lookupRouteTarget(listResult, rawTarget);
  if ("rejected" in found) {
    ws.send(JSON.stringify({ type: "response", requestId, ...found }));
    return null;
  }
  return found;
}
