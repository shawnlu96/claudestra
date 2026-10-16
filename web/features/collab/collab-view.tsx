"use client";
/**
 * 协作视图 v4（docs/team/collab-view-v4.md）：页头下四个标签「总览 / 项目地图 / 模块进度 / 团队」，桌面手机同一套
 * （接线在 dag/use-dag-panes.tsx，标签条 project-tabs/project-tabs.tsx，总览 project-tabs/overview-tab.tsx）。
 * 详情（任务 = 任务详情 + 它的因果线，边 / 折叠组 / 成员 / 节点 / 版本 / 差异各一页）桌面从右侧抽屉滑入（project-tabs/task-drawer.tsx），手机整屏。
 * 底部时间轴放第二期。计数口径在 count-words.ts（看板模型）。
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDagPanes } from "./dag/use-dag-panes";
import { useCollabT } from "./collab-i18n";
import { useChatStore } from "../chat/chat-store";
import { actionLine } from "./collab-action";
import { CollabDetail, useNarrow } from "./collab-detail";
import { useSheetHistory } from "./v4/sheet-history";
import { browserHistory } from "@/lib/hash-nav-browser";
import type { WebAsk } from "../asks/asks-model";
import { useAsks } from "../asks/asks-store";
import { homeView, type LineView } from "./collab-model";
import { openCollabTask, useCollabNav } from "./collab-nav";
import { useCollab } from "./use-collab";
import { ownerWaits, subscribeViewBinding, viewLocalProject, type AsksRead } from "./owner-waits";
import { cachedOverview } from "./collab-cache";
import { applyReviewers, reviewersByTask, type RunningReviewer } from "./collab-reviewers";
import { sinceDigest } from "./collab-since";
import { SinceCard } from "./collab-since-card";
import { useLastSeen } from "./use-collab-extra";
import { causalCanvas } from "./v4/causal-model";
import { CausalCanvas } from "./v4/causal-canvas";
import type { Focus } from "./v4/canvas-view";
import { edgeSel, memberSel, narrowPane, resolveSelection, type Selection } from "./v4/v4-selection";
import { MobileList } from "./v4/v4-mobile";
import { PaneLayout } from "./v4/side-pane";
import { CauseSec, EdgePage, FoldPage, MemberPage, TeamFactsSec } from "./v4/v4-props";
import { Overview } from "./project-tabs/overview-tab";
import { TaskDrawer } from "./project-tabs/task-drawer";
import { TeamPanel } from "./team-panel";
import { CollabPageHead, HEAD_WRAP } from "./collab-page-head";
import { CollabTitle, LoadState } from "./collab-load-state";
import { useExecCollab } from "./shared/exec/exec-entry";
import s from "./collab.module.css";
import v from "./v4/v4.module.css";

/** 模块级稳定引用：详情里的 effect 依赖它，每次渲染换新函数会白跑 */
const closeTask = () => openCollabTask(null);
const NO_REVIEWERS: readonly RunningReviewer[] = [];

/**
 * 选中与居中：任务走 openCollabTask（右侧 / 全屏详情），其余存稳定键（v4-selection.ts）；只有明确点了任务才发 Focus 让画布居中。
 * 从任务详情点进边 / 折叠组的，关掉回到那个任务（手机上不然就直接掉回列表）；从团队整屏点进成员的，关掉回到团队
 */
function useSelection(openTask: string | null) {
  const [sel, setSel] = useState<Selection>(null);
  const [back, setBack] = useState<string | null>(null);
  const [backSel, setBackSel] = useState<Selection>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const pickTask = (id: string) => {
    setSel(null);
    setBack(null);
    setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }));
    openCollabTask(id);
  };
  const select = (x: Selection) => {
    if (x?.kind === "task") return pickTask(x.id);
    setBack(x && x.kind !== "waits" && x.kind !== "team" && x.kind !== "attention" ? openTask : null);
    setBackSel(x?.kind === "member" && sel?.kind === "team" ? sel : null);
    openCollabTask(null);
    setSel(x);
  };
  const close = () => {
    setSel(backSel);
    setBackSel(null);
    setBack(null);
    if (back) openCollabTask(back);
  };
  return { sel, setSel, focus, pickTask, select, close };
}

