"use client";
/**
 * 分区列表的「已完成」：收着是一行（总数、近 24 小时完成数、最近 3 个），点开是搜索框 + 「今天 / 昨天 / 更早 / 时间未知」分段（SUBDAG5），
 * 默认只展开第一个非空段，每段先 20 行、每次再显示 50；全部没有完成时间时不出段标题，退回平铺。分段与搜索的规则在 focus-done-model.ts。
 * 全部完成（autoOpen）时默认展开；用户手动收起过的 feature 本次会话不再自动展开（模块级集合，FocusBoard 按 feature 重挂也记得住）。
 * 收着的段不卸载，只收成 0 高（高度过渡要它在）；跳转（reveal）先清搜索、展开所在段、分页扩到它，不带过渡，FocusBoard 才滚得准。
 */
import { useState, type KeyboardEvent } from "react";
import { Icon } from "../collab-icons";
import type { FocusModel } from "./subdag-focus";
import { relTime, type Ft } from "./focus-i18n";
import type { RowLinks } from "./focus-next";
import { doneSections, firstFilled, FIRST_ROWS, MORE_ROWS, rowsToShow, SECTION_KEYS, SECTION_WORD, undatedOnly, type DoneRow,
  type SectionKey } from "./focus-done-model";
import s from "./focus-board.module.css";
import st from "./focus-done.module.css";

const RECENT = 3;
/** 用户手动收起过已完成区的 feature：本次会话不再自动展开 */
const userClosed = new Set<string>();

interface Props {
  featureId: string;
  done: FocusModel["done"];
  done24h: number | null;
  autoOpen: boolean;
  now: number;
  links: RowLinks;
  /** FocusBoard 要滚到某个已完成节点：先展开、把它放进显示的行数里 */
  reveal: { key: string; seq: number } | null;
  ft: Ft;
}

const localMidnight = (now: number) => new Date(now).setHours(0, 0, 0, 0);
/** 今天完成的写时刻，更早的写日期 */
const stamp = (at: number, todayStart: number) => at >= todayStart
  ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  : new Date(at).toLocaleDateString([], { month: "numeric", day: "numeric" });

/** 新出现的已完成节点（这次渲染比上次多出来的 key）：淡入、所在段计数滚一下；首屏不算 */
function useFresh(done: readonly DoneRow[]): ReadonlySet<string> {
  const sig = done.map((d) => d.nodeKey).join("\n");
  const [seen, setSeen] = useState(sig);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  if (sig !== seen) {
    const prev = new Set(seen.split("\n"));
    setSeen(sig);
    setFresh(new Set(done.map((d) => d.nodeKey).filter((k) => !prev.has(k))));
  }
  return fresh;
}

