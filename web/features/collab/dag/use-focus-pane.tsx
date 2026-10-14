"use client";
/**
 * 子 DAG 复用 FocusBoard：桌面在分区列表和现有画布间切换，手机始终单列；use-dag-panes.tsx 的 center / mobile 共用同一模型。
 * 列表的条件：有产品 DAG、选中了一个 feature、它有快照、不在对比这个 feature、视图选的是列表。图视图 = 头部 + 原样的画布；其余情况（老 bridge 的
 * 多 feature 画布、版本对比）原样返回画布。手机缺产品 DAG / feature 快照时返回 MobileDag；与 useBoard 共用看板，不另发请求。
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
  /** 手机仍报告画布跳法，确保没有产品快照时 MobileDag 兜底也能展开跳转目标；FocusBoard 消费同一份 flash */
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
  function render(canvas: ReactNode, narrow = false): ReactNode {
    if (!feature || !model || (!narrow && ui.compare?.featureId === feature.id)) return canvas;
    const shared = { feature, view: ui.view, setView: ui.setView, onVersions: p.onVersions, ft, tr: p.tr };
    if (!narrow && ui.view === "graph") return <div className={s.pane}><FocusHead {...shared} model={model} />{canvas}</div>;
    return <FocusBoard key={feature.id} {...shared} narrow={narrow} model={model} now={p.now} hot={p.hot} flash={flash} onFlashed={onFlashed}
      onNode={(key) => p.onNode(feature.id, key)} onOwner={p.onOwner} />;
  }
  return Object.assign((canvas: ReactNode) => render(canvas), { narrow: (fallback: ReactNode) => render(fallback, true) });
}
