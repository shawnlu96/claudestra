"use client";
import { useId, useState, type ReactNode } from "react";
import { useRosterT } from "./roster-i18n";
import s from "./team-roster.module.css";
import { takeCollabTab, useCollabTabHint } from "../../nav/collab-tab-hint";
/** undefined = this view never has the tab (decided on the first render); null = its body has not arrived yet. */
interface Props { members: ReactNode; flow?: ReactNode; ops?: ReactNode }
/**
 * The host keys this container by project; moving to another project starts on members.
 * A body that arrives late fills its tab in place: the strip never grows or reorders after the first render.
 */
export function TeamTabs({ members, flow, ops }: Props) {
  const t = useRosterT(), id = useId();
  const [selected, setSelected] = useState<string>(() => takeCollabTab() ?? "members"); // 团队页「规划与提案」直达（nav/collab-tab-hint.ts）
  useCollabTabHint((tab) => { takeCollabTab(); setSelected(tab); });
  const tabs = [{ key: "members", name: "成员", body: members }, { key: "ops", name: "规划与提案", body: ops }, { key: "flow", name: "往来", body: flow }]
    .filter(tab => tab.body !== undefined);
  const active = tabs.find(tab => tab.key === selected) ?? tabs[0];
  return <section className={s.container}>
    <div role="tablist" aria-label={t("成员与位子")} className={s.tabs}>
      {tabs.map(tab => <button type="button" role="tab" key={tab.key} aria-selected={active?.key === tab.key}
        id={`${id}-${tab.key}`} aria-controls={`${id}-${tab.key}-panel`} tabIndex={active?.key === tab.key ? 0 : -1}
        className={active?.key === tab.key ? s.tabOn : ""} onClick={() => setSelected(tab.key)} onKeyDown={e => {
          const at = tabs.indexOf(tab), step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          const next = step ? tabs[(at + step + tabs.length) % tabs.length] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : null;
          if (next) { e.preventDefault(); setSelected(next.key); document.getElementById(`${id}-${next.key}`)?.focus(); }
        }}>{t(tab.name)}</button>)}
    </div>
    {/* Keep the member subscription alive across child-tab changes, so a switch never starts another read. */}
    {tabs.map(tab => <div key={tab.key} role="tabpanel" id={`${id}-${tab.key}-panel`} aria-labelledby={`${id}-${tab.key}`} hidden={active?.key !== tab.key}>
      {tab.body ?? <p className={s.note} aria-busy>{t("暂无")}</p>}</div>)}
  </section>;
}
