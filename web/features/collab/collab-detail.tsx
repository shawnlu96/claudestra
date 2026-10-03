"use client";
/**
 * 任务详情（第二层，ux.md §3）：现在 → 阶段与用时 → 完成检查单 → 最近 3 件事 + 回放（T12c）→ 审查 → 参与者（含在跑的审查员）→ 对它说 → PR。
 * 桌面是首页右侧的面板；手机是全屏页，必须 portal 到 body（会话页在 transform 横滑容器里，web/CLAUDE.md PWA 第 4 条）。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useCollabT } from "./collab-i18n";
import { isWorking, type ActionMap, type AgentAction } from "./collab-action";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { closeCollab } from "./collab-nav";
import { uiAgentName, type AgentSession } from "@/lib/chat/agents";
import type { LineAction } from "./collab-action";
import { fmtEventTime, participants, recentThree, reviewRows, stageSegments, type Participant, type TaskDetail } from "./collab-detail-model";
import { stepLineView } from "./collab-step-line-model";
import { StepLine } from "./collab-step-line";
import { Icon, type IconName } from "./collab-icons";
import { dwellText, fmtDuration, lineOf, type LedgerOverview, type LineView, type Tr } from "./collab-model";
import { ChecklistSec } from "./collab-checklist";
import { CollabReplay } from "./collab-replay-player";
import type { RunningReviewer } from "./collab-reviewers";
import { CollabSay } from "./collab-say";
import v2 from "./collab-v2.module.css";
import { useTaskDetail } from "./use-collab";
import s from "./collab.module.css";

const NARROW = "(max-width: 639.98px)";
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

const COLLAB_Q = "collab=";
const onDetailEntry = () => window.location.hash.includes(COLLAB_Q);

/**
 * 手机全屏层（详情 / 团队等整屏页）占一条历史记录（#chat?collab=<id>）：系统返回（左滑 / 返回键）先收起这一层，不直接退到会话列表。
 * 只在已经处于 #chat（手机横滑到内容页）时压；桌面窗口拉窄不压也不关。返回的关闭函数：压过就 back，由 popstate 收起。
 */
export function useDetailHistory(narrow: boolean, id: string, onClose: () => void): () => void {
  useEffect(() => {
    if (!narrow || window.location.hash.split("?")[0] !== "#chat") return;
    const tagged = `#chat?${COLLAB_Q}${encodeURIComponent(id)}`;
    if (onDetailEntry()) window.history.replaceState(window.history.state, "", tagged);
    else window.history.pushState({ cstraCollab: true }, "", tagged);
    const onPop = () => !onDetailEntry() && onClose();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [narrow, id, onClose]);
  return useCallback(() => (narrow && onDetailEntry() ? window.history.back() : onClose()), [narrow, onClose]);
}

const TONE = { red: s.red, amber: s.amber, neutral: s.neutral, green: s.green } as const;
const EVENT_ICON: Record<string, IconName> = {
  stage: "zap", deliver: "gitPullRequest", review: "fileText", decision: "circleCheck",
  deploy: "zap", verify: "shieldCheck", rollback: "rotateCcw", note: "history", scheduler: "zap",
};
const ROLE: Record<Participant["role"], { label: string; icon: IconName; duty: string }> = {
  executor: { label: "执行者", icon: "code", duty: "按规格实现、写测试、开 PR、按审查意见返工" },
  pm: { label: "PM", icon: "clipboard", duty: "写规格卡、派发、盯进度、合并部署、记台账" },
  reviewer: { label: "审查员", icon: "shieldCheck", duty: "独立上下文复核，给 P0 / P1 / P2" },
};

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={s.sec}>
      <h5>{title}</h5>
      {children}
    </div>
  );
}

function NowSec({ line, total, tr }: { line: LineView; total: number | undefined; tr: Tr }) {
  return (
    <Sec title={tr("现在")}>
      <div className={`${s.nowbox} ${TONE[line.tone]}`}>
        <div className={s.k}>
          <Icon name={line.attention === "problem" ? "rotateCcw" : line.attention === "progress" ? "zap" : "hourglass"} size={14} />
          {line.stageLabel}
        </div>
        {line.reason && <div className={s.r}>{line.reason}</div>}
        <div className={s.m}>
          {dwellText(line, tr)}
          {typeof total === "number" && total > 0 && ` · ${tr("已用时 {d}", { d: fmtDuration(total, tr) })}`}
        </div>
      </div>
    </Sec>
  );
}

function StagesSec({ d, line, tr }: { d: TaskDetail; line: LineView; tr: Tr }) {
  return (
    <Sec title={tr("阶段与用时")}>
      <div className={`${s.steps} ${TONE[line.tone]}`}>
        {stageSegments(d).map((g) => (
          <div key={g.label} className={`${s.s} ${g.state === "past" ? s.past : g.state === "current" ? s.cur : ""}`}>
            <i />
            {tr(g.label)}
            <em>{g.ms > 0 ? fmtDuration(g.ms, tr) : g.state === "future" ? "" : "—"}</em>
          </div>
        ))}
      </div>
    </Sec>
  );
}

