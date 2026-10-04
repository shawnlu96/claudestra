"use client";
/**
 * 任务详情（第二层，ux.md §3）：现在 → 阶段与用时 → 完成检查单 → 最近 3 件事 + 回放（T12c）→ 审查 → 参与者（含在跑的审查员）→ 对它说 → PR。
 * 桌面是首页右侧的面板；手机是全屏页，必须 portal 到 body（会话页在 transform 横滑容器里，web/CLAUDE.md PWA 第 4 条）。
 * 数据源声明了 homeOnly（团队视图，team-source.ts CollabHomeOnly）时：原文 / 打开会话 / 对它说 / 回放在缺数据时给「仅主场可见」占位，
 * 不整块消失；打开会话、对它说不挂本机会话与 say 接口（成员代号只展示，不是本机会话凭据）。可出境的类型 / 时间照常显示。
 * 规格全文的「全文仅在主场」由源注入的团队操作段（shared/team-ops.tsx TaskOps，经 extra）给。本机源不声明 homeOnly，界面不变。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useCollabT } from "./collab-i18n";
import { useCollabSource } from "./team-source-context";
import type { CollabHomeOnly } from "./team-source";
import { isWorking, type ActionMap, type AgentAction } from "./collab-action";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { closeCollab } from "./collab-nav";
import { uiAgentName, type AgentSession } from "@/lib/chat/agents";
import type { LineAction } from "./collab-action";
import { fmtEventTime, isRedacted, participants, recentThree, reviewRows, stageSegments, type Participant, type TaskDetail } from "./collab-detail-model";
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
 * 手机全屏详情占一条历史记录（#chat?collab=<id>）：系统返回（左滑 / 返回键）先回协作视图首页，不直接退到会话列表。
 * 只在已经处于 #chat（手机横滑到内容页）时压；桌面窗口拉窄不压也不关。返回的关闭函数：压过就 back，由 popstate 收起。
 */
function useDetailHistory(narrow: boolean, id: string, onClose: () => void): () => void {
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

const NO_AGENTS: readonly AgentSession[] = [];
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

type HomeOnly = (k: CollabHomeOnly) => boolean;

/** 「仅主场可见」占位：一行弱化说明，排版同审查行的正文 */
function HomeOnlyNote({ k, text }: { k: CollabHomeOnly; text: string }) {
  return (
    <div className={s.rr} data-home-only={k}>
      <div className={s.tx}>{text}</div>
    </div>
  );
}

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

function RecentSec({ d, tr, home }: { d: TaskDetail; tr: Tr; home: HomeOnly }) {
  const recent = recentThree(d.events, tr);
  const homeText = home("events.text");
  if (!recent.length && !homeText) return null;
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
      {homeText && <HomeOnlyNote k="events.text" text={tr(recent.length ? "原文仅主场可见" : "仅主场可见")} />}
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

function ReviewSec({ d, tr, home }: { d: TaskDetail; tr: Tr; home: HomeOnly }) {
  const reviews = reviewRows(d.events).slice(-3);
  // 脱敏审查不进审查行（collab-detail-model reviewRows）：有它就说明有审查，只是结论在主场
  const hidden = home("review.text") || d.events.some((e) => e.kind === "review" && isRedacted(e));
  if (!reviews.length && !hidden) return null;
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
      {hidden && <HomeOnlyNote k="review.text" text={tr(reviews.length ? "原文仅主场可见" : "仅主场可见")} />}
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
  now: number; tr: Tr; open: (name: string) => void; agents: readonly AgentSession[]; home: HomeOnly;
}) {
  const { d, exec, action, running, now, tr, open, agents } = props;
  // 打开会话仅主场：成员代号可能和本机 agent 重名，不能当本机会话凭据，一律不挂按钮
  const sessionsHome = props.home("sessions");
  const people = participants(d);
  return (
    <Sec title={tr("参与者")}>
      <div className={s.ppl}>
        {running.map((r) => <RunningReviewerRow key={r.id} r={r} now={now} tr={tr} />)}
        {people.map((p) => (
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
              {p.role === "executor" && !sessionsHome && action.text && <div className={s.d}>{action.text}</div>}
              {!sessionsHome && (agents.some((a) => a.name === uiAgentName(p.name)) ||
                [d.sessions?.author, d.sessions?.reviewer].some((ref) => ref?.source !== "peer_claim" && uiAgentName(ref?.agent ?? "") === uiAgentName(p.name))) && (
                <button type="button" className={s.btn} onClick={() => open(p.name)}>{tr("打开会话")} → {p.name}</button>
              )}
            </div>
          </div>
        ))}
      </div>
      {sessionsHome && <HomeOnlyNote k="sessions" text={tr(people.length || running.length ? "打开会话仅主场" : "仅主场可见")} />}
    </Sec>
  );
}

function Body(props: {
  d: TaskDetail; line: LineView; action: LineAction; stream: AgentAction | undefined; running: readonly RunningReviewer[]; now: number; tr: Tr; extra?: React.ReactNode;
  homeOnly?: ReadonlySet<CollabHomeOnly>;
}) {
  const { d, line, action, running, now, tr } = props;
  const home: HomeOnly = (k) => props.homeOnly?.has(k) ?? false;
  const local = useChatStore((st) => st.state.agents);
  // 会话仅主场：本机会话列表与这条任务的人无关（同名也不是同一个），不拿来查模型、在跑状态或打开会话
  const agents = home("sessions") ? NO_AGENTS : local;
  const stream = home("sessions") ? undefined : props.stream;
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
      <RecentSec d={d} tr={tr} home={home} />
      <CollabReplay d={d} tr={tr} homeOnly={home("replay")} />
      <StepsSec d={d} agents={agents} tr={tr} />
      <ReviewSec d={d} tr={tr} home={home} />
      <PeopleSec d={d} exec={exec} action={action} running={running} now={now} tr={tr} open={open} agents={agents} home={home} />
      {pr && (
        <div className={s.links}>
          <a className={s.btn} href={pr} target="_blank" rel="noreferrer">
            <Icon name="gitPullRequest" size={13} />
            PR #{pr.match(/(\d+)\/?$/)?.[1] ?? ""}
          </a>
        </div>
      )}
      {home("say") ? (
        d.task.stage !== "done" && d.task.stage !== "cancelled" && (
          <div className={s.sayDock}>
            <Sec title={line.agent ? `${tr("对它说")} · ${line.agent}` : tr("对它说")}>
              <HomeOnlyNote k="say" text={tr("仅主场可见")} />
            </Sec>
          </div>
        )
      ) : line.agent && d.task.stage !== "done" && d.task.stage !== "cancelled" && (
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
  const homeOnly = useCollabSource(project).homeOnly;
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
          running={props.reviewers} now={now} tr={tr} extra={props.extra} homeOnly={homeOnly} />
      ) : (
        <div className={s.pb}>{load.status === "error" ? tr("读详情失败：{m}", { m: load.message }) : tr("正在读取…")}</div>
      )}
    </aside>
  );
  return narrow ? createPortal(panel, document.body) : panel;
}
