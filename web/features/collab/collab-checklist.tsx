"use client";
/**
 * 任务详情里的「完成检查单」：最近一次 `ledger verify` 由系统逐项核对的结果（src/lib/ledger-probes.ts）。
 * 过 = 绿、没过 = 红、查不到 = 灰、PM / owner 豁免 = 黄并带理由。没有系统核对过的 verify 事件就整段不显示。
 */
import { actorName, fmtEventTime, latestChecklist, type CheckRow, type TaskDetail } from "./collab-detail-model";
import { Icon, type IconName } from "./collab-icons";
import type { Tr } from "./collab-model";
import s from "./collab.module.css";

const ROW_LOOK: Record<CheckRow["status"] | "waived", { icon: IconName; tone: string }> = {
  pass: { icon: "circleCheck", tone: s.ckPass },
  fail: { icon: "circleX", tone: s.ckFail },
  unknown: { icon: "circleHelp", tone: s.ckUnknown },
  waived: { icon: "circleAlert", tone: s.ckWaived },
};

const RESULT_TEXT = { pass: "全部通过", fail: "没通过", unknown: "查不到" } as const;

export function ChecklistSec({ d, tr }: { d: TaskDetail; tr: Tr }) {
  const c = latestChecklist(d.events);
  if (!c) return null;
  const head = ROW_LOOK[c.result];
  return (
    <div className={s.sec}>
      <h5>{tr("完成检查单")}</h5>
      <div className={s.ckHead}>
        <span className={`${s.vd} ${head.tone}`}>{tr(RESULT_TEXT[c.result])}</span>
        <span className={s.tm}>{tr("{who} 核对于 {t}", { who: actorName(c.actor, tr), t: fmtEventTime(c.ts, d.now, tr) })}</span>
      </div>
      {c.rows.map((r) => {
        const look = ROW_LOOK[r.waived ? "waived" : r.status];
        return (
          <div key={r.id} className={`${s.ck} ${look.tone}`}>
            <span className={s.ic}>
              <Icon name={look.icon} size={14} />
            </span>
            <div>
              <div className={s.cl}>{tr(r.label)}</div>
              {r.waived && <div className={s.cw}>{tr("已豁免 · {r}", { r: r.waived })}</div>}
              {r.detail && <div className={s.cd}>{r.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
