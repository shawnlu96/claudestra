"use client";
import { useEffect, useRef, useState } from "react";
import type { Cell, SlotCells } from "./roster-model";
import { rosterText, useRosterT } from "./roster-i18n";
import s from "./team-roster.module.css";
const STATE_LABELS = { running: "在用", silent: "心跳停", pending: "待开工", other: "其他项目", held: "额度到线", empty: "空闲", unknown: "未知" };
function CellBox({ cell, now }: { cell: Cell; now: number }) {
  const t = useRosterT();
  const previous = useRef(cell.state);
  const [motion, setMotion] = useState("");
  const [tip, setTip] = useState(false);
  const w = cell.worker;
  const state = cell.state;
  useEffect(() => {
    const old = previous.current;
    previous.current = state;
    const occupied = !["empty", "held", "unknown"].includes(state);
    const change = old === "empty" && occupied ? s.arrive : state === "empty" && old !== "empty" ? s.release : "";
    if (!change) return;
    const timer = setTimeout(() => setMotion(change), 0);
    const end = setTimeout(() => setMotion(""), 2600);
    return () => { clearTimeout(timer); clearTimeout(end); };
  }, [state]);
  const detail = w ? [rosterText(w.card, t("暂无")), rosterText(w.step, t("暂无")), w.round == null ? t("暂无") : `${t("轮")} ${w.round}`,
    w.since == null ? t("暂无") : `${Math.max(0, Math.floor((now - w.since) / 60_000))} ${t("分钟")}`, rosterText(w.name, t("暂无"))].join(" · ") : t(STATE_LABELS[cell.state]);
  return <span className={s.cellTarget} onPointerEnter={() => setTip(true)} onPointerLeave={() => setTip(false)}
    onPointerDown={() => setTip(true)} onPointerUp={() => setTip(false)} onFocus={() => setTip(true)} onBlur={() => setTip(false)} tabIndex={w ? 0 : undefined}>
    <span className={`${s.cell} ${s[cell.state]} ${motion}`} aria-label={detail} title={detail} />
    {tip && w && <span role="tooltip" className={s.tooltip}>{detail}</span>}
  </span>;
}
/** loading = seats not read yet: the strip's own box says so, the same box the cells fill when they land. */
export function SlotStrip({ family, slots, now, reason, loading = false }: { family: string; slots: SlotCells | null; now: number; reason: string; loading?: boolean }) {
  const t = useRosterT();
  const unknown = !slots || slots.cells.some(c => c.state === "unknown");
  return <div className={s.slotRow}>
    <span className={s.family}>{family}</span>
    {loading ? <span className={s.unknownStrip} aria-busy title={t(reason)}>{t("读取中")}</span> : unknown ? <span className={s.unknownStrip} title={t(reason)}>{t("未知")}</span>
      : <><span className={s.cells}>{slots.cells.map((cell, i) => <CellBox key={i} cell={cell} now={now} />)}</span>
        <span className={s.usage} title={t("在跑/总数")}>{slots.label}</span></>}
  </div>;
}
export function SlotLegend() {
  const t = useRosterT();
  return <div className={s.legend}>{Object.entries(STATE_LABELS).filter(([key]) => key !== "unknown").map(([key, text]) =>
    <span key={key}><i className={`${s.cell} ${s[key]}`} />{t(text)}</span>)}</div>;
}
