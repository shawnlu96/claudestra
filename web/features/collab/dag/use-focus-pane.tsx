"use client";
/**
 * 子 DAG 标签在分区列表（focus-board.tsx）和现有画布之间二选一（team-project-SUBDAG4），use-dag-panes.tsx 只在 center 的 subdag 那一处调它。
 * 列表的条件：有产品 DAG、选中了一个 feature、它有快照、不在对比这个 feature、视图选的是列表。图视图 = 头部 + 原样的画布；其余情况（老 bridge 的
 * 多 feature 画布、版本对比）原样返回画布。看板与 SUBDAG3 共用同一份（use-dag-panes.tsx useBoard），这里不另发请求。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Tr } from "../collab-model";
import type { TeamWorkBoard, WorkBoard } from "../work/work-types";
import type { DagBoard } from "./dag-types";
import { nodeId } from "./dag-layout";
import { FocusBoard, FocusHead } from "./focus-board";
import { focusT } from "./focus-i18n";
import { subdagFocus, type FocusWork } from "./subdag-focus";
import type { useDagUi } from "./use-dag-ui";
import s from "./focus-board.module.css";

interface FocusPaneArgs {
  now: number;
  /** 手机：子 DAG 仍是 MobileDag（use-dag-panes.tsx 的 mobile），列表不渲染，跳转要照画布的跳法展开 feature / ✓N */
  narrow: boolean;
  hot: string | null;
  tr: Tr;
  ui: ReturnType<typeof useDagUi>;
  board: DagBoard | null;
  hasProduct: boolean;
  work: { kind: "local"; board: WorkBoard | null } | { kind: "team"; board: TeamWorkBoard | null };
  onNode: (featureId: string, key: string) => void;
  onVersions: (featureId: string) => void;
  onOwner: (agent: string, taskId: string | null) => void;
}

/** 团队看板的「在等合并」一栏并进在等：subdagFocus 按 working / waiting / todo 三栏找行，合并中的卡要算在等 */
function focusWork(kind: "local" | "team", board: WorkBoard | TeamWorkBoard | null): FocusWork | null {
  if (!board) return null;
  if (kind === "local") return { kind, board: board as WorkBoard };
  const team = board as TeamWorkBoard;
  return { kind, board: { ...team, waiting: [...team.merging, ...team.waiting] } };
}

export function useFocusPane(p: FocusPaneArgs) {
  const { ui, hasProduct } = p;
  const { setListable } = ui;
  const listable = hasProduct && !p.narrow;
  useEffect(() => setListable(listable), [setListable, listable]);
  const feature = hasProduct && ui.featureId ? p.board?.features.find((f) => f.id === ui.featureId) ?? null : null;
  const work = useMemo(() => focusWork(p.work.kind, p.work.board), [p.work.kind, p.work.board]);
  const model = useMemo(() => (feature ? subdagFocus(feature, work, p.now) : null), [feature, work, p.now]);
  const ft = useMemo(() => focusT(p.tr), [p.tr]);
  // 跳转目标只交给列表一次：标签切走再切回（列表重新挂载）不再闪
  const [seen, setSeen] = useState(0);
  const onFlashed = useCallback((seq: number) => setSeen((x) => Math.max(x, seq)), []);
  const prefix = feature ? nodeId(feature.id, "") : null;
  const flash = prefix && ui.flash && ui.flash.seq > seen && ui.flash.id.startsWith(prefix) ? { key: ui.flash.id.slice(prefix.length), seq: ui.flash.seq } : null;
  return function focusPane(canvas: ReactNode): ReactNode {
    if (!feature || !model || ui.compare?.featureId === feature.id) return canvas;
    const shared = { feature, view: ui.view, setView: ui.setView, onVersions: p.onVersions, ft, tr: p.tr };
    if (ui.view === "graph") return <div className={s.pane}><FocusHead {...shared} model={model} />{canvas}</div>;
    return <FocusBoard key={feature.id} {...shared} model={model} now={p.now} hot={p.hot} flash={flash} onFlashed={onFlashed}
      onNode={(key) => p.onNode(feature.id, key)} onOwner={p.onOwner} />;
  };
}
