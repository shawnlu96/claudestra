"use client";
/** 远端行：放在 peer 上还没结的单（lend_orders 里 pooled / claimed / unknown）。只读，没有可点的东西。 */
import { useT } from "@/lib/i18n";
import type { RemoteRow } from "./borrow-api";
import { sortRemote } from "./borrow-model";
import { AgeTag } from "./borrow-bits";

const STATUS: Record<string, [string, string]> = {
  claimed: ["在跑", "border-success/30 bg-success/10 text-success"],
  pooled: ["等领取", "badge-ghost text-base-content/60"],
  unknown: ["待 PM", "border-warning/30 bg-warning/10 text-warning"],
};
const PHASE: Record<string, string> = { cloning: "克隆中", starting: "启动中", working: "工作中", publishing: "推送中", result_pending: "交结果" };
const STEP: Record<string, string> = { review: "审查", write: "开工", fix: "修复" };

export function RemoteRows({ rows, serverNow, receivedAt, tick }: { rows: RemoteRow[]; serverNow: number; receivedAt: number; tick: number }) {
  const t = useT();
  return (
    <ul className="divide-y divide-base-content/5 rounded-lg bg-base-100">
      {sortRemote(rows).map((r) => {
        const [label, cls] = STATUS[r.status] ?? [r.status, "badge-ghost"];
        return (
          <li key={r.orderId} className="space-y-0.5 px-3 py-2 select-text">
            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="shrink-0 font-mono text-base-content/70">{r.taskId}</span>
              <span className="min-w-0 truncate text-base-content/85">{r.title ?? ""}</span>
              <span className={`badge badge-sm ml-auto shrink-0 ${cls}`}>{t(label)}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-base-content/50">
              <span className="font-mono">{r.peer}</span>
              <span className="font-mono">{r.family}</span>
              <span>{t(STEP[r.step] ?? r.step)}</span>
              {r.phase && <span>{t(PHASE[r.phase] ?? r.phase)}</span>}
              {r.beatAt !== null && <AgeTag at={r.beatAt} serverNow={serverNow} receivedAt={receivedAt} tick={tick} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
