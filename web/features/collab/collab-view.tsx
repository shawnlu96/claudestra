"use client";
/**
 * 协作视图 v4（docs/team/collab-view-v4.md）：顶上指标条；左大纲（待你处理、筛选、事项 → 任务）；中间画布两个标签——
 * 「因果线」（v4/causal-canvas.tsx，布局在 v4/causal-model.ts）和「团队」（T55 的组件，合并前是占位）；右属性（没选中 = 项目概览，
 * 任务 = 任务详情 + 它的因果线，边 / 折叠组 / 待你处理各一页）。手机没有画布：分组卡片，点开是全屏详情。
 * 底部时间轴放第二期。数据只用总览（tasks / items / deps）和任务详情，没有来源的指标标「暂无」。
 */
import { useMemo, useState } from "react";
import { useCollabT } from "./collab-i18n";
import { useChatStore } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { actionLine } from "./collab-action";
import { CollabDetail, useNarrow } from "./collab-detail";
import { Icon } from "./collab-icons";
import { waitsOnOwner } from "../asks/asks-model";
import { useAsks } from "../asks/asks-store";
import { fmtDuration, homeView, type LineView, type Tr } from "./collab-model";
import { openCollabTask, useCollabNav } from "./collab-nav";
import { useCollab } from "./use-collab";
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
import { Outline } from "./v4/v4-outline";
import { CauseSec, EdgePage, FoldPage, MemberPage, Overview, TeamPage, WaitsPage } from "./v4/v4-props";
import { TeamPanel } from "./team-panel";
import { metricsOf, type Filter, type Metrics } from "./v4/v4-model";
import s from "./collab.module.css";
import v from "./v4/v4.module.css";

/** 模块级稳定引用：详情里的 effect 依赖它，每次渲染换新函数会白跑 */
const closeTask = () => openCollabTask(null);
const NO_REVIEWERS: readonly RunningReviewer[] = [];

function Empty({ icon, title, children }: { icon: "listTree" | "clock" | "circleCheck"; title: string; children?: React.ReactNode }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIc}>
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function MetricsBar({ m, connected, tr }: { m: Metrics; connected: boolean; tr: Tr }) {
  const cells: [string, string, string?][] = [
    ["在场 agent", String(m.present)], ["进行中", String(m.active)], ["今日完成", String(m.todayDone)], ["审查轮次", String(m.reviewRounds)],
    ["P0/P1 修掉", String(m.fixed)], ["平均等复核", m.avgReviewWaitMs === null ? "—" : fmtDuration(m.avgReviewWaitMs, tr)],
    ["周额度", "—", "暂无数据来源"], ["协作消息", "—", "暂无数据来源"],
  ];
  return (
    <div className={v.metrics}>
      {cells.map(([k, val, hint]) => (
        <span key={k} className={v.metric} title={hint ? tr(hint) : undefined}>
          <b>{val}</b>
          <span>{tr(k)}</span>
        </span>
      ))}
      <span className={`${s.live} ${connected ? "" : s.off}`} title={tr(connected ? "实时" : "重连中")} />
    </div>
  );
}

/** 台账没读到 / 没权限 / 读失败 / 还没有任务时整页一个空状态 */
function LoadState({ load, refetch, tr }: { load: ReturnType<typeof useCollab>["load"]; refetch: () => void | Promise<void>; tr: Tr }) {
  let body: React.ReactNode;
  if (load.status === "loading") body = <Empty icon="clock" title={tr("正在读取台账…")} />;
  else if (load.status === "forbidden") body = <Empty icon="listTree" title={tr("这台设备没有读台账的权限")}>{tr("需要全部 agent 范围、带管理权限的设备。")}</Empty>;
  else if (load.status === "error")
    body = (
      <Empty icon="listTree" title={tr("读台账失败")}>
        <div>{load.message}</div>
        <button type="button" className={s.ib} style={{ marginTop: 12 }} onClick={() => void refetch()}>{tr("重试")}</button>
      </Empty>
    );
  else
    body = (
      <Empty icon="listTree" title={tr("这个项目还没有台账")}>
        {tr("PM 派发任务后，这里会按关注度列出每条任务线。已有旧台账可以导入：")}
        <div style={{ marginTop: 8 }}><code>bun src/manager.ts ledger import &lt;ledger.json&gt; --map &lt;map.json&gt;</code></div>
      </Empty>
    );
  return <div className={`${s.tokens} ${s.root}`}><div className={s.home}>{body}</div></div>;
}

/** 中区：「因果线」画布和「团队」（T55 的 TeamPanel，嵌入模式：选中成员交给右侧属性页）两个标签 */
function CenterPane({ team, ...props }: React.ComponentProps<typeof CausalCanvas> & { team: React.ReactNode }) {
  const [tab, setTab] = useState<"causal" | "team">("causal");
  const { tr } = props;
  return (
    <div className={v.center}>
      <div className={v.tabs} role="tablist">
        {(["causal", "team"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`${v.tab} ${tab === k ? v.tabOn : ""}`} onClick={() => setTab(k)}>
            {tr(k === "causal" ? "因果线" : "团队")}
          </button>
        ))}
      </div>
      {tab === "causal" ? <CausalCanvas {...props} /> : <div className={v.teamPane}>{team}</div>}
    </div>
  );
}

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
    setBack(x && x.kind !== "waits" && x.kind !== "team" ? openTask : null);
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

