"use client";
/**
 * 项目页「总览」标签（原 v4-props 的右栏 Overview 搬来重排）：一句话状态 → 有来源的数格 → 卡住了 → 要你定的 → 你上次来之后 → 已完成（可折叠、往前翻）→ PM 一行。
 * 一句话状态的两个数取 homeView().headline（K = problem + stuck）；数格只出有来源的：今天完成看 unknownMetrics，合并队列 / 审查中看计数源
 * （count-words.ts 的阶段列，没载完是骨架，读不到看板整格不出），没有「暂无」格。卡住了每行的写法 import 今天页的 stuckRow()。
 */
import { useState, type ReactNode } from "react";
import { byDone } from "@/lib/api/ledger-done";
import { COLUMNS, type HomeView, type LedgerOverview, type LedgerTaskView, type OwnerWait, type Tr } from "../collab-model";
import { DoneMoreButton, useDonePages } from "../collab-done";
import { Icon } from "../collab-icons";
import { doneCount, type CountState } from "../count-words";
import { waitsText } from "../owner-waits";
import { retryWaits, Sec, TaskLink, WaitGo } from "../v4/v4-props";
import { stuckRow, type StuckRow } from "../../now/now-model";
import s from "../collab.module.css";
import v from "../v4/v4.module.css";
import { useProjectTabsT } from "./project-tabs-i18n";
import p from "./project-tabs.module.css";

export interface OverviewProps {
  project?: string;
  projectName: string;
  ov: LedgerOverview;
  view: HomeView;
  /** 计数源（use-dag-panes.tsx counts）；不给 = 合并队列 / 审查中两格不出 */
  counts?: CountState;
  waits: readonly OwnerWait[];
  /** 团队键对不上本机待办：「要你定的」写读不到 + 重试，不写「没有」 */
  waitsUnknown?: boolean;
  onPick: (id: string) => void;
  /** 「上次来之后」（collab-since-card.tsx），没有上次记录时不给 */
  since?: ReactNode;
  now?: number;
  tr: Tr;
}

const MERGE_COL = COLUMNS[4], REVIEW_COL = COLUMNS[3];
const isDone = (t: Pick<LedgerTaskView, "stage">) => t.stage === "done" || t.stage === "verified";

function Headline({ view, tr }: { view: HomeView; tr: Tr }) {
  const { advancing: n, problem, stuck } = view.headline;
  const k = problem + stuck;
  return (
    <p className={p.headline} data-headline>
      {k ? tr("{n} 个在推进 · {k} 个卡住", { n, k }) : tr("{n} 个在推进 · 没有卡住的", { n })}
      {view.pm.frozen && <span className={v.warn} title={view.pm.frozen}> · {tr("合并队列冻结")}</span>}
    </p>
  );
}

type Cell = { key: string; label: string; n: number | null };
/** null = 骨架（计数源没载完）；不出的格不进列表 */
function cellsOf(ov: LedgerOverview, view: HomeView, counts: CountState | undefined, tr: Tr): Cell[] {
  const out: Cell[] = [];
  if (!ov.unknownMetrics?.includes("todayDone")) out.push({ key: "todayDone", label: tr("今天完成"), n: view.todayDone.length });
  const col = (label: string) => (counts?.status === "ready" ? counts.snap.stages.find((c) => c.label === label)?.n ?? 0 : null);
  if (counts && counts.status !== "none") {
    out.push({ key: "merge", label: tr("合并队列"), n: col(MERGE_COL) });
    out.push({ key: "review", label: tr("审查中"), n: col(REVIEW_COL) });
  }
  return out;
}

function StuckLine({ r, onPick }: { r: StuckRow; onPick: (id: string) => void }) {
  return (
    <button type="button" className={p.stuck} data-stuck-row={r.id} onClick={() => onPick(r.id)}>
      <Icon name={r.problem ? "circleAlert" : "hourglass"} size={14} className={r.problem ? v.bad : v.warn} />
      <span className={p.stuckText}>
        <span className={p.stuckTitle}>{r.title}</span>
        {r.reason && <span className={p.stuckReason}>{r.reason}</span>}
      </span>
      {r.dwell && <span className={p.stuckDwell}>{r.dwell}</span>}
    </button>
  );
}

