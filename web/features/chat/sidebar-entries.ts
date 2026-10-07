/**
 * 侧栏列表的排序 / 分组 / 沉寂计算（纯函数，D8-9：从 sidebar.tsx 渲染体原样搬出，单测见
 * tests/web-sidebar-entries.test.ts）。三条规则由测试钉住：
 *  - 未读不参与排序（只按置顶分层，层内保持 state.agents 的最近活动序）；
 *  - 单成员 project 不成组（组头 = 同名冗余噪音），平铺在自身活动位次上；
 *  - 整组全员沉寂才下沉「💤 沉寂」；忙碌的永不算沉寂。
 *  - 派发关系（parent）先挂树再分组：执行者跟着派发者走，只挂一层，组头按顶层条目数算。
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

/**
 * 每个 agent 挂在谁下面（name → 顶层派发者名；不在表里 = 自己就是顶层）。只挂一层：孙辈沿 parent 链一直走到
 * 最顶上的可见祖先，和兄弟们平铺在同一组里。派发者不在列表里（被删 / 归档 / scope 外没下发）就停在那一层；
 * 大总管只在 masterName 给了（它在列表里）时算数；环上的每个 agent 都当没有 parent。
 */
export function teamRoots(list: AgentSession[], masterName?: string): Map<string, string> {
  const by = new Map(list.map((a) => [a.name, a] as const));
  const visible = (p?: string | null): p is string => !!p && (by.has(p) || (!!masterName && p === masterName));
  const inCycle = (a: AgentSession) => {
    const seen = new Set<string>();
    for (let p = a.parent; visible(p) && !seen.has(p); p = by.get(p)?.parent) {
      if (p === a.name) return true;
      seen.add(p);
    }
    return false;
  };
  const cyclic = new Set(list.filter(inCycle).map((a) => a.name));
  const up = (n: string): string | undefined => {
    const p = by.get(n)?.parent;
    return !cyclic.has(n) && visible(p) ? p : undefined;
  };
  const roots = new Map<string, string>();
  for (const a of list) {
    let r = a.name;
    for (let p = up(r); p; p = up(r)) r = p; // 去掉环之后链一定有尽头
    if (r !== a.name) roots.set(a.name, r);
  }
  return roots;
}

/** 搜索过滤（q 已小写，任务名也参与匹配）+ 只按「置顶」分层的稳定排序；不搜索时置顶只对顶层行生效（执行者留在派发者下面） */
export function filterAndRankWorkers(workers: AgentSession[], q: string, pinSet: Set<string>, masterName?: string): AgentSession[] {
  // Workers are reachable by an intentional name search, without leaking into purpose/task matches.
  const visible = workers.filter((a) => a.kind !== "worker" || (!!q && `${a.displayName} ${a.name}`.toLowerCase().includes(q)));
  const roots = q ? null : teamRoots(visible, masterName);
  return (
    q
      ? visible.filter((a) => `${a.displayName} ${a.name} ${a.purpose} ${a.task ?? ""}`.toLowerCase().includes(q))
      : visible
  )
    .slice()
    .sort((a, b) => {
      // 只按「置顶」分层,层内保持原相对顺序(= state.agents 的最近活动序)。
      // ⚠ 未读**不参与排序**(2026-09-16 撤回:曾把有未读的拽到顶,但组件里每次
      // render 都 sort,绕过了 refreshAgents 的交互期冻结[noteSidebarInteraction],
      // Car Talk 一有未读/活动就在手指底下跳到顶 → 误点进错 agent。未读只用徽章+
      // 加粗表达,不动行位置)。
      const rank = (x: AgentSession) => (pinSet.has(x.name) && !roots?.has(x.name) ? 1 : 0);
      return rank(b) - rank(a);
    });
}

/** 顶层行 + 挂在它下面的执行者（children 空 = 普通行）。下一期的「阶段小标」挂在执行者行的 tail 插槽上，不改这个形状 */
export interface TeamNode {
  a: AgentSession;
  children: AgentSession[];
}

export type SidebarEntry =
  | { kind: "group"; id: string; meta?: ProjectMeta; items: AgentSession[]; nodes: TeamNode[] }
  | ({ kind: "row" } & TeamNode);

/** 「派出 N」只数直接派出的：孙辈虽然提升到同一组里显示，但不是这个派发者派的 */
export function directCount(parentName: string, kids: AgentSession[]): number {
  return kids.filter((k) => k.parent === parentName).length;
}

/** 大总管下挂的也走沉寂：沉寂的不占大总管卡片下面的位置，当普通行收进底部「💤 沉寂」 */
export function splitMasterKids(kids: AgentSession[], now: number = Date.now()): { awake: AgentSession[]; dormantRows: SidebarEntry[] } {
  return {
    awake: kids.filter((a) => !isDormantAgent(a, now)),
    dormantRows: kids.filter((a) => isDormantAgent(a, now)).map((a) => ({ kind: "row" as const, a, children: [] })),
  };
}

/** 一个条目里的全部 agent（派发者在前）：组忙碌、沉寂判断与计数用 */
export function entryMembers(e: SidebarEntry): AgentSession[] {
  return e.kind === "group" ? e.items : [e.a, ...e.children];
}

/**
 * 按 teamRoots 把列表收成 TeamNode（节点序 = 组里最活跃成员第一次出现的位次，list 已按活动 / 置顶排好），
 * 挂在大总管下面的单独拿出来（渲染在顶部大总管卡片下）。
 */
export function buildTeams(list: AgentSession[], masterName?: string): { nodes: TeamNode[]; underMaster: AgentSession[] } {
  const roots = teamRoots(list, masterName);
  const by = new Map(list.map((a) => [a.name, a] as const));
  const nodeOf = new Map<string, TeamNode>();
  const nodes: TeamNode[] = [];
  const underMaster: AgentSession[] = [];
  for (const a of list) {
    const r = roots.get(a.name) ?? a.name;
    if (masterName && r === masterName) {
      underMaster.push(a);
      continue;
    }
    let n = nodeOf.get(r);
    if (!n) {
      n = { a: by.get(r)!, children: [] };
      nodeOf.set(r, n);
      nodes.push(n);
    }
    if (r !== a.name) n.children.push(a);
  }
  return { nodes, underMaster };
}

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
  masterName?: string,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  if (!q) {
    // 先挂树：执行者跟着派发者进它的 project（owner 定的 Q3），组头按顶层节点数算
    const { nodes } = buildTeams(filtered, masterName);
    const byId = new Map<string, TeamNode[]>();
    for (const n of nodes) {
      const key = n.a.projectId || "";
      const arr = byId.get(key);
      if (arr) arr.push(n);
      else byId.set(key, [n]);
    }
    const emitted = new Set<string>();
    for (const n of nodes) {
      const key = n.a.projectId || "";
      const grp = byId.get(key)!;
      if (key && grp.length >= 2) {
        if (!emitted.has(key)) {
          emitted.add(key);
          entries.push({ kind: "group", id: key, meta: projMeta.get(key), nodes: grp, items: grp.flatMap((x) => [x.a, ...x.children]) });
        }
      } else {
        entries.push({ kind: "row", ...n });
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
  const entryDormant = (e: SidebarEntry) => entryMembers(e).every(dormant); // 派发者 + 执行者整组判断
  return {
    activeEntries: entries.filter((e) => !entryDormant(e)),
    dormantEntries: entries.filter(entryDormant),
  };
}