export function CollabView({ project }: { project: string }) {
  const tr = useCollabT();
  const nav = useChatNav();
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
  const { load, now, actions, connected, rev, advance, refetch, reviewers } = useCollab(project, members);
  const busy = useMemo(() => new Map(agents.map((a) => [a.name, a.busy])), [agents]);
  const lastSeen = useLastSeen(project);
  const ov = load.status === "ok" ? load.ov : null;
  const { asks } = useAsks();
  const waits = useMemo(() => asks.filter((a) => a.project === project && waitsOnOwner(a)), [asks, project]);
  const byTask = useMemo(() => reviewersByTask(reviewers), [reviewers]);
  const view = useMemo(() => {
    if (!ov) return null;
    const hv = homeView(ov, now, tr, waits);
    return { ...hv, ...applyReviewers(hv, byTask, tr) };
  }, [ov, now, tr, waits, byTask]);
  const lines = useMemo(() => new Map((view?.lines ?? []).map((l) => [l.id, l])), [view]);
  const digest = useMemo(() => sinceDigest(lastSeen.state.events, ov?.tasks ?? [], tr), [lastSeen.state.events, ov, tr]);
  const canvas = useMemo(() => causalCanvas(ov ?? { tasks: [], items: [], deps: [] }), [ov]);
  const [filter, setFilter] = useState<Filter>("all");
  const { sel, setSel, focus, pickTask, select, close } = useSelection(openTask);
  const projectName = projects.find((p) => p.id === project)?.name || project;

  const lineAction = (l: LineView) => {
    const waitLabel = l.attention === "waiting" || l.attention === "stuck" ? l.stageLabel : null;
    return l.agent ? actionLine(actions.get(l.agent), busy.get(l.agent), waitLabel) : { kind: "idle" as const, text: "" };
  };
  const actionText = (id: string) => {
    const l = lines.get(id);
    return l ? lineAction(l).text : "";
  };

  if (load.status !== "ok" || !ov!.exists || ov!.tasks.length === 0) return <LoadState load={load} refetch={refetch} tr={tr} />;

  const o = ov!, hv = view!;
  const m = metricsOf(o, hv.todayDone.length, agents.filter((a) => members.has(a.name) && a.status === "active").length);
  const resolved = resolveSelection(sel, o, canvas);
  if (sel && sel.kind !== "task" && !resolved) setSel(null); // 边 / 折叠组在这次刷新里没了：清掉，属性页回概览
  const pane = narrowPane(openTask, resolved);
  const team = <TeamPanel embedded ov={o} project={project} agents={agents} now={o.now} selected={sel?.kind === "member" ? sel.id : null}
    onSelect={(n) => select(memberSel(n))} />;
  const detail = openTask && (
    <CollabDetail project={project} id={openTask} rev={rev} now={now} ov={o} line={lines.get(openTask) ?? null}
      action={(l) => lineAction(l)} actions={actions} reviewers={byTask.get(openTask) ?? NO_REVIEWERS} onClose={closeTask}
      extra={<CauseSec id={openTask} deps={o.deps ?? []} onEdge={(dep) => select(edgeSel([dep]))} tr={tr} />} />
  );
  const page = (resolved?.kind === "edge" && <EdgePage deps={resolved.deps} ov={o} onPick={pickTask} onClose={close} tr={tr} />)
    || (resolved?.kind === "fold" && <FoldPage fold={resolved.fold} ov={o} onPick={pickTask} onClose={close} tr={tr} />)
    || (resolved?.kind === "waits" && <WaitsPage waits={waits} ov={o} onPick={pickTask} onClose={close} tr={tr} />)
    || (resolved?.kind === "member" && <MemberPage m={resolved} project={project} onClose={close} tr={tr} />)
    || (resolved?.kind === "team" && <TeamPage onClose={close} tr={tr}>{team}</TeamPage>);
  const right = detail || page || <Overview ov={o} view={hv} waits={waits} projectName={projectName} onPick={pickTask} tr={tr} since={lastSeen.state.since !== null && (
    <SinceCard digest={digest} since={lastSeen.state.since} truncated={lastSeen.state.truncated} now={now} tr={tr} onOpen={pickTask} onDismiss={lastSeen.dismiss} />
  )} />;

  return (
    <div className={`${s.tokens} ${s.root} ${v.v4}`}>
      <div className={v.top}>
        <button type="button" className={`${s.ib} ${v.back}`} aria-label={tr("返回")} onClick={nav.toList}>
          <Icon name="arrowLeft" size={16} />
        </button>
        <span className={v.ttl}>{projectName}</span>
        {narrow && <button type="button" className={v.teamM} onClick={() => select({ kind: "team" })}>{tr("团队")}</button>}
        {narrow && <button type="button" className={v.waitsM} onClick={() => select({ kind: "waits" })}>{tr("待你处理")} <b>{waits.length}</b></button>}
        {!narrow && <MetricsBar m={m} connected={connected} tr={tr} />}
      </div>
      {narrow ? (
        <>
          <MobileList ov={o} lines={lines} todayDone={hv.todayDone} now={now} actionText={actionText} onPick={pickTask} tr={tr} />
          {pane === "detail" && detail}
          {pane !== "detail" && page && <div className={v.sheet}>{page}</div>}
        </>
      ) : (
        <PaneLayout peekKey={openTask ?? (page ? JSON.stringify(sel) : null)} tr={tr} right={right} left={<Outline ov={o} lines={lines} filter={filter}
          onFilter={setFilter} waits={waits} onWaits={() => select({ kind: "waits" })} selected={openTask} onPick={pickTask} tr={tr} />}>
          <CenterPane team={team} ov={o} lines={lines} actionText={actionText} hot={advance?.id ?? null}
            selection={openTask ? { kind: "task", id: openTask } : sel} focus={focus} onSelect={select} tr={tr} />
        </PaneLayout>
      )}
    </div>
  );
}
