"use client";
/**
 * 任务详情里的「完成检查单」：最近一次 `ledger verify` 由系统逐项核对的结果（src/lib/ledger-probes.ts）。
 * 过 = 绿、没过 = 红、查不到 = 灰、PM / owner 豁免 = 黄并带理由；标题写明含几项豁免、检查单从哪来、推断不全的原因。
 * 没有系统核对过的 verify 事件就整段不显示。
 */
import { actorName, fmtEventTime, latestChecklist, SOURCE_TEXT, type CheckRow, type ChecklistView, type TaskDetail } from "./collab-detail-model";
import { Icon, type IconName } from "./collab-icons";
import type { Tr } from "./collab-model";
import s from "./collab.module.css";

const ROW_LOOK: Record<CheckRow["status"] | "waived", { icon: IconName; tone: string }> = {
  pass: { icon: "circleCheck", tone: s.ckPass },
  fail: { icon: "circleX", tone: s.ckFail },
  unknown: { icon: "circleHelp", tone: s.ckUnknown },
  waived: { icon: "circleAlert", tone: s.ckWaived },
};

function headline(c: ChecklistView, tr: Tr): { text: string; look: (typeof ROW_LOOK)[keyof typeof ROW_LOOK] } {
  if (c.result === "pass") return c.waived ? { text: tr("通过（含 {n} 项豁免）", { n: c.waived }), look: ROW_LOOK.waived } : { text: tr("全部通过"), look: ROW_LOOK.pass };
  return { text: tr(c.result === "fail" ? "没通过" : "查不到"), look: ROW_LOOK[c.result] };
}

export function ChecklistSec({ d, tr }: { d: TaskDetail; tr: Tr }) {
  const c = latestChecklist(d.events);
  if (!c) return null;
  const head = headline(c, tr);
  return (
    <div className={s.sec}>
      <h5>{tr("完成检查单")}</h5>
      <div className={s.ckHead}>
        <span className={`${s.vd} ${head.look.tone}`}>{head.text}</span>
        <span className={s.tm}>{tr("{who} 核对于 {t}", { who: actorName(c.actor, tr), t: fmtEventTime(c.ts, d.now, tr) })}</span>
      </div>
      {c.source && <div className={s.ckMeta}>{tr(SOURCE_TEXT[c.source])}</div>}
      {c.incomplete && <div className={`${s.ckMeta} ${s.ckFailText}`}>{tr("拿不到 PR 的文件列表，推断不出检查单")}</div>}
      {c.note && <div className={s.ckMeta}>{c.note}</div>}
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
              {(r.tpl || r.detail) && <div className={s.cd}>{r.tpl ? tr(r.tpl, r.params) : r.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
