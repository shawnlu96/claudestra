/**
 * 侧栏「历史」(i28-SBH1，owner 10-03「review bot 这些历史乱七八糟的内容全收在团队协作视图里，很奇怪」)：
 * 用完的审查 / 执行会话收进每个项目组(及派发者卡片下子列表)底部默认折叠的「历史 N」。纯函数，
 * 写法照 sidebar-entries.ts 的沉寂判定；单测见 tests/web-sidebar-history.test.ts。
 *  - 忙碌的永不算历史；>30 天的(isDormantAgent)仍归「💤 沉寂」，不算历史；
 *  - 已停止且 24 小时没真实对话(或从未说话) → 历史；
 *  - 派出的会话(有派发者，或名字是审查 / 执行会话前缀)活着但 24 小时没对话 → 历史；
 *    自己也派了人的(PM / 调度器)、大总管、用户自建的普通 agent 只按上一条判。
 */
import { isDormantAgent, type SidebarEntry, type TeamNode } from "./sidebar-entries";
import type { AgentSession } from "./type";

export const HISTORY_MS = 24 * 3600_000;
/** 审查 / 执行会话的名字前缀(派单工具起的名) */
export const DISPATCHED_PREFIXES = ["review-", "rv-", "agent-task-", "agent-lend-"] as const;

/** 列表里谁派了人(= 是别人的 parent)：这些是 PM / 调度器，不按「派出的会话」判 */
export function dispatcherNames(list: AgentSession[]): Set<string> {
  return new Set(list.map((a) => a.parent).filter((p): p is string => !!p));
}

/** 派出的会话：名字带审查 / 执行前缀，或有派发者但自己没再派人 */
export function isDispatchedSession(a: AgentSession, dispatchers: ReadonlySet<string> = new Set()): boolean {
  if (a.pinnedMaster) return false;
  if (DISPATCHED_PREFIXES.some((p) => a.name.startsWith(p))) return true;
  return !!a.parent && !dispatchers.has(a.name);
}

export function isHistoryAgent(a: AgentSession, now: number = Date.now(), dispatchers?: ReadonlySet<string>): boolean {
  if (a.busy || a.pinnedMaster || isDormantAgent(a, now)) return false;
  const ts = a.lastActivityTs ?? null;
  const idle = ts !== null && now - ts > HISTORY_MS;
  if (a.status === "stopped" && (idle || ts === null)) return true;
  return idle && isDispatchedSession(a, dispatchers);
}

/**
 * 组内收起的：历史，外加留在活跃组里的个别 >30 天的(沉寂按整组 / 整行判、规则不变；整组没沉下去时
 * 组里那几个老的不该比 2 天前的审查会话还显眼)。
 */
export function isFoldedAgent(a: AgentSession, now: number = Date.now(), dispatchers?: ReadonlySet<string>): boolean {
  return !a.busy && (isHistoryAgent(a, now, dispatchers) || isDormantAgent(a, now));
}

/**
 * 派发者卡片下的子列表拆成在用 / 历史。派发者自己和下挂的全收起时整个节点原样不拆(它整体进所在组的历史，
 * 历史里不再套一层历史)。
 */
export function splitTeamHistory(
  node: TeamNode,
  now: number = Date.now(),
  dispatchers?: ReadonlySet<string>,
): { node: TeamNode; history: AgentSession[] } {
  const folded = (a: AgentSession) => isFoldedAgent(a, now, dispatchers);
  if (folded(node.a) && node.children.every(folded)) return { node, history: [] };
  return { node: { a: node.a, children: node.children.filter((c) => !folded(c)) }, history: node.children.filter(folded) };
}

type GroupEntry = Extract<SidebarEntry, { kind: "group" }>;

/**
 * 项目组拆成在用节点 + 底部历史节点：派发者和它下挂的全收起 → 整个节点进历史。
 * 返回的 e.items 只含在用的(组头计数 = 在用的；派发者卡片下收进历史的子项也不算)。
 */
export function splitGroupHistory(
  e: GroupEntry,
  now: number = Date.now(),
  dispatchers?: ReadonlySet<string>,
): { e: GroupEntry; history: TeamNode[] } {
  // 整组沉寂的(在「💤 沉寂」里显示)原样不拆，沉寂规则不变
  if (e.items.every((a) => isDormantAgent(a, now))) return { e, history: [] };
  const folded = (a: AgentSession) => isFoldedAgent(a, now, dispatchers);
  const isHist = (n: TeamNode) => folded(n.a) && n.children.every(folded);
  const nodes = e.nodes.filter((n) => !isHist(n));
  const items = nodes.flatMap((n) => [n.a, ...splitTeamHistory(n, now, dispatchers).node.children]);
  return { e: { ...e, nodes, items }, history: e.nodes.filter(isHist) };
}

/** 历史行上的 N：节点里的全部 agent */
export function historyCount(nodes: TeamNode[]): number {
  return nodes.reduce((n, x) => n + 1 + x.children.length, 0);
}
