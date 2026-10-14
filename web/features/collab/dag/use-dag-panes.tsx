"use client";
/**
 * 协作视图里子 DAG 那一块的接线（collab-view.tsx 只调这一个 hook）：同一份 L4 快照出两张图（子 DAG / 进度），中区三个标签，
 * 右区的节点 / 版本 / 差异页，以及手机的分段列表和底部抽屉。快照不可用（老 bridge 404、读失败）或本项目没有任何建了图的 feature
 * 时，第一个标签退回调用方给的因果线画布，手机退回原来的分组列表。
 * 「谁在干活」的看板也在这里读一份（本机 /work；团队 = 团队看板 + 主场本机行的本机看板），标签和全站计数（count-words.ts）共用；
 * 计数状态 counts 返回给顶栏 / 大纲 / 右栏，并经 CountContext 递给产品卡与子 DAG 框头。
 */
import { useCollabNav } from "../collab-nav";
import { useNodeCardOwner } from "./node-card-navigation";
import { nodeCard, nodeTask } from "./node-card-model";
import { NodeCardSection } from "./node-card-section";
import { useMemo } from "react";
import type { Tr } from "../collab-model";
import { actionLine, type ActionMap } from "../collab-action";
import type { Selection } from "../v4/v4-selection";
import v from "../v4/v4.module.css";
import { ProductPanes } from "../product/product-panes";
import { useProductBoard } from "../product/use-product-board";
import { DagCanvasView } from "./dag-canvas";
import { compareOverlay } from "./dag-diff";
import { drawable, layoutDag, nodeId, type DagCanvas, type DNode } from "./dag-layout";
import { MobileDag } from "./dag-mobile";
import { ownerOf, progressRows, type AgentLite } from "./dag-progress";
import { WorkBoardContent } from "../work/work-board-view";
import { useTeamWorkBoard, useWorkBoard } from "../work/use-work-board";
import { countBoardOf } from "../count-words";
import { CountContext, useCountState, useRoundFresh, type CountInput } from "../use-count-source";
import { teamWorkBoard } from "../team-work-model";
import type { TeamWorkBoard, WorkBoard } from "../work/work-types";
import type { LedgerOverview } from "../collab-model";
import { DiffPage, NodePage, VersionsPage } from "./dag-props";
import type { BoardNode, DagBoard, FeatureCard } from "./dag-types";
import { useDagBoard, useDagCompare, useDagVersions } from "./use-dag-board";
import { useDagUi } from "./use-dag-ui";
import { useFocusPane, type DrawCanvas } from "./use-focus-pane";
import { useFocusFeature } from "../team-source-context";
import d from "./dag.module.css";

const NO_FEATURES: readonly FeatureCard[] = [];
/** 谁在干活标签、计数与子 DAG 共用的那一份看板；团队版也带 retrying（主场本机行读本机 /work 失败时标签出重试图标） */
type PaneWork = { kind: "local"; board: WorkBoard | null; retrying: boolean } | { kind: "team"; board: TeamWorkBoard | null; retrying: boolean };

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
  /** 团队视图：不读本机 /work 看板，改由已加载的团队总览 + 子 DAG 转出看板；有主场在本机的卡才另读本机 /work（use-work-board.ts useTeamWorkBoard） */
  noWorkBoard?: boolean;
  /** 总览（计数的已完成与卡阶段；noWorkBoard 时也是 team-work-model.ts 的输入）；还没读到为 null */
  ov?: LedgerOverview | null;
  /** 团队源的 last()：判断列表里的 feature 是不是都拉到了详情（use-count-source.ts） */
  source?: CountInput["source"];
}

