"use client";
/**
 * 分区列表里「进行中」的一张卡（SUBDAG4），五行字段全给、不靠悬停：① key + 一句话 + 解锁数；② 步骤条 + 步骤词（owner-words.ts）+ 轮次 + 在等原因
 * （workText，和「谁在干活」同一句）+ 审查 / 返工轮数；③ 谁 + 机器 + 已耗与常规细条；④ 最近一条事件；⑤ 上下游一跳 chip。
 * 没数据的项整项不出（团队没有 since / normalMinutes / lastEvent），不写「暂无」。左边条：干活 s-run、在等 / 超常规 / 等 owner warn、
 * missing 描边、刚推进的那张 accent。点卡 = 打开节点页；点执行者（本机）= 跳「谁在干活」那一行；点 chip = 滚到那一行。
 */
import { useState, type MouseEvent } from "react";
import { fmtDuration, type Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import { workText } from "../work/work-i18n";
import { LOCAL_MACHINE } from "../team-instance-names";
import { StepBar } from "./dag-node";
import { nodeSteps } from "./dag-steps";
import type { BoardNode } from "./dag-types";
import type { FocusCard } from "./subdag-focus";
import { eventWord, relTime, stepWordOf, type Ft } from "./focus-i18n";
import s from "./focus-board.module.css";

/** 上游全部完成且多于这么多个时收成一枚 */
const UP_FOLD = 3;
const BIG_UNLOCK = 5;
/** 模型的「部署」「交付中」不是六格之一，按词认回步骤键 */
const MODEL_STEP: Record<string, string> = { 部署: "deploy", 交付中: "publishing" };

export interface CardProps {
  card: FocusCard;
  node: BoardNode | undefined;
  now: number;
  hot: boolean;
  leaving: boolean;
  onOpen: (key: string) => void;
  /** 执行者在本机时给：跳「谁在干活」那一行 */
  onOwner: ((agent: string, taskId: string | null) => void) | null;
  onChip: (key: string) => void;
  onHover: (card: FocusCard | null) => void;
  ft: Ft;
  tr: Tr;
}

/** 步骤词 + 轮次：格名按当前格的键换成 owner 词；轮次为 null / 0 只写步骤词 */
export function stepLabel(card: FocusCard, node: Pick<BoardNode, "stepLine"> | undefined, ft: Ft): string | null {
  if (!card.step) return null;
  const cur = nodeSteps(node?.stepLine).current;
  const key = cur && cur.label === card.step.label ? cur.key : MODEL_STEP[card.step.label];
  const word = key ? stepWordOf(key, ft) : null;
  if (!word) return null;
  return card.step.round ? `${word} · ${ft("第 {n} 轮", { n: card.step.round })}` : word;
}

const stateClass = (c: FocusCard, hot: boolean) => (hot ? s.hot : c.state === "working" ? s.run : s.wait);
const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

/** 已耗 / 常规：条内是常规以内的部分，超出的画在条外并整条变 warn；不写字 */
function Dwell({ card, now, tr }: { card: FocusCard; now: number; tr: Tr }) {
  if (card.since === null) return null;
  const ms = Math.max(0, now - card.since);
  const ratio = card.normalMinutes ? ms / (card.normalMinutes * 60_000) : null;
  return (
    <>
      <span className={s.dwell}>{fmtDuration(ms, tr)}</span>
      {ratio !== null && (
        <span className={`${s.track} ${ratio > 1 ? s.trackOver : ""}`} aria-hidden>
          <span className={s.fill} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
          {ratio > 1 && <span className={s.overflow} style={{ width: `${Math.min(1, ratio - 1) * 100}%` }} />}
        </span>
      )}
    </>
  );
}

function Chips({ card, onChip, ft }: Pick<CardProps, "card" | "onChip" | "ft">) {
  const [open, setOpen] = useState(true);
  if (!card.up.length && !card.down.length) return null;
  const upFolded = card.up.length > UP_FOLD && card.up.every((u) => u.done);
  return (
    <div className={s.chips}>
      <button type="button" className={s.chipToggle} aria-expanded={open} aria-label={ft(open ? "收起" : "展开")} onClick={stop(() => setOpen((o) => !o))}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
      </button>
      {!open ? <span className={s.faint}>{ft("上游")} {card.up.length} · {ft("下游")} {card.down.length}</span> : <>
        {card.up.length > 0 && <span className={s.faint}>{ft("上游")}</span>}
        {upFolded ? <span className={`${s.chip} ${s.chipOk}`}><Icon name="check" size={10} />{ft("上游全部完成")}</span>
          : card.up.map((u) => (
            <button key={u.nodeKey} type="button" className={`${s.chip} ${u.done ? s.chipOk : ""}`} onClick={stop(() => onChip(u.nodeKey))}>
              {u.done && <Icon name="check" size={10} />}{u.nodeKey}
            </button>
          ))}
        {card.down.length > 0 && <span className={s.faint}>{ft("下游")}</span>}
        {card.down.map((k) => <button key={k} type="button" className={s.chip} onClick={stop(() => onChip(k))}>{k}</button>)}
      </>}
    </div>
  );
}

export function FocusCardView(p: CardProps) {
  const { card: c, ft, tr } = p;
  const [firstAt] = useState(c.lastEvent?.at ?? null);
  const step = stepLabel(c, p.node, ft);
  const waiting = c.state === "owner" || c.state === "waiting";
  const machine = c.machine === null ? null : c.machine === "local" ? ft("本机") : c.machine;
  const ownerClick = p.onOwner && c.who && (c.machine === "local" || c.machine === LOCAL_MACHINE) ? p.onOwner : null;
  const ev = c.lastEvent;
  const cls = [s.card, stateClass(c, p.hot), c.missing && s.missing, p.leaving && s.leaving].filter(Boolean).join(" ");
  return (
    <div className={cls} data-focus-key={c.nodeKey} data-state={c.state} onClick={() => p.onOpen(c.nodeKey)}
      onMouseEnter={() => p.onHover(c)} onMouseLeave={() => p.onHover(null)} onFocus={() => p.onHover(c)} onBlur={() => p.onHover(null)}>
      <button type="button" className={s.cardMain} onClick={stop(() => p.onOpen(c.nodeKey))}>
        <span className={s.line}>
          <span className={`${s.dot} ${c.state === "working" ? s.breathe : ""}`} aria-hidden />
          <span className={s.key}>{c.nodeKey}</span>
          <span className={s.one} title={c.oneLine}>{c.oneLine}</span>
          {c.unlock > 0 && <span className={`${s.badge} ${c.unlock >= BIG_UNLOCK ? s.badgeBig : ""}`}>{ft("解锁 {n}", { n: c.unlock })}</span>}
        </span>
        <span className={s.line}>
          {p.node && <span className={s.stepBar}><StepBar node={p.node} /></span>}
          {step && <span className={s.step}>{step}</span>}
          {waiting && c.reason && <span className={s.reason}>{workText(tr, c.reason)}</span>}
          {c.rounds && c.rounds.review + c.rounds.fix > 0 && <span className={s.faint}>{ft("审查 {r} 轮 · 返工 {f} 轮", { r: c.rounds.review, f: c.rounds.fix })}</span>}
        </span>
      </button>
      {(c.who || machine || c.since !== null) && (
        <div className={s.line}>
          {c.who && (ownerClick
            ? <button type="button" className={s.who} onClick={stop(() => ownerClick(c.who!, c.taskId))}>{c.who}</button>
            : <span className={s.whoText}>{c.who}</span>)}
          {machine && <span className={s.faint}>{machine}</span>}
          <Dwell card={c} now={p.now} tr={tr} />
        </div>
      )}
      {ev && (
        <div key={ev.at} className={`${s.event} ${ev.at !== firstAt ? s.eventIn : ""}`} title={ev.text || undefined}>
          {relTime(ev.at, p.now, ft)} · {eventWord(ev.kind, ft)}{ev.text ? `：${ev.text}` : ""}
        </div>
      )}
      <Chips card={c} onChip={p.onChip} ft={ft} />
    </div>
  );
}
