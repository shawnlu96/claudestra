"use client";
/**
 * 分区列表的「已完成」（SUBDAG4）：收着是一行（总数、近 24 小时数、最近 3 个），点开是按模型顺序的平铺列表，先 20 行、每次再显示 50；
 * 取消的划删除线。全部完成（autoOpen）时默认展开。搜索和按天分段由 SUBDAG5 接着在这个文件里加。
 */
import { useState } from "react";
import { Icon } from "../collab-icons";
import type { FocusModel } from "./subdag-focus";
import { relTime, type Ft } from "./focus-i18n";
import type { RowLinks } from "./focus-next";
import s from "./focus-board.module.css";

const FIRST_ROWS = 20;
const MORE_ROWS = 50;
const RECENT = 3;

interface Props {
  done: FocusModel["done"];
  done24h: number | null;
  autoOpen: boolean;
  now: number;
  links: RowLinks;
  /** FocusBoard 要滚到某个已完成节点：先展开、把它放进显示的行数里 */
  reveal: { key: string; seq: number } | null;
  ft: Ft;
}

export function FocusDone({ done, done24h, autoOpen, now, links, reveal, ft }: Props) {
  const [open, setOpen] = useState(autoOpen);
  const [rows, setRows] = useState(FIRST_ROWS);
  const [revealed, setRevealed] = useState(0);
  if (reveal && reveal.seq !== revealed) {
    setRevealed(reveal.seq);
    const at = done.findIndex((d) => d.nodeKey === reveal.key);
    if (at >= 0) {
      setOpen(true);
      if (at >= rows) setRows(FIRST_ROWS + Math.ceil((at + 1 - FIRST_ROWS) / MORE_ROWS) * MORE_ROWS);
    }
  }
  const recent = done.filter((d) => d.at !== null).slice(0, RECENT);
  const summary = [
    done24h !== null && ft("近 24 小时 {n}", { n: done24h }),
    recent.length > 0 && `${ft("最近")} ${recent.map((d) => `${d.nodeKey} ${relTime(d.at!, now, ft)}`).join("、")}`,
  ].filter(Boolean).join(" · ");
  return (
    <>
      <div className={s.secHead}>
        <h3 className={s.secTitle}>
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />{ft("已完成 {n}", { n: done.length })}
          </button>
        </h3>
        {!open && summary && <span className={s.secNote}>{summary}</span>}
      </div>
      {open && done.slice(0, rows).map((d) => (
        <button key={d.nodeKey} type="button" className={`${s.row} ${d.cancelled ? s.cancelled : ""}`} data-focus-key={d.nodeKey} data-rel={links.rel(d.nodeKey)}
          onClick={() => links.onRow(d.nodeKey)}>
          <span className={s.key}>{d.nodeKey}</span>
          <span className={s.one} title={d.oneLine}>{d.oneLine}</span>
          <span className={s.rowEnd}>
            {[d.cancelled ? ft("已取消") : d.round > 0 ? ft("第 {n} 轮通过", { n: d.round }) : "", d.at !== null ? relTime(d.at, now, ft) : ""].filter(Boolean).join(" · ")}
          </span>
        </button>
      ))}
      {open && done.length > rows && <button type="button" className={s.more} onClick={() => setRows((n) => n + MORE_ROWS)}>{ft("再显示 50")}</button>}
    </>
  );
}
