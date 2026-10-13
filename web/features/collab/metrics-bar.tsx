"use client";
/**
 * 协作视图顶栏指标条（UXNUM1）：在干活 · 在等 · 没开工 · 今日完成 · 在场 agent · 审查轮次 · P0/P1 修掉 · 平均等复核 · 周额度。
 * 前三格是卡 / 节点个数，口径在 count-words.ts（和大纲芯片、右栏、产品卡、子 DAG 框头、谁在干活同一份）；没载完显示骨架，不出数字。
 * 没数据的指标整格不出（团队源的 unknownMetrics、不知道谁在场）；本机「没人在等审查」照旧是「—」。
 * 周额度读看者本机 bridge 的 /lend/quota-lines（本机版、团队版同一份），按族写百分比，读不到整格不出。
 */
import { fmtDuration, type Tr } from "./collab-model";
import type { CountState, QuotaFamilyPct } from "./count-words";
import { countText } from "./count-words-i18n";
import type { Metrics } from "./v4/v4-model";
import { Icon } from "./collab-icons";
import s from "./collab.module.css";
import v from "./v4/v4.module.css";

type Cell = { key: string; label: string; value: string | null };

/** 一格的值：null = 骨架；不出的格不进列表 */
export function metricCells(m: Metrics, counts: CountState, waitUnknown: boolean, quota: readonly QuotaFamilyPct[] | null, tr: Tr): Cell[] {
  const cells: Cell[] = [];
  const known = (key: string, label: string, n: number | null) => { if (n !== null) cells.push({ key, label, value: String(n) }); };
  if (counts.status !== "none") {
    const w = counts.status === "ready" ? counts.snap.words : null;
    for (const k of ["working", "waiting", "notStarted"] as const) {
      const label = { working: "在干活", waiting: "在等", notStarted: "没开工" }[k];
      cells.push({ key: k, label: countText(tr, label), value: w ? String(w[k]) : null });
    }
  }
  known("todayDone", tr("今日完成"), m.todayDone);
  known("present", tr("在场 agent"), m.present);
  known("reviewRounds", tr("审查轮次"), m.reviewRounds);
  known("fixed", tr("P0/P1 修掉"), m.fixed);
  if (!waitUnknown) cells.push({ key: "reviewWait", label: tr("平均等复核"), value: m.avgReviewWaitMs === null ? "—" : fmtDuration(m.avgReviewWaitMs, tr) });
  if (quota?.length) cells.push({ key: "quota", label: countText(tr, "周额度"), value: quota.map((q) => `${q.family} ${q.pct}%`).join(" · ") });
  return cells;
}

export function MetricsBar({ m, counts, waitUnknown, quota, connected, tr }: {
  m: Metrics; counts: CountState; waitUnknown: boolean; quota: readonly QuotaFamilyPct[] | null; connected: boolean; tr: Tr;
}) {
  const missing = counts.status === "ready" ? counts.missing : 0;
  const hint = countText(tr, "另有 {k} 个 feature 还没读到，数字不含它们", { k: missing });
  return (
    <div className={v.metrics} data-metrics>
      {metricCells(m, counts, waitUnknown, quota, tr).map((c) => (
        <span key={c.key} className={v.metric} data-metric={c.key}>
          {c.value === null ? <b className={v.skel} aria-hidden /> : <b>{c.value}</b>}
          <span>{c.label}</span>
        </span>
      ))}
      {missing > 0 && <span className={v.lateHint} title={hint} aria-label={hint} role="img"><Icon name="circleAlert" size={14} /></span>}
      <span className={`${s.live} ${connected ? "" : s.off}`} title={tr(connected ? "实时" : "重连中")} />
    </div>
  );
}
