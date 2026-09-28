"use client";
/**
 * 首页顶部的「上次来之后」卡片（T12c，ux.md 场景 1 / 6）：最多 5 条，点一条开那条任务的详情；「知道了」记为看过并收起。
 * 没有上次（第一次来 / 老 bridge）或这段时间什么都没发生，就不出卡片。
 */
import { fmtEventTime } from "./collab-detail-model";
import { Icon } from "./collab-icons";
import type { Tr } from "./collab-model";
import type { SinceDigest } from "./collab-since";
import base from "./collab.module.css";
import s from "./collab-v2.module.css";

const TONE = { red: base.red, amber: base.amber, neutral: base.neutral, green: base.green } as const;

export function SinceCard(props: { digest: SinceDigest; since: number; truncated: boolean; now: number; tr: Tr; onOpen: (id: string) => void; onDismiss: () => void }) {
  const { digest, since, truncated, now, tr, onOpen, onDismiss } = props;
  if (!digest.items.length) return null;
  return (
    <section className={s.since} aria-label={tr("上次来之后")}>
      <div className={s.sinceHd}>
        <Icon name="history" size={14} />
        <b>{tr("上次来之后")}</b>
        <span>{tr("{t} 起", { t: fmtEventTime(since, now, tr) })}</span>
        <button type="button" className={s.ok} onClick={onDismiss}>
          {tr("知道了")}
        </button>
      </div>
      {digest.items.map((i) => (
        <button key={i.taskId} type="button" className={`${s.si} ${TONE[i.tone]}`} onClick={() => onOpen(i.taskId)}>
          <i />
          <span className={s.tx}>{i.text}</span>
          <span className={s.tt}>{i.title}</span>
        </button>
      ))}
      {/* truncated：服务端只给了最新的一段（src/lib/ledger-since.ts），更早的变化没列进来 */}
      {digest.more > 0 && <div className={s.more}>{tr(truncated ? "另 {n}+ 件" : "另 {n} 件", { n: digest.more })}</div>}
      {digest.more === 0 && truncated && <div className={s.more}>{tr("更早的变化没列全")}</div>}
    </section>
  );
}
