/**
 * 侧栏列表的排序 / 分组 / 沉寂计算（纯函数，D8-9：从 sidebar.tsx 渲染体原样搬出，单测见
 * tests/web-sidebar-entries.test.ts）。三条规则由测试钉住：
 *  - 未读不参与排序（只按置顶分层，层内保持 state.agents 的最近活动序）；
 *  - 单成员 project 不成组（组头 = 同名冗余噪音），平铺在自身活动位次上；
 *  - 整组全员沉寂才下沉「💤 沉寂」；忙碌的永不算沉寂。
 */
import type { AgentSession, ProjectMeta } from "./type";

/** v2.21+ 方案 A 的沉寂判定:>30 天没真实对话(或从未说话且已停止)。
 *  忙碌的永不算沉寂。30s tick 重渲时会重估,模块级函数与 fmtAgo 同款先例。 */
export const DORMANT_MS = 30 * 24 * 3600_000;
export function isDormantAgent(a: AgentSession, now: number = Date.now()): boolean {
  if (a.busy) return false;
  const ts = a.lastActivityTs ?? null;
  return ts ? now - ts > DORMANT_MS : a.status === "stopped";
}

/** 搜索过滤（q 已小写）+ 只按「置顶」分层的稳定排序 */
export function filterAndRankWorkers(workers: AgentSession[], q: string, pinSet: Set<string>): AgentSession[] {
  return (
    q
      ? workers.filter((a) => `${a.displayName} ${a.name} ${a.purpose}`.toLowerCase().includes(q))
      : workers
  )
    .slice()
    .sort((a, b) => {
      // 只按「置顶」分层,层内保持原相对顺序(= state.agents 的最近活动序)。
      // ⚠ 未读**不参与排序**(2026-09-16 撤回:曾把有未读的拽到顶,但组件里每次
      // render 都 sort,绕过了 refreshAgents 的交互期冻结[noteSidebarInteraction],
      // Car Talk 一有未读/活动就在手指底下跳到顶 → 误点进错 agent。未读只用徽章+
      // 加粗表达,不动行位置)。
      const rank = (x: AgentSession) => (pinSet.has(x.name) ? 1 : 0);
      return rank(b) - rank(a);
    });
}

export type SidebarEntry =
  | { kind: "group"; id: string; meta?: ProjectMeta; items: AgentSession[] }
  | { kind: "row"; a: AgentSession };

/**
 * v2.21+ project 分组(owner 2026-08-28)。搜索时退回平铺(结果直给,不折叠)——此时返回空，
 * 调用方直接渲染 filtered。组序 = 组内最近活动(filtered 已按活动排,Map 插入序即组的活动序)。
 * 分组只在 project 有 ≥2 个成员时呈现(owner 2026-08-28 图评:「agent 比
 * project 还大,毫无条理」——单人组的组头 = 同名冗余噪音)。单成员/未分组
 * 的 agent 平铺,停留在自身活动排序的位次上;组整体占据最活跃成员的位次。
 */
export function buildSidebarEntries(
  filtered: AgentSession[],
  q: string,
  projMeta: Map<string, ProjectMeta>,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  if (!q) {
    const byId = new Map<string, AgentSession[]>();
    for (const a of filtered) {
      const key = a.projectId || "";
      const arr = byId.get(key);
      if (arr) arr.push(a);
      else byId.set(key, [a]);
    }
    const emitted = new Set<string>();
    for (const a of filtered) {
      const key = a.projectId || "";
      const items = byId.get(key)!;
      if (key && items.length >= 2) {
        if (!emitted.has(key)) {
          emitted.add(key);
          entries.push({ kind: "group", id: key, meta: projMeta.get(key), items });
        }
      } else {
        entries.push({ kind: "row", a });
      }
    }
  }
  return entries;
}

/** 方案 A(owner 2026-08-28):>30 天没动静的 agent 收进底部默认折叠的「💤 沉寂」
 *  ——死 agent 不再占视野。组以「全员沉寂」为准整组下沉;忙碌的永不算沉寂。 */
export function splitDormant(
  entries: SidebarEntry[],
  now: number = Date.now(),
): { activeEntries: SidebarEntry[]; dormantEntries: SidebarEntry[] } {
  const dormant = (a: AgentSession) => isDormantAgent(a, now);
  const entryDormant = (e: SidebarEntry) => (e.kind === "row" ? dormant(e.a) : e.items.every(dormant));
  return {
    activeEntries: entries.filter((e) => !entryDormant(e)),
    dormantEntries: entries.filter(entryDormant),
  };
}