/** 看板（谁在干活）读一份：本机 = /work；团队 = 团队数据转出的看板，主场本机的行换本机事实（只在有这种行时读本机 /work） */
function useBoard(a: DagPanesArgs, board: DagBoard | null, dagLoading: boolean, dagFresh: boolean) {
  // 用走表的 a.now，主场停推时新鲜度照样随时间重判
  const teamRaw = useMemo(() => (a.noWorkBoard && a.ov && !dagLoading ? teamWorkBoard(board, a.ov, a.now) : null), [a.noWorkBoard, a.ov, a.now, board, dagLoading]);
  const team = useTeamWorkBoard(a.project, teamRaw);
  const local = useWorkBoard(a.noWorkBoard ? null : a.project);
  const shown = a.noWorkBoard ? team : { ...local, pending: false };
  const counted = useMemo(() => (shown.board ? countBoardOf(shown.board, !!a.noWorkBoard) : null), [shown.board, a.noWorkBoard]);
  // 团队：快照还是上一轮的就算看板没到齐（首次出数要总览、详情、快照同一轮，之后补拉不再跳）
  const pending = shown.pending || (!!a.noWorkBoard && !dagFresh);
  const counts = useCountState({ project: a.project, ov: a.ov ?? null, board: counted, boardPending: pending, boardFailed: !a.noWorkBoard && local.retrying && !local.board,
    source: a.source ?? {} });
  const work: PaneWork = a.noWorkBoard ? { kind: "team", board: team.board, retrying: team.retrying } : { kind: "local", board: local.board, retrying: local.retrying };
  return { work, counts };
}