export function FocusDone({ featureId, done, done24h, autoOpen, now, links, reveal, ft }: Props) {
  const [open, setOpen] = useState(() => autoOpen && !userClosed.has(featureId));
  const [query, setQuery] = useState("");
  /** 不搜时展开的段；null = 默认（第一个非空段） */
  const [picked, setPicked] = useState<ReadonlySet<SectionKey> | null>(null);
  /** 搜索时用户收起的段（搜索词一变就清空：结果全摊开） */
  const [shut, setShut] = useState<{ q: string; keys: ReadonlySet<SectionKey> }>({ q: "", keys: new Set() });
  const [rows, setRows] = useState<Record<SectionKey, number>>({ today: FIRST_ROWS, yesterday: FIRST_ROWS, earlier: FIRST_ROWS, undated: FIRST_ROWS });
  const [instant, setInstant] = useState<SectionKey | null>(null);
  const [revealed, setRevealed] = useState(0);
  const fresh = useFresh(done);
  const todayStart = localMidnight(now);
  const all = doneSections(done, todayStart, "");
  const browsing = picked ?? new Set([firstFilled(all)].filter((k): k is SectionKey => k !== null));
  if (reveal && reveal.seq !== revealed) {
    setRevealed(reveal.seq);
    const k = SECTION_KEYS.find((x) => all[x].some((d) => d.nodeKey === reveal.key));
    if (k) {
      const at = all[k].findIndex((d) => d.nodeKey === reveal.key);
      setOpen(true);
      setQuery("");
      setPicked(new Set([...browsing, k]));
      setRows((r) => ({ ...r, [k]: Math.max(r[k], rowsToShow(at)) }));
      setInstant(k);
    }
  }
  const searching = query.trim() !== "";
  const shown = searching ? doneSections(done, todayStart, query) : all;
  const isOpen = (k: SectionKey) => (searching ? !(shut.q === query && shut.keys.has(k)) : browsing.has(k));
  const toggleSection = (k: SectionKey) => {
    setInstant(null);
    const flip = (set: ReadonlySet<SectionKey>) => {
      const next = new Set(set);
      if (!next.delete(k)) next.add(k);
      return next;
    };
    if (searching) setShut({ q: query, keys: flip(shut.q === query ? shut.keys : new Set()) });
    else setPicked(flip(browsing));
  };
  const toggleAll = () => {
    if (open) userClosed.add(featureId);
    else userClosed.delete(featureId);
    setOpen(!open);
  };
  const recent = done.filter((d) => d.at !== null).slice(0, RECENT);
  const summary = [
    done24h !== null && ft("近 24 小时完成 {n}", { n: done24h }),
    recent.length > 0 && `${ft("最近")} ${recent.map((d) => `${d.nodeKey} ${relTime(d.at!, now, ft)}`).join("、")}`,
  ].filter(Boolean).join(" · ");
  const flat = undatedOnly(done);
  const filled = SECTION_KEYS.filter((k) => shown[k].length > 0);
  const section = (k: SectionKey) => <DoneSection key={k} k={k} rows={shown[k]} limit={rows[k]} open={flat || isOpen(k)} flat={flat} instant={instant === k}
    fresh={fresh} todayStart={todayStart} links={links} ft={ft} onToggle={() => toggleSection(k)} onMore={() => setRows((r) => ({ ...r, [k]: r[k] + MORE_ROWS }))} />;
  return (
    <>
      <div className={s.secHead}>
        <h3 className={s.secTitle}>
          <button type="button" aria-expanded={open} onClick={toggleAll}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />{ft("已完成 {n}", { n: done.length })}
          </button>
        </h3>
        {!open && summary && <span className={s.secNote}>{summary}</span>}
      </div>
      {open && (
        <div className={st.body} data-done-list>
          <SearchBox query={query} setQuery={setQuery} ft={ft} />
          {filled.length === 0 ? <p className={st.none}>{ft("没有匹配")}</p> : filled.map(section)}
        </div>
      )}
    </>
  );
}

function SearchBox({ query, setQuery, ft }: { query: string; setQuery: (q: string) => void; ft: Ft }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || !query) return;
    e.stopPropagation();
    setQuery("");
  };
  return (
    <div className={st.search}>
      <input type="text" value={query} placeholder={ft("搜索")} aria-label={ft("搜索")} spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      {query && <button type="button" className={st.clear} aria-label={ft("清除")} title={ft("清除")} onClick={() => setQuery("")}><Icon name="x" size={12} /></button>}
    </div>
  );
}

interface SectionProps {
  k: SectionKey; rows: DoneRow[]; limit: number; open: boolean; flat: boolean; instant: boolean; fresh: ReadonlySet<string>; todayStart: number;
  links: RowLinks; ft: Ft; onToggle: () => void; onMore: () => void;
}

function DoneSection({ k, rows, limit, open, flat, instant, fresh, todayStart, links, ft, onToggle, onMore }: SectionProps) {
  const bumped = rows.some((d) => fresh.has(d.nodeKey));
  return (
    <section className={st.section} data-done-section={k}>
      {!flat && (
        <h4 className={st.head}>
          <button type="button" aria-expanded={open} onClick={onToggle}>
            <Icon name="chevronRight" size={11} className={`${st.chev} ${open ? st.chevOpen : ""}`} />
            {ft(SECTION_WORD[k])} <span key={rows.length} className={`${st.count} ${bumped ? st.roll : ""}`}>{rows.length}</span>
          </button>
        </h4>
      )}
      <div className={`${st.fold} ${open ? st.open : ""} ${instant ? st.instant : ""}`} inert={!open}>
        <div className={st.inner}>
          {rows.slice(0, limit).map((d) => (
            <button key={d.nodeKey} type="button" className={`${s.row} ${d.cancelled ? s.cancelled : ""} ${fresh.has(d.nodeKey) ? st.enter : ""}`}
              data-focus-key={d.nodeKey} data-rel={links.rel(d.nodeKey)} onClick={() => links.onRow(d.nodeKey)}>
              <span className={s.key}>{d.nodeKey}</span>
              <span className={s.one} title={d.oneLine}>{d.oneLine}</span>
              <span className={s.rowEnd}>
                {[d.cancelled ? ft("已取消") : d.round > 0 ? ft("第 {n} 轮通过", { n: d.round }) : "", d.at !== null ? stamp(d.at, todayStart) : ""].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
          {rows.length > limit && <button type="button" className={s.more} onClick={onMore}>{ft("再显示 50")}</button>}
        </div>
      </div>
    </section>
  );
}