function Waits({ project, ov, waits, unknown, onPick, tr }: Pick<OverviewProps, "ov" | "waits" | "onPick" | "tr"> & { project: string; unknown?: boolean }) {
  if (unknown) return (
    <div className={v.muted} data-waits="unknown">{waitsText(tr, "读不到")}{" "}
      <button type="button" className={s.btn} onClick={() => retryWaits(project)}>{waitsText(tr, "重试")}</button></div>
  );
  if (!waits.length) return <div className={v.muted}>{tr("没有要你定的")}</div>;
  return <>{waits.map((w) => (
    <div key={w.id} className={v.row}>{w.taskId ? <TaskLink id={w.taskId} ov={ov} onPick={onPick} /> : null} {w.title}<WaitGo w={w} /></div>
  ))}</>;
}

/** 已完成 N：默认收起；展开 = 总览里的已完成 + 往前翻到的（collab-done.tsx），底部「更多」接着翻 */
function DoneFold({ project, ov, onPick, tr }: { project: string; ov: LedgerOverview; onPick: (id: string) => void; tr: Tr }) {
  const d = useDonePages(project, ov);
  const [open, setOpen] = useState(false);
  const total = doneCount(ov);
  if (!total && !d.more) return null;
  const rows = [...ov.tasks.filter(isDone), ...d.pages.filter(isDone)].sort(byDone);
  return (
    <section className={s.sec} data-done>
      <button type="button" className={p.fold} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{tr("已完成 {n}", { n: total })}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <div className={p.foldBody} style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
        <div className={v.og} inert={!open}>
          {rows.map((t) => (
            <button key={t.id} type="button" className={v.ot} onClick={() => onPick(t.id)}>
              <span className={`${v.dot} ${v.green}`} />
              <span className={v.tid}>{t.id}</span>
              <span className={v.ott}>{t.title}</span>
            </button>
          ))}
          {open && <DoneMoreButton d={d} tr={tr} />}
        </div>
      </div>
    </section>
  );
}

export function Overview(props: OverviewProps) {
  const { ov, view, onPick, projectName } = props;
  const project = props.project ?? "";
  const tr = useProjectTabsT(props.tr);
  const stuck = view.lines.filter((l) => l.attention === "problem" || l.attention === "stuck").map((l) => stuckRow(l, project, projectName, props.tr));
  const cells = cellsOf(ov, view, props.counts, tr);
  return (
    <div className={p.overview} data-overview>
      <Headline view={view} tr={tr} />
      {cells.length > 0 && (
        <div className={p.cells}>
          {cells.map((c) => (
            <span key={c.key} className={p.cell} data-cell={c.key}>
              {c.n === null ? <b className={v.skel} aria-hidden /> : <b>{c.n}</b>}<span>{c.label}</span>
            </span>
          ))}
        </div>
      )}
      {props.counts?.status === "ready" && props.counts.missing > 0 && (
        <div className={v.warn} data-count-hint>{tr("另有 {k} 个模块还没读到，数字不含它们", { k: props.counts.missing })}</div>
      )}
      {stuck.length > 0 && <Sec title={tr("卡住了")}>{stuck.map((r) => <StuckLine key={r.id} r={r} onPick={onPick} />)}</Sec>}
      <Sec title={tr("要你定的")}><Waits project={project} ov={ov} waits={props.waits} unknown={props.waitsUnknown} onPick={onPick} tr={tr} /></Sec>
      {props.since}
      <DoneFold project={project} ov={ov} onPick={onPick} tr={tr} />
      {view.pm.pm && <Sec title="PM"><div className={v.kv}>{view.pm.pm} · {tr("在管")} {view.pm.managing} · {tr("排队")} {view.pm.queued.length}</div></Sec>}
    </div>
  );
}
