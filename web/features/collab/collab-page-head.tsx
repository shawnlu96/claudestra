"use client";
/**
 * 协作视图页头（UXHOME1）：项目名；团队源多一行小字「团队版 · …」，说清看的是团队版、数据多久前同步的。
 * 新鲜度只在这一处（右栏原来的那一节去掉了）：有过期的写过期个数（警示色），点它原地展开是哪几个；都没过期写最早那份多久前同步；
 * 一份都没收到写还没收到。本机源只有项目名，和以前一样。手机顶栏的「团队 / 规划与提案」按钮也在这里，跟着数据源换名字。
 * 样式写在行内：v4.module.css 的 .top 是一行 flex，这里只多一个竖排的小块，不为它动公共样式表。
 */
import { useContext, useMemo, useState, type CSSProperties } from "react";
import { useLang } from "@/lib/i18n";
import { headMirror, headMirrorText, headTr, HEAD_WORDS } from "./collab-head-i18n";
import { Icon } from "./collab-icons";
import type { LedgerOverview, Tr } from "./collab-model";
import { CollabSourceContext } from "./team-source-context";
import v from "./v4/v4.module.css";

/** 看的是不是团队版：团队视图在 CollabView 外面包了数据源（team-source-context.ts），本机没有 */
export const useTeamSourced = (): boolean => useContext(CollabSourceContext) !== null;

/** 「团队」标签 / 手机按钮 / 手机整屏页的名字与副标题：团队源装的是规划与提案，本机源逐字不变 */
export function useTeamTab(tr: Tr): { label: string; sub: string } {
  const team = useTeamSourced(), lang = useLang();
  return useMemo(() => {
    const h = headTr(lang);
    return team ? { label: h(HEAD_WORDS.planTab), sub: h(HEAD_WORDS.planSub) } : { label: tr("团队"), sub: tr("最近 10 分钟的真实往来") };
  }, [team, lang, tr]);
}

/** 竖排小块先让：手机顶栏放不下时项目名和那行小字省略，按钮不折行 */
const COL: CSSProperties = { display: "flex", flexDirection: "column", flex: "1 1 0", minWidth: 0, gap: 1 };
const KEEP: CSSProperties = { whiteSpace: "nowrap", flex: "none" };
const NAME: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis" };
const LINE: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, padding: 0, textAlign: "left", fontSize: "var(--fs-3)", color: "var(--muted)",
  whiteSpace: "nowrap" };
const CLIP: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis" };
const FOLD: CSSProperties = { display: "grid", transition: "grid-template-rows .2s ease-out" };
const LIST: CSSProperties = { minHeight: 0, overflow: "hidden", margin: 0, padding: 0, listStyle: "none", fontSize: "var(--fs-3)", color: "var(--text-2)" };

function MirrorLine({ ov, now }: { ov: Pick<LedgerOverview, "mirror" | "items">; now: number }) {
  const h = headTr(useLang());
  const [open, setOpen] = useState(false);
  const m = headMirror(ov, now);
  const text = `${h(HEAD_WORDS.team)} · ${headMirrorText(m, now, h)}`;
  // 窄屏省略时整句在 title 里
  if (m.state !== "stale") return <span style={LINE} data-collab-head={m.state} title={text}><span style={CLIP}>{text}</span></span>;
  return (
    <>
      <button type="button" style={{ ...LINE, color: "var(--warn)" }} data-collab-head="stale" aria-expanded={open} title={h(HEAD_WORDS.showStale)} onClick={() => setOpen((x) => !x)}>
        <span style={CLIP}>{text}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={12} />
      </button>
      {/* 原地展开，不跳页：grid 行 0fr → 1fr 的高度过渡；收起时 inert，名单不进 Tab 序 */}
      <div style={{ ...FOLD, gridTemplateRows: open ? "1fr" : "0fr" }}>
        <ul style={LIST} inert={!open} data-collab-head-stale>
          {m.names.map((n, i) => <li key={`${i}:${n}`} style={CLIP}>{n}</li>)}
        </ul>
      </div>
    </>
  );
}

/** onTeam：手机顶栏那个按钮（桌面是中区标签，不给） */
export function CollabPageHead({ name, ov, now, tr, onTeam }: { name: string; ov: Pick<LedgerOverview, "mirror" | "items">; now: number; tr: Tr; onTeam?: () => void }) {
  const team = useTeamSourced(), tab = useTeamTab(tr);
  return (
    <>
      <div style={COL}>
        <span className={v.ttl} style={NAME}>{name}</span>
        {team && <MirrorLine ov={ov} now={now} />}
      </div>
      {onTeam && <button type="button" className={v.teamM} style={KEEP} onClick={onTeam}>{tab.label}</button>}
    </>
  );
}