export function useDagPanes(a: DagPanesArgs) {
  const { tr } = a;
  const load = useDagBoard(a.project, a.rev);
  const product = useProductBoard(a.project, a.rev);
  const board = load.status === "ok" ? load.board : null;
  const features = board?.features ?? NO_FEATURES;
  const { task } = useCollabNav();
  const binding = nodeCard(features, task);
  const graph = drawable(features).length > 0;
  const ui = useDagUi(features);
  useFocusFeature(a.project, ui.featureId);
  const rows = useMemo(() => progressRows(board?.agents ?? [], a.agents, a.project), [board, a.agents, a.project]);
  const cmp = useDagCompare(a.project, ui.compare, board, a.rev);
  const overlay = useMemo(() => (ui.compare && cmp ? compareOverlay(ui.compare.featureId, cmp.toNodes, cmp.fromNodes, cmp.diff) : null), [ui.compare, cmp]);
  const hasProduct = product.status === "ok";
  const shown = useMemo(() => hasProduct && ui.featureId ? features.filter(f => f.id === ui.featureId) : features, [hasProduct, ui.featureId, features]);
  const canvas = useMemo(() => layoutDag(shown, ui.open, ui.doneOpen, overlay, ui.donePages), [shown, ui.open, ui.doneOpen, overlay, ui.donePages]);
  const detail = useDagVersions(a.project, a.sel?.kind === "dver" ? a.sel.f : null, a.rev);
  const featureOf = (id: string) => features.find((f) => f.id === id);
  const selNode = !ui.compare && binding ? nodeId(binding.feature.id, binding.node.key) : a.sel?.kind === "dnode" ? nodeId(a.sel.f, a.sel.key) : null;
  const actOf = (agent: string) => actionLine(a.actions.get(agent), a.busy.get(agent), null).text;
  const lookOf = (f: string, n: BoardNode) => {
    const owner = ownerOf(rows, f, n);
    const id = nodeId(f, n.key);
    return { owner, act: owner ? actOf(owner.agent) : "", now: a.now, hot: !!a.hot && n.taskId === a.hot, selected: selNode === id, flash: ui.flash?.id === id ? ui.flash.seq : null };
  };
  const findNode = (f: string, key: string) =>
    (overlay?.featureId === f ? [...overlay.nodes, ...overlay.ghosts] : featureOf(f)?.nodes ?? []).find((n) => n.key === key) ?? null;
  const onNode = (f: string, key: string) => {
    const id = nodeTask(featureOf(f), key, a.ov?.tasks ?? [], !!ui.compare);
    if (id) a.pickTask(id); else a.select({ kind: "dnode", f, key });
  };
  // 正在对比的那个框：版本条点开的是差异页（关掉差异页 = 退出对比），否则是版本列表
  const onVersions = (f: string) => a.select(ui.compare?.featureId === f && !a.narrow ? { kind: "ddiff", f } : { kind: "dver", f });
  const jumpRowFromPage = useNodeCardOwner(a.narrow, task, a.select, ui.jumpRow, ui.tab === "progress");
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
      planned={ !ui.compare && !sn.taskId && !sn.missing && sf.nodes.includes(sn) && !(overlay?.featureId === sf.id && overlay.marks.get(sn.key)?.ghost) }
      onTask={a.pickTask} onOwner={jumpRowFromPage} onNode={(k) => onNode(sf.id, k)} onClose={a.close} tr={tr} />
  )) || (s?.kind === "dver" && sf && (
    <VersionsPage key={sf.id} feature={sf} detail={detail} compare={ui.compare} onClose={a.close} tr={tr} onCompare={(c) => {
      ui.setCompare(c);
      a.select({ kind: "ddiff", f: c.featureId });
    }} />
  )) || (!a.narrow && diffPage) || null;
  // useDagBoard 在 rev 变后重拉期间留着上一轮的快照：团队看板由总览 + 快照合成，不同轮就先按旧快照出数、新快照到了再跳
  const dagFresh = useRoundFresh(load, load.status !== "loading", a.rev);
  const { work, counts } = useBoard(a, board, load.status === "loading", dagFresh);
  const progress = <WorkBoardContent team={work.kind === "team"} board={work.board} retrying={work.retrying} loading={counts.status === "loading"}
    onNode={ui.jumpNode} onTask={a.pickTask} tr={tr} />;
  const shelf = drawable(shown).filter((f) => !ui.open.includes(f.id));
  const drawCanvas: DrawCanvas = (c: DagCanvas, onFold, sh = shelf) => (
    <DagCanvasView canvas={c} shelf={sh} evicted={ui.evicted} look={(n: DNode) => lookOf(n.featureId, n.node)} compare={ui.compare} focus={ui.focus}
      onNode={onNode} onOwner={ui.jumpRow} onFold={onFold} onFeature={ui.toggleFeature} onVersions={onVersions} onBackground={() => a.select(null)} tr={tr} />
  );
  const focusPane = useFocusPane({ now: a.now, narrow: a.narrow, hot: a.hot, tr, ui, board, hasProduct, work, onNode, onVersions, onOwner: jumpRowFromPage });
  const paneProps = { board: hasProduct ? product.board : null, loading: product.status === "loading", featureId: ui.featureId, tab: ui.tab, setTab: ui.setTab, onFeature: ui.selectFeature,
    onTask: a.pickTask, graph, dagBoard: board, now: a.now, tr, progress };
  const center = (causal: React.ReactNode, team: React.ReactNode) => (
    <CountContext.Provider value={counts}>
      <ProductPanes {...paneProps} narrow={false} team={team} subdag={focusPane(canvas, drawCanvas)} fallback={<div className={v.center}>{causal}</div>} />
    </CountContext.Provider>
  );
  const mobile = (fallback: React.ReactNode) => (
    <CountContext.Provider value={counts}>
      <ProductPanes {...paneProps} narrow={true} fallback={fallback} subdag={focusPane.narrow(
        <MobileDag features={drawable(shown)} open={ui.open} doneOpen={ui.doneOpen} look={(f, n) => lookOf(f.id, n)}
          onFeature={ui.toggleFeature} onFold={ui.toggleDone} onVersions={onVersions} onNode={onNode} onOwner={ui.jumpRow} tr={tr} />
      )} />
      {a.narrow && diffPage && <div className={d.backdrop} onClick={(e) => e.target === e.currentTarget && a.close()}><div className={d.drawer}>{diffPage}</div></div>}
    </CountContext.Provider>
  );
  const nodeSec = (id: string) => {
    const card = nodeCard(features, id);
    return card && <NodeCardSection card={card} owner={ownerOf(rows, card.feature.id, card.node)}
      onOwner={agent => jumpRowFromPage(agent, card.node.taskId)} onNode={key => onNode(card.feature.id, key)} tr={tr} />;
  };
  return { center, mobile, page, nodeSec, counts };
}
