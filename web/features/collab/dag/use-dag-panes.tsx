"use client";
/**
 * 协作视图里子 DAG 那一块的接线（collab-view.tsx 只调这一个 hook）：同一份 L4 快照出两张图（子 DAG / 进度），中区三个标签，
 * 右区的节点 / 版本 / 差异页，以及手机的分段列表和底部抽屉。快照不可用（老 bridge 404、读失败）或本项目没有任何建了图的 feature
 * 时，第一个标签退回调用方给的因果线画布，手机退回原来的分组列表。
 */
import { useMemo } from "react";
import type { Tr } from "../collab-model";
import { actionLine, type ActionMap } from "../collab-action";
import type { Selection } from "../v4/v4-selection";
import v from "../v4/v4.module.css";
import { ProductPanes } from "../product/product-panes";
import { useProductBoard } from "../product/use-product-board";
import { DagCanvasView } from "./dag-canvas";
import { compareOverlay } from "./dag-diff";
import { drawable, layoutDag, nodeId, type DNode } from "./dag-layout";
import { MobileDag } from "./dag-mobile";
import { ownerOf, progressRows, type AgentLite } from "./dag-progress";
import { WorkBoardView } from "../work/work-board-view";
import { DiffPage, NodePage, VersionsPage } from "./dag-props";
import type { BoardNode, FeatureCard } from "./dag-types";
import { useDagBoard, useDagCompare, useDagVersions } from "./use-dag-board";
import { useDagUi } from "./use-dag-ui";
import d from "./dag.module.css";

const NO_FEATURES: readonly FeatureCard[] = [];

export interface DagPanesArgs {
  project: string;
  rev: number;
  now: number;
  narrow: boolean;
  agents: readonly AgentLite[];
  actions: ActionMap;
  busy: ReadonlyMap<string, boolean | undefined>;
  /** 刚推进的任务 id：全屏唯一的品牌色 */
  hot: string | null;
  sel: Selection;
  select: (s: Selection) => void;
  pickTask: (id: string) => void;
  close: () => void;
  tr: Tr;
}

