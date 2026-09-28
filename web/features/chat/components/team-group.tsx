"use client";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { directCount, type TeamNode } from "../sidebar-entries";
import { Chevron } from "./project-group";

/**
 * 派发者 + 下挂执行者（树由 sidebar-entries.ts buildTeams 构好，这里只渲染）。执行者缩进一层、带导线，
 * 和 project 组内的缩进同款；派发者那行行首多一个开合箭头（在行按钮外面，点它不进会话）、行尾「派出 N 个」。
 * 折叠状态由调用方按设备记住（use-persisted-set.ts）。
 */

/**
 * AgentRow 的插槽：lead = 行按钮前的独立控件，tail = 名字容器后的小标（下一期的任务阶段小标也放这里）。
 * dropProjectId：拖放「转到 project」的目标。执行者跟着派发者显示在别的组里时按派发者的 project 算（null = 不当放置目标），
 * 否则拖到它上面会进它自己那个看不见的 project。
 */
export interface RowSlots {
  lead?: ReactNode;
  tail?: ReactNode;
  dropProjectId?: string | null;
}
type RenderRow = (a: AgentSession, slots?: RowSlots) => ReactNode;

function TeamToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="-mx-2 grid size-8 shrink-0 place-items-center rounded text-base-content/40 hover:bg-base-300 hover:text-base-content/80 sm:-mx-1 sm:size-5"
      aria-expanded={open}
      aria-label={t(open ? "收起派出的 agent" : "展开派出的 agent")}
      title={t(open ? "收起派出的 agent" : "展开派出的 agent")}
      onClick={onToggle}
    >
      <Chevron open={open} />
    </button>
  );
}

/**
 * 「派出 N」；收起时有执行者在忙就补一个黄点（组头同款），不用展开也知道底下在干活。
 * 窄侧栏里它先于名字缩（shrink-[4]，所在仓小标同款）——两层缩进后名字被挤成「claud…」比小标被截更糟。
 */
function DispatchCount({ n, busy }: { n: number; busy: boolean }) {
  const t = useT();
  return (
    <span className="flex min-w-0 shrink-[4] items-center gap-1 text-[11px] text-base-content/40" title={t("派出 {n} 个", { n })}>
      <span className="truncate">{t("派出 {n}", { n })}</span>
      {busy && <span className="size-1.5 shrink-0 rounded-full bg-warning" />}
    </span>
  );
}

function Kids({ kids, row, dropProjectId }: { kids: AgentSession[]; row: RenderRow; dropProjectId: string | null }) {
  return (
    <li>
      <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5">
        {kids.map((c) => row(c, { dropProjectId }))}
      </ul>
    </li>
  );
}

export function TeamGroup({ node, collapsed, busy, onToggle, row }: {
  node: TeamNode;
  collapsed: boolean;
  /** 有执行者在忙（收起时的黄点） */
  busy: boolean;
  onToggle: () => void;
  row: RenderRow;
}) {
  if (!node.children.length) return <>{row(node.a)}</>;
  return (
    <>
      {row(node.a, {
        lead: <TeamToggle open={!collapsed} onToggle={onToggle} />,
        tail: <DispatchCount n={directCount(node.a.name, node.children)} busy={collapsed && busy} />,
      })}
      {!collapsed && <Kids kids={node.children} row={row} dropProjectId={node.a.projectId ?? null} />}
    </>
  );
}

/** 大总管派出的：挂在顶部大总管卡片下面（卡片本身是个按钮，开合放在卡片下方的一行里） */
export function MasterTeam({ masterName, kids, collapsed, busy, onToggle, row }: {
  masterName: string;
  kids: AgentSession[];
  collapsed: boolean;
  busy: boolean;
  onToggle: () => void;
  row: RenderRow;
}) {
  const t = useT();
  if (!kids.length) return null;
  return (
    <div className="-mt-1 mb-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-base-content/40 transition-colors hover:text-base-content/80"
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? "展开派出的 agent" : "收起派出的 agent")}
        onClick={onToggle}
      >
        <Chevron open={!collapsed} />
        <DispatchCount n={directCount(masterName, kids)} busy={collapsed && busy} />
      </button>
      {!collapsed && <ul className="flex w-full list-none flex-col gap-0.5 p-0"><Kids kids={kids} row={row} dropProjectId={null} /></ul>}
    </div>
  );
}
