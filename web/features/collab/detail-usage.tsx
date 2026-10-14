"use client";
import { useEffect, useState } from "react";
import { fetchTaskUsage, type TaskUsageSummary } from "@/lib/api/usage-task";
import type { Tr } from "./collab-model";
import { taskUsageLines } from "./detail-usage-model";
import s from "./collab.module.css";

export function DetailUsage({ id, awayMachine, tr }: { id: string | null; awayMachine: string | null; tr: Tr }) {
  const [result, setResult] = useState<{ id: string; summary: TaskUsageSummary | null } | null>(null);
  useEffect(() => {
    if (!id || awayMachine !== null) return;
    const ctrl = new AbortController();
    fetchTaskUsage(id, ctrl.signal).then((r) => {
      if (!ctrl.signal.aborted) setResult({ id, summary: r.ok && r.summary ? r.summary : null });
    }, () => {
      // Usage is optional and full-scope only. Hide unavailable / forbidden data; the shared API client owns device repair.
      if (!ctrl.signal.aborted) setResult({ id, summary: null });
    });
    return () => ctrl.abort();
  }, [id, awayMachine]);
  const current = result?.id === id ? result : null;
  if (awayMachine === null && (!id || current?.summary === null)) return null;
  const lines = awayMachine !== null ? [tr("这张卡在 {m} 上执行，用量记在那台机器", { m: awayMachine })]
    : current?.summary ? taskUsageLines(current.summary, tr) : null;
  return <div className={s.sec} data-detail-usage="section">
    <h5>{tr("已耗额度")}</h5>
    {lines ? lines.map((line) => <div key={line} className={s.tx}>{line}</div>) :
      <div data-detail-usage="loading" aria-busy="true" style={{ height: 36, borderRadius: 6, background: "var(--bg-2)", opacity: 0.6 }} />}
  </div>;
}
