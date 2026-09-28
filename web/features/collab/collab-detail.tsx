"use client";
/**
 * 任务详情（第二层，ux.md §3）：现在 → 阶段与用时 → 完成检查单 → 最近 3 件事 → 审查 → 参与者 → 对它说 → PR。
 * 桌面是首页右侧的面板；手机是全屏页，必须 portal 到 body（会话页在 transform 横滑容器里，web/CLAUDE.md PWA 第 4 条）。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useCollabT } from "./collab-i18n";
import { isWorking, type ActionMap, type AgentAction } from "./collab-action";
import { useChatStore } from "../chat/chat-store";
import type { AgentSession } from "@/lib/chat/agents";
import type { LineAction } from "./collab-line";
import { fmtEventTime, participants, recentThree, reviewRows, stageSegments, type Participant, type TaskDetail } from "./collab-detail-model";
import { Icon, type IconName } from "./collab-icons";
import { dwellText, fmtDuration, lineOf, type LedgerOverview, type LineView, type Tr } from "./collab-model";
import { ChecklistSec } from "./collab-checklist";
import { CollabSay } from "./collab-say";
import { useTaskDetail } from "./use-collab";
import s from "./collab.module.css";

const NARROW = "(max-width: 639.98px)";
function useNarrow(): boolean {
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

const TONE = { red: s.red, amber: s.amber, neutral: s.neutral, green: s.green } as const;
const EVENT_ICON: Record<string, IconName> = {
  stage: "zap", deliver: "gitPullRequest", review: "fileText", decision: "circleCheck",
  deploy: "zap", verify: "shieldCheck", rollback: "rotateCcw", note: "history",
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

function PeopleSec({ d, exec, action, tr }: { d: TaskDetail; exec: AgentSession | undefined; action: LineAction; tr: Tr }) {
  return (
    <Sec title={tr("参与者")}>
      <div className={s.ppl}>
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
            </div>
          </div>
        ))}
      </div>
    </Sec>
  );
}

function Body({ d, line, action, stream, tr }: { d: TaskDetail; line: LineView; action: LineAction; stream: AgentAction | undefined; tr: Tr }) {
  const agents = useChatStore((st) => st.state.agents);
  const exec = line.agent ? agents.find((a) => a.name === line.agent) : undefined;
  const working = isWorking(stream, exec?.busy);
  const pr = d.task.pr && /^https:\/\//.test(d.task.pr) ? d.task.pr : null;
  return (
    <div className={s.pb}>
      <NowSec line={line} total={d.task.metrics.totalMs} tr={tr} />
      <StagesSec d={d} line={line} tr={tr} />
      <ChecklistSec d={d} tr={tr} />
      <RecentSec d={d} tr={tr} />
      <ReviewSec d={d} tr={tr} />
      <PeopleSec d={d} exec={exec} action={action} tr={tr} />
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
  onClose: () => void;
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
  const task = ov.tasks.find((t) => t.id === id);
  // 今日完成的任务不在首页的线里：现算一条，详情照样有「现在」与用时
  const line = props.line ?? (task ? lineOf(task, ov, new Map(ov.items.map((i) => [i.id, i])), now, tr) : null);

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
      {load.status === "ok" && line ? (
        <Body d={load.d} line={line} action={props.action(line)} stream={line.agent ? props.actions.get(line.agent) : undefined} tr={tr} />
      ) : (
        <div className={s.pb}>{load.status === "error" ? tr("读详情失败：{m}", { m: load.message }) : tr("正在读取…")}</div>
      )}
    </aside>
  );
  return narrow ? createPortal(panel, document.body) : panel;
}
