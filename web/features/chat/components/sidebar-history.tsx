"use client";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import type { SidebarEntry, TeamNode } from "../sidebar-entries";
import { dispatcherNames, historyCount, splitGroupHistory, splitTeamHistory } from "../sidebar-history";
import { usePersistedSet } from "../use-persisted-set";
import { useNow } from "../use-now";
import { Chevron } from "./project-group";
import type { RowSlots } from "./team-group";

/**
 * 侧栏「历史 N」折叠行(判定见 sidebar-history.ts)：项目组底部、派发者卡片下子列表底部各一行，默认折叠。
 * 高度 / 字号 / 颜色 / 开合和底部「💤 沉寂」那一行同款，只换文案和图标。
 * 展开状态按组记在本机(usePersistedSet，存的是「展开了的」——没记过 = 折叠)。
 */

type GroupEntry = Extract<SidebarEntry, { kind: "group" }>;

export interface SidebarHistory {
  open: Set<string>;
  toggle: (id: string) => void;
  now: number;
  dispatchers: Set<string>;
  /** 组头用的项目组：nodes / items 只留在用的(计数不含历史) */
  group: (e: GroupEntry) => GroupEntry;
}

export function useSidebarHistory(list: AgentSession[]): SidebarHistory {
  const [open, toggle] = usePersistedSet("cstra_history_open");
  const now = useNow(60_000); // 24 小时的边界，一分钟重估一次足够
  const dispatchers = dispatcherNames(list);
  return { open, toggle, now, dispatchers, group: (e) => splitGroupHistory(e, now, dispatchers).e };
}

/** lucide history */
function HistoryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function HistoryFold({ count, open, onToggle, children }: { count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useT();
  if (!count) return null;
  return (
    <li className="mt-1 rounded-xl bg-base-300/15 p-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] font-medium text-base-content/45 transition-colors hover:bg-base-300/40 hover:text-base-content/70"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron open={open} />
        <span className="flex items-center gap-1">
          <HistoryIcon />
          {t("历史")}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/35">{count}</span>
      </button>
      {open && <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5 opacity-75">{children}</ul>}
    </li>
  );
}

/** 项目组的成员列表：在用节点 + 底部「历史 N」(全收起的派发者节点整个进来) */
export function GroupHistory({ e, hist, team }: { e: GroupEntry; hist: SidebarHistory; team: (n: TeamNode) => ReactNode }) {
  const { e: live, history } = splitGroupHistory(e, hist.now, hist.dispatchers);
  const id = `g:${e.id}`;
  return (
    <>
      {live.nodes.map((n) => team(n))}
      <HistoryFold count={historyCount(history)} open={hist.open.has(id)} onToggle={() => hist.toggle(id)}>
        {history.map((n) => team(n))}
      </HistoryFold>
    </>
  );
}

/**
 * 派发者(PM / 调度器)卡片：render 渲染只剩在用执行者的 TeamGroup，收起的执行者放到它下面的「历史 N」里
 * (缩进 / 导线同 team-group.tsx 的 Kids)。派发者收起时历史行一起藏；在用的一个不剩时 TeamGroup 没有开合箭头，历史行照常显示。
 */
export function HistoryTeam({ node, hist, collapsed, row, render }: {
  node: TeamNode;
  hist: SidebarHistory;
  collapsed: boolean;
  row: (a: AgentSession, slots?: RowSlots) => ReactNode;
  render: (n: TeamNode) => ReactNode;
}) {
  const { node: live, history } = splitTeamHistory(node, hist.now, hist.dispatchers);
  const id = `t:${node.a.name}`;
  return (
    <>
      {render(live)}
      {history.length > 0 && (!collapsed || !live.children.length) && (
        <li>
          <ul className="ml-[13px] flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5">
            <HistoryFold count={history.length} open={hist.open.has(id)} onToggle={() => hist.toggle(id)}>
              {history.map((c) => row(c, { dropProjectId: node.a.projectId ?? null }))}
            </HistoryFold>
          </ul>
        </li>
      )}
    </>
  );
}