function RecentSec({ d, tr }: { d: TaskDetail; tr: Tr }) {
  const recent = recentThree(d.events, tr);
  if (!recent.length) return null;
  return (
    <Sec title={tr("最近 3 件事")}>
      {recent.map((r) => (
        <div key={r.seq} className={s.ev}>
          <span className={s.tm} title={r.approx ? tr("导入时推算的近似时间") : undefined}>
            {r.approx && <span className={s.approx}>≈</span>}
            {fmtEventTime(r.ts, d.now, tr)}
          </span>
          <span className={s.ic}>
            <Icon name={EVENT_ICON[r.kind] ?? "history"} size={13} />
          </span>
          <span>{r.text}</span>
        </div>
      ))}
    </Sec>
  );
}

/** 步骤线（T51，collab-step-line.tsx）：整条线、当前这一步、等待；本机 agent 的模型从会话列表查。一步都没人的卡不画 */
function StepsSec({ d, agents, tr }: { d: TaskDetail; agents: readonly AgentSession[]; tr: Tr }) {
  const v = stepLineView(d.stepLine, d.task.stage, (n) => agents.find((a) => a.name === uiAgentName(n))?.model ?? null);
  if (!v || !v.slots.some((x) => x.filled)) return null;
  return (
    <Sec title={tr("步骤")}>
      <StepLine v={v} tr={tr} />
    </Sec>
  );
}

function ReviewSec({ d, tr }: { d: TaskDetail; tr: Tr }) {
  const reviews = reviewRows(d.events).slice(-3);
  if (!reviews.length) return null;
  return (
    <Sec title={tr("审查")}>
      {reviews.map((r, i) => (
        <div key={i} className={s.rr}>
          <div className={s.h}>
            <span>R{r.round ?? "?"}</span>
            <span className={`${s.vd} ${r.verdict === "pass" ? s.pass : r.verdict === "block" ? s.block : s.changes}`}>
              {r.verdict === "pass" ? tr("通过") : `P0 ${r.p0 ?? "?"} · P1 ${r.p1 ?? "?"} · P2 ${r.p2 ?? "?"}`}
            </span>
            <span className={s.tm}>{fmtEventTime(r.ts, d.now, tr)}</span>
          </div>
          {r.text && <div className={s.tx}>{r.text}</div>}
        </div>
      ))}
    </Sec>
  );
}

/** 在跑的审查员（PM 的后台子 agent，collab-reviewers.ts）：没有名字可言，写派它的 PM、第几轮、跑了多久 */
function RunningReviewerRow({ r, now, tr }: { r: RunningReviewer; now: number; tr: Tr }) {
  const bits = [r.round ? tr("第 {r} 轮", { r: r.round }) : "", r.adversarial ? tr("对抗式") : "", tr("{pm} 派出", { pm: r.pm }), tr("已跑 {d}", { d: fmtDuration(Math.max(0, now - r.startedAt), tr) })];
  return (
    <div className={s.pp}>
      <span className={s.av}>
        <Icon name="shieldCheck" size={14} />
      </span>
      <div>
        <div className={s.n}>
          {tr("审查员")}
          <span className={v2.rvTag} style={{ marginLeft: 8 }}>
            <span className={v2.rvLive} />
            {tr("在跑")}
          </span>
        </div>
        <div className={s.d}>{bits.filter(Boolean).join(" · ")}</div>
      </div>
    </div>
  );
}

