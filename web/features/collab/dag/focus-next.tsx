"use client";
/**
 * 分区列表的「接下来」（SUBDAG4）：可以开工逐行（0 行时一行淡字）、下一批按解锁数降序最多 8 行（多的收成「+N」）、更远一行 chip（点开逐行写还差几层）。
 * useExiting 也在这里：离开列表的项（完成的卡、移进可以开工的行）多留一拍做淡出收起，FocusBoard 和本区共用。
 */
import { useEffect, useState } from "react";
import { Icon } from "../collab-icons";
import { workText } from "../work/work-i18n";
import type { Tr } from "../collab-model";
import type { FocusModel, IdleRow } from "./subdag-focus";
import { READY_WORD } from "@/lib/owner-words";
import type { Ft } from "./focus-i18n";
import s from "./focus-board.module.css";

/** 淡出收起的时长，和 focus-board.module.css 的 .leaving 动画一致 */
export const EXIT_MS = 360;
const ONE_HOP_ROWS = 8;

/**
 * 上一轮在、这一轮不在的项多留 EXIT_MS（标 leaving），插回原来的位置；按 key 比，不按数组身份（模型随时钟重算，数组每轮都是新的）
 */
export function useExiting<T>(items: readonly T[], keyOf: (x: T) => string): { item: T; leaving: boolean }[] {
  const sig = items.map(keyOf).join("\n");
  const [prev, setPrev] = useState<{ sig: string; items: readonly T[] }>({ sig, items });
  const [gone, setGone] = useState<{ item: T; at: number }[]>([]);
  if (prev.sig !== sig) {
    const now = new Set(items.map(keyOf));
    const left = prev.items.flatMap((x, at) => (now.has(keyOf(x)) ? [] : [{ item: x, at }]));
    setPrev({ sig, items });
    setGone((g) => [...g.filter((x) => !now.has(keyOf(x.item))), ...left]);
  }
  useEffect(() => {
    if (!gone.length) return;
    const t = window.setTimeout(() => setGone([]), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [gone]);
  const out = items.map((item) => ({ item, leaving: false }));
  for (const g of gone) out.splice(Math.min(g.at, out.length), 0, { item: g.item, leaving: true });
  return out;
}

export interface RowLinks {
  /** 悬停 / 聚焦的卡的上下游一跳：on = 相关，off = 无关（变淡），undefined = 没有卡在悬停 */
  rel: (key: string) => "on" | "off" | undefined;
  onRow: (key: string) => void;
}

function Row({ r, end, links, leaving, arrive }: { r: IdleRow; end: string | null; links: RowLinks; leaving?: boolean; arrive?: boolean }) {
  const cls = [s.row, leaving && s.leaving, arrive && s.arrive].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} data-focus-key={r.nodeKey} data-rel={links.rel(r.nodeKey)} onClick={() => links.onRow(r.nodeKey)}>
      <span className={s.key}>{r.nodeKey}</span>
      <span className={s.one} title={r.oneLine}>{r.oneLine}</span>
      {end && <span className={s.rowEnd}>{end}</span>}
    </button>
  );
}

/** reveal：FocusBoard 要滚到某一行（chip / 跳转）时先把它所在的折叠打开；seq 变了才处理一次 */
export function FocusNext({ next, links, reveal, ft, tr }: { next: FocusModel["next"]; links: RowLinks; reveal: { key: string; seq: number } | null; ft: Ft; tr: Tr }) {
  const [more, setMore] = useState(false);
  const [farOpen, setFarOpen] = useState(false);
  const [revealed, setRevealed] = useState(0);
  if (reveal && reveal.seq !== revealed) {
    setRevealed(reveal.seq);
    if (next.oneHop.findIndex((r) => r.nodeKey === reveal.key) >= ONE_HOP_ROWS) setMore(true);
    if (next.far.some((r) => r.nodeKey === reveal.key)) setFarOpen(true);
  }
  const hop = useExiting(next.oneHop, (r) => r.nodeKey);
  // 下一批里正在淡出、同时已出现在可以开工的：那一行淡入（先出后进）
  const arrived = new Set(hop.filter((x) => x.leaving).map((x) => x.item.nodeKey));
  const shown = more ? hop : hop.slice(0, ONE_HOP_ROWS);
  const hidden = hop.filter((x) => !x.leaving).length - shown.filter((x) => !x.leaving).length;
  const readyEnd = (r: IdleRow) => [r.estimate, r.reason && workText(tr, r.reason)].filter(Boolean).join(" · ") || null;
  return (
    <>
      {next.ready.length ? (
        <>
          <div className={s.sub}>{ft(`${READY_WORD} {n}`, { n: next.ready.length })}</div>
          {next.ready.map((r) => <Row key={r.nodeKey} r={r} end={readyEnd(r)} links={links} arrive={arrived.has(r.nodeKey)} />)}
        </>
      ) : <div className={`${s.sub} ${s.faint}`}>{ft(`${READY_WORD} {n}`, { n: 0 })}</div>}
      {hop.length > 0 && <div className={s.sub}>{ft("下一批 {n}", { n: next.oneHop.length })}</div>}
      {shown.map(({ item: r, leaving }) => (
        <Row key={r.nodeKey} r={r} leaving={leaving} links={links} end={r.waitsOn.length ? ft("等 {x}", { x: r.waitsOn.join(" · ") }) : null} />
      ))}
      {hidden > 0 && <button type="button" className={s.more} onClick={() => setMore(true)}>{ft("+{n}", { n: hidden })}</button>}
      {next.far.length > 0 && (
        <div className={s.farLine}>
          <button type="button" className={s.sub} aria-expanded={farOpen} onClick={() => setFarOpen((o) => !o)}>
            <Icon name={farOpen ? "chevronDown" : "chevronRight"} size={12} />{ft("更远 {n}", { n: next.far.length })}
          </button>
          {!farOpen && next.far.map((r) => (
            <button key={r.nodeKey} type="button" className={s.chip} data-focus-key={r.nodeKey} data-rel={links.rel(r.nodeKey)} title={r.oneLine}
              onClick={() => setFarOpen(true)}>{r.nodeKey}</button>
          ))}
        </div>
      )}
      {farOpen && next.far.map((r) => <Row key={r.nodeKey} r={r} links={links} end={ft("还差 {n} 层", { n: r.hops })} />)}
    </>
  );
}