/** useSelection + 手机整屏页的历史条目（v4/sheet-history.ts）：select 在整屏页出现之前先压历史 */
function useSheetSelection(openTask: string | null, narrow: boolean) {
  const s = useSelection(openTask);
  const prepare = useSheetHistory(!!s.sel && s.sel.kind !== "task" && !openTask, narrow, `~${s.sel?.kind ?? ""}`, s.close, browserHistory);
  const select = (x: Selection) => {
    if (x && x.kind !== "task" && !openTask) prepare(`~${x.kind}`);
    s.select(x);
  };
  return { ...s, select };
}

/** 待你处理（口径在 owner-waits.ts）：团队键视图订本机绑定，解析出本机项目后才数得到；解析不出 = unknown，总览写读不到 */
function useOwnerWaits(asks: readonly WebAsk[], project: string, list: AsksRead) {
  const sub = useCallback((cb: () => void) => subscribeViewBinding(project, cb), [project]);
  const read = useCallback(() => viewLocalProject(project), [project]);
  const local = useSyncExternalStore(sub, read, read);
  const { loaded, full } = list;
  return useMemo(() => ownerWaits(asks, project, local, { loaded, full }), [asks, project, local, loaded, full]);
}

export function CollabView({ project }: { project: string }) {
  const tr = useCollabT();
  const narrow = useNarrow();
  const { task: openTask } = useCollabNav();
  const agents = useChatStore((st) => st.state.agents);
  const projects = useChatStore((st) => st.state.projects);
  // 本项目的 agent：registry 里归这个项目的，加上台账任务挂着的执行者 / PM（缓存的总览里有）
  const members = useMemo(() => {
    const set = new Set(agents.filter((a) => a.projectId === project).map((a) => a.name));
    for (const t of cachedOverview(project)?.ov.tasks ?? []) for (const n of [t.agent, t.pm]) if (n) set.add(n.replace(/^agent-/, ""));
    return set;
  }, [agents, project]);
  const { load, now, actions, connected, rev, advance, refetch, reviewers, source } = useExecCollab(useCollab(project, members), project);
  const busy = useMemo(() => new Map(agents.map((a) => [a.name, a.busy])), [agents]);
  const off = source.unavailable;
  const lastSeen = useLastSeen(project, off?.has("lastSeen"));
  const ov = load.status === "ok" ? load.ov : null;
  const { asks, open: inboxOpen, loaded: asksLoaded, full: asksFull } = useAsks();
  const { waits, unknown: waitsUnknown } = useOwnerWaits(asks, project, { loaded: asksLoaded, full: asksFull });
  const byTask = useMemo(() => reviewersByTask(reviewers), [reviewers]);
  const view = useMemo(() => {
    if (!ov) return null;
    const hv = homeView(ov, now, tr, waits);
    return { ...hv, ...applyReviewers(hv, byTask, tr) };
  }, [ov, now, tr, waits, byTask]);
  const lines = useMemo(() => new Map((view?.lines ?? []).map((l) => [l.id, l])), [view]);
  const digest = useMemo(() => sinceDigest(lastSeen.state.events, ov?.tasks ?? [], tr), [lastSeen.state.events, ov, tr]);
  const canvas = useMemo(() => causalCanvas(ov ?? { tasks: [], items: [], deps: [] }), [ov]);
  const { sel, setSel, focus, pickTask, select, close } = useSheetSelection(openTask, narrow);
  const dag = useDagPanes({ project, rev, now, narrow, agents, actions, busy, hot: advance?.id ?? null, sel, select, pickTask, close, tr, noWorkBoard: off?.has("workBoard"), ov, source });
  const projectName = source.label ?? (projects.find((p) => p.id === project)?.name || project);

  const lineAction = (l: LineView) => {
    const waitLabel = l.attention === "waiting" || l.attention === "stuck" ? l.stageLabel : null;
    return l.agent ? actionLine(actions.get(l.agent), busy.get(l.agent), waitLabel) : { kind: "idle" as const, text: "" };
  };
  const actionText = (id: string) => {
    const l = lines.get(id);
    return l ? lineAction(l).text : "";
  };

  if (load.status !== "ok" || !ov!.exists || ((ov?.tasks?.length ?? 0) === 0 && !source.ops)) return <LoadState load={load} projectName={projectName} refetch={refetch} tr={tr} />;

  const o = ov!, hv = view!;
  const resolved = resolveSelection(sel, o, canvas);
  if (sel && sel.kind !== "task" && !resolved) setSel(null); // 边 / 折叠组在这次刷新里没了：清掉，抽屉收起
  const pane = narrowPane(openTask, resolved);
  const team = <TeamPanel embedded unavailable={off?.has("teamPanel")} ov={o} project={project} agents={agents} now={now}
    ops={source.ops?.(null, now)} selected={sel?.kind === "member" ? sel.id : null} onSelect={(n) => select(memberSel(n))} />;
  const detail = openTask && (
    <CollabDetail project={project} id={openTask} rev={rev} now={now} ov={o} line={lines.get(openTask) ?? null} onClose={closeTask}
      action={(l) => lineAction(l)} actions={actions} reviewers={byTask.get(openTask) ?? NO_REVIEWERS} work={dag.workFacts(openTask)} extra={<>{dag.nodeSec(openTask)}{source.ops?.(openTask, now)}
        <TeamFactsSec project={project} id={openTask} ov={o} now={now} tr={tr} /><CauseSec id={openTask} deps={o.deps ?? []} onEdge={(dep) => select(edgeSel([dep]))} tr={tr} /></>} />
  );
  const page = dag.page || (resolved?.kind === "edge" && <EdgePage deps={resolved.deps} ov={o} onPick={pickTask} onClose={close} tr={tr} />)
    || (resolved?.kind === "fold" && <FoldPage fold={resolved.fold} ov={o} onPick={pickTask} onClose={close} tr={tr} />)
    || (resolved?.kind === "member" && <MemberPage m={resolved} project={project} onClose={close} tr={tr} />);
  const overview = <Overview project={project} ov={o} view={hv} counts={dag.counts} waits={waits} waitsUnknown={waitsUnknown} projectName={projectName} onPick={pickTask}
    now={now} tr={tr} since={lastSeen.state.since !== null && (
    <SinceCard digest={digest} since={lastSeen.state.since} truncated={lastSeen.state.truncated} now={now} tr={tr} onOpen={pickTask} onDismiss={lastSeen.dismiss} />
  )} />;

  return (
    <div className={`${s.tokens} ${s.root} ${v.v4}`}>
      <div className={v.top} style={narrow ? HEAD_WRAP : undefined}>
        <CollabTitle tr={tr}><CollabPageHead name={projectName} ov={o} now={now} tr={tr} /></CollabTitle>
        <span className={`${s.live} ${connected ? "" : s.off}`} style={{ marginLeft: "auto" }} title={tr(connected ? "实时" : "重连中")} />
      </div>
      {load.error && <div role="status" className={s.retry}><span>{tr("没取到，正在重试")}</span>
        <button type="button" className={s.ib} onClick={() => void refetch()}>{tr("重试")}</button>
      </div>}
      {narrow ? (
        <>
          {dag.tabs({ overview, team, fallback: <MobileList project={project} ov={o} lines={lines} todayDone={hv.todayDone} now={now} actionText={actionText} onPick={pickTask} tr={tr} /> })}
          {pane === "detail" && detail}
          {/* 全站收件箱开着时先收起整屏页：它的层级在抽屉之上，不收就把抽屉整个盖住（「去处理」点了像没反应）。选中与历史条目不动，从收件箱返回还在这一页 */}
          {pane !== "detail" && page && !inboxOpen && createPortal(<div className={`${s.tokens} ${v.sheet} ${s.full}`}>{page}</div>, document.body)}
        </>
      ) : (
        <PaneLayout drawer={<TaskDrawer open={!!(detail || page)} onClose={detail ? closeTask : dag.closePage} esc={!detail} label={tr("详情")}>{detail || page}</TaskDrawer>}>
          {dag.tabs({ overview, team, fallback: <CausalCanvas canvas={canvas} lines={lines} actionText={actionText} hot={advance?.id ?? null}
            selection={openTask ? { kind: "task", id: openTask } : sel} focus={focus} onSelect={select} tr={tr} /> })}
        </PaneLayout>
      )}
    </div>
  );
}