function PeopleSec(props: {
  d: TaskDetail; exec: AgentSession | undefined; action: LineAction; running: readonly RunningReviewer[];
  now: number; tr: Tr; open: (name: string) => void; agents: readonly AgentSession[];
}) {
  const { d, exec, action, running, now, tr, open, agents } = props;
  return (
    <Sec title={tr("参与者")}>
      <div className={s.ppl}>
        {running.map((r) => <RunningReviewerRow key={r.id} r={r} now={now} tr={tr} />)}
        {participants(d).map((p) => (
          <div key={`${p.role}:${p.name}`} className={s.pp}>
            <span className={s.av}>
              <Icon name={ROLE[p.role].icon} size={14} />
            </span>
            <div>
              <div className={s.n}>
                {p.name}
                <span>
                  {tr(ROLE[p.role].label)}
                  {p.role === "executor" && exec?.model ? ` · ${exec.model}${exec.effort ? ` · ${exec.effort}` : ""}` : ""}
                  {p.rounds?.length ? ` · ${tr("第 {r} 轮", { r: p.rounds.join(tr("、")) })}` : ""}
                </span>
              </div>
              <div className={s.d}>{tr(ROLE[p.role].duty)}</div>
              {p.role === "executor" && action.text && <div className={s.d}>{action.text}</div>}
              {(agents.some((a) => a.name === uiAgentName(p.name)) ||
                [d.sessions?.author, d.sessions?.reviewer].some((ref) => ref?.source !== "peer_claim" && uiAgentName(ref?.agent ?? "") === uiAgentName(p.name))) && (
                <button type="button" className={s.btn} onClick={() => open(p.name)}>{tr("打开会话")} → {p.name}</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Sec>
  );
}

function Body(props: {
  d: TaskDetail; line: LineView; action: LineAction; stream: AgentAction | undefined; running: readonly RunningReviewer[]; now: number; tr: Tr; extra?: React.ReactNode;
}) {
  const { d, line, action, stream, running, now, tr } = props;
  const agents = useChatStore((st) => st.state.agents);
  const store = useChatStoreApi();
  const nav = useChatNav();
  const open = (name: string) => { closeCollab(); void store.openAgent(uiAgentName(name)); nav.toContent(); };
  const exec = line.agent ? agents.find((a) => a.name === line.agent) : undefined;
  const working = isWorking(stream, exec?.busy);
  const pr = d.task.pr && /^https:\/\//.test(d.task.pr) ? d.task.pr : null;
  return (
    <div className={s.pb}>
      <NowSec line={line} total={d.task.metrics.totalMs} tr={tr} />
      <StagesSec d={d} line={line} tr={tr} />
      {props.extra}
      <ChecklistSec d={d} tr={tr} />
      <RecentSec d={d} tr={tr} />
      <CollabReplay d={d} tr={tr} />
      <StepsSec d={d} agents={agents} tr={tr} />
      <ReviewSec d={d} tr={tr} />
      <PeopleSec d={d} exec={exec} action={action} running={running} now={now} tr={tr} open={open} agents={agents} />
      {pr && (
        <div className={s.links}>
          <a className={s.btn} href={pr} target="_blank" rel="noreferrer">
            <Icon name="gitPullRequest" size={13} />
            PR #{pr.match(/(\d+)\/?$/)?.[1] ?? ""}
          </a>
        </div>
      )}
      {line.agent && d.task.stage !== "done" && d.task.stage !== "cancelled" && (
        <div className={s.sayDock}>
          <Sec title={`${tr("对它说")} · ${line.agent}`}>
            <CollabSay agent={line.agent} working={working} tr={tr} />
          </Sec>
        </div>
      )}
    </div>
  );
}

export function CollabDetail(props: {
  project: string;
  id: string;
  rev: number;
  now: number;
  ov: LedgerOverview;
  line: LineView | null;
  action: (l: LineView) => LineAction;
  actions: ActionMap;
  /** 这条任务上在跑的审查员（T12c） */
  reviewers: readonly RunningReviewer[];
  onClose: () => void;
  /** v4 属性区多挂的段（它的因果线），排在阶段与用时之后 */
  extra?: React.ReactNode;
}) {
  const { project, id, rev, now, ov, onClose } = props;
  const tr = useCollabT();
  const narrow = useNarrow();
  const load = useTaskDetail(project, id, rev);
  const close = useDetailHistory(narrow, id, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  // 切卡后 useTaskDetail 要到 effect 里才回到加载态：这一帧的 load 还是上一张卡的，按 id 对上才用
  const d = load.status === "ok" && load.d.task.id === id ? load.d : null;
  const task = d?.task ?? ov.tasks?.find((t) => t.id === id);
  // 已完成的卡在总览里只有摘要（没有目标句、步骤线）：用详情现算一条线；详情到之前不显示目标句，免得先闪事项的一句话
  const completed = !!task && ["done", "verified", "cancelled"].includes(task.stage);
  const fullLine = task ? lineOf(task, ov, new Map((ov.items ?? []).map((i) => [i.id, i])), now, tr) : null;
  const line = completed ? (d ? fullLine : null) : props.line ?? fullLine;

  const panel = (
    <aside className={`${s.tokens} ${s.panel} ${narrow ? s.full : ""}`}>
      <div className={s.ph}>
        <div className={s.tt}>
          <div className={s.a}>
            <span className={s.tid}>{id}</span>
            {task?.title ?? ""}
          </div>
          {line?.goal && <div className={s.b}>{line.goal}</div>}
        </div>
        <button type="button" className={s.ib} aria-label={tr("关闭")} onClick={close}>
          <Icon name={narrow ? "arrowLeft" : "x"} size={15} />
        </button>
      </div>
      {d && line ? (
        <Body d={d} line={line} action={props.action(line)} stream={line.agent ? props.actions.get(line.agent) : undefined}
          running={props.reviewers} now={now} tr={tr} extra={props.extra} />
      ) : (
        <div className={s.pb}>{load.status === "error" ? tr("读详情失败：{m}", { m: load.message }) : tr("正在读取…")}</div>
      )}
    </aside>
  );
  return narrow ? createPortal(panel, document.body) : panel;
}