export function useDagPanes(a: DagPanesArgs) {
  const { tr } = a;
  const load = useDagBoard(a.project, a.rev);
  const product = useProductBoard(a.project, a.rev);
  const board = load.status === "ok" ? load.board : null;
  const features = board?.features ?? NO_FEATURES;
  const graph = drawable(features).length > 0;
  const ui = useDagUi(features);
  const rows = useMemo(() => progressRows(board?.agents ?? [], a.agents, a.project), [board, a.agents, a.project]);
  const cmp = useDagCompare(a.project, ui.compare, board, a.rev);
  const overlay = useMemo(() => (ui.compare && cmp ? compareOverlay(ui.compare.featureId, cmp.toNodes, cmp.fromNodes, cmp.diff) : null), [ui.compare, cmp]);
  const shown = useMemo(() => product && ui.featureId ? features.filter(f => f.id === ui.featureId) : features, [product, ui.featureId, features]);
  const canvas = useMemo(() => layoutDag(shown, ui.open, ui.doneOpen, overlay), [shown, ui.open, ui.doneOpen, overlay]);
  const detail = useDagVersions(a.project, a.sel?.kind === "dver" ? a.sel.f : null, a.rev);

  const featureOf = (id: string) => features.find((f) => f.id === id);
  const selNode = a.sel?.kind === "dnode" ? nodeId(a.sel.f, a.sel.key) : null;
  const actOf = (agent: string) => actionLine(a.actions.get(agent), a.busy.get(agent), null).text;
  const lookOf = (f: string, n: BoardNode) => {
    const owner = ownerOf(rows, f, n);
    const id = nodeId(f, n.key);
    return { owner, act: owner ? actOf(owner.agent) : "", now: a.now, hot: !!a.hot && n.taskId === a.hot, selected: selNode === id, flash: ui.flash?.id === id ? ui.flash.seq : null };
  };
  /** 选中的节点：对比时先在叠图里找（幽灵节点只在那里），再在快照里找 */
  const findNode = (f: string, key: string) =>
    (overlay?.featureId === f ? [...overlay.nodes, ...overlay.ghosts] : featureOf(f)?.nodes ?? []).find((n) => n.key === key) ?? null;
  const onNode = (f: string, key: string) => a.select({ kind: "dnode", f, key });
  // 正在对比的那个框：版本条点开的是差异页（关掉差异页 = 退出对比），否则是版本列表
  const onVersions = (f: string) => a.select(ui.compare?.featureId === f && !a.narrow ? { kind: "ddiff", f } : { kind: "dver", f });

  // 手机上节点详情是整屏遮罩：从详情跳进度要清掉选中（不走 close，它会回到上一张卡的详情），否则行在遮罩底下；桌面属性区在旁边，留着
  const jumpRowFromPage = (agent: string) => {
    if (a.narrow) a.select(null);
    ui.jumpRow(agent);
  };
  const s = a.sel;
  const sf = s && (s.kind === "dnode" || s.kind === "dver" || s.kind === "ddiff") ? featureOf(s.f) : undefined;
  const sn = s?.kind === "dnode" && sf ? findNode(sf.id, s.key) : null;
  const diffPage = s?.kind === "ddiff" && sf && ui.compare?.featureId === sf.id && (
    <DiffPage feature={sf} compare={ui.compare} data={cmp} onVersions={() => a.select({ kind: "dver", f: sf.id })} tr={tr} onClose={() => {
      ui.setCompare(null);
      a.close();
    }} />
  );
  const page = (sn && sf && (
    <NodePage feature={sf} node={sn} owner={ownerOf(rows, sf.id, sn)} mark={overlay?.featureId === sf.id ? overlay.marks.get(sn.key) ?? null : null} now={a.now}
      onTask={a.pickTask} onOwner={jumpRowFromPage} onNode={(k) => onNode(sf.id, k)} onClose={a.close} tr={tr} />
  )) || (s?.kind === "dver" && sf && (
    <VersionsPage key={sf.id} feature={sf} detail={detail} compare={ui.compare} onClose={a.close} tr={tr} onCompare={(c) => {
      ui.setCompare(c);
      a.select({ kind: "ddiff", f: c.featureId });
    }} />
  )) || (!a.narrow && diffPage) || null;

  const progress = (
    <WorkBoardView project={a.project} onNode={ui.jumpNode} onTask={a.pickTask} tr={tr} />
  );
  const shelf = drawable(shown).filter((f) => !ui.open.includes(f.id));
  const dagCanvas = (
    <DagCanvasView canvas={canvas} shelf={shelf} evicted={ui.evicted} look={(n: DNode) => lookOf(n.featureId, n.node)} compare={ui.compare} focus={ui.focus}
      onNode={onNode} onOwner={ui.jumpRow} onFold={ui.toggleDone} onFeature={ui.toggleFeature} onVersions={onVersions} onBackground={() => a.select(null)} tr={tr} />
  );

  const paneProps = { board: product, featureId: ui.featureId, tab: ui.tab, setTab: ui.setTab, onFeature: ui.selectFeature,
    onTask: a.pickTask, graph, now: a.now, tr, progress };
  const center = (causal: React.ReactNode, team: React.ReactNode) => (
    <ProductPanes {...paneProps} narrow={false} team={team} subdag={dagCanvas} fallback={load.status === "loading" ? <div className={v.canvas} /> : causal} />
  );

  const mobile = (fallback: React.ReactNode) => (
    <>
      <ProductPanes {...paneProps} narrow={true} fallback={fallback} subdag={
        <MobileDag features={drawable(shown)} open={ui.open} doneOpen={ui.doneOpen} look={(f, n) => lookOf(f.id, n)}
          onFeature={ui.toggleFeature} onFold={ui.toggleDone} onVersions={onVersions} onNode={onNode} onOwner={ui.jumpRow} tr={tr} />
      } />
      {a.narrow && diffPage && <div className={d.backdrop} onClick={(e) => e.target === e.currentTarget && a.close()}><div className={d.drawer}>{diffPage}</div></div>}
    </>
  );

  return { center, mobile, page };
}
