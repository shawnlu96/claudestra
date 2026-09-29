"use client";
/** v4 手机：没有画布。按「可执行 / 在跑 → 在等 → 今日完成」分组列卡片，卡上带挡着它的那条因果线；点卡片进全屏详情（collab-detail.tsx） */
import { dwellText, lineOf, type LedgerOverview, type LineView, type Tr } from "../collab-model";
import { StageBar } from "./stage-bar";
import { blockLine, mobileSections } from "./v4-model";
import v from "./v4.module.css";

const TITLE = { running: "可执行 / 在跑", waiting: "在等", done: "今日完成" } as const;

export function MobileList(props: {
  ov: LedgerOverview;
  lines: ReadonlyMap<string, LineView>;
  todayDone: readonly string[];
  now: number;
  actionText: (id: string) => string;
  onPick: (id: string) => void;
  tr: Tr;
}) {
  const { ov, lines, now, tr } = props;
  const byId = new Map(ov.tasks.map((t) => [t.id, t]));
  const items = new Map(ov.items.map((i) => [i.id, i]));
  return (
    <div className={v.mlist}>
      {mobileSections(ov, props.todayDone).map((sec) => (
        <section key={sec.key} className={v.msec}>
          <h5>{tr(TITLE[sec.key])} <span className={v.cnt}>{sec.ids.length}</span></h5>
          {sec.ids.map((id) => {
            const t = byId.get(id);
            if (!t) return null;
            const l = lines.get(id) ?? lineOf(t, ov, items, now, tr);
            const block = blockLine(t, ov.deps ?? []);
            const act = props.actionText(id);
            return (
              <button key={id} type="button" className={`${v.mcard} ${v[l.tone] ?? ""}`} onClick={() => props.onPick(id)}>
                <span className={v.nh}>
                  <span className={v.tid}>{id}</span>
                  <span className={v.nt}>{t.title}</span>
                </span>
                <StageBar stage={t.stage} before={t.stageBefore} kind={t.kind} />
                <span className={v.nf}>
                  <span>{l.stageLabel}</span>
                  {l.dwellMs !== null && <span className={v.muted}>{dwellText(l, tr)}</span>}
                </span>
                {act && act !== l.stageLabel && <span className={v.act}>{act}</span>}
                {block && <span className={v.blk}>{block}</span>}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
