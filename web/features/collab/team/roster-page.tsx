"use client";
import { useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { useLang } from "@/lib/i18n";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { useChatStore } from "../../chat/chat-store";
import { closeCollab, openCollab, showTeamView } from "../collab-nav";
import { Icon } from "../collab-icons";
import { useCollabT } from "../collab-i18n";
import { BLOCKED_REASON, useCollabChoice } from "../team-view-entry";
import { TeamPanel } from "../team-panel";
import { useTeamRoster } from "./use-team-roster";
import { teamNameOf } from "./team-entry";
import { useEntryT } from "./entry-i18n";
import c from "../collab.module.css";
import s from "./roster-page.module.css";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

/**
 * Standalone team page for one local project (collab-nav view "team"). The dropdown and member count come from the snapshot
 * use-team-roster already reads, the body is the same TeamPanel as the collab view's team tab (local source, no ledger overview).
 */
export function RosterPage({ project }: { project: string }) {
  const t = useEntryT();
  const data = useTeamRoster(project);
  const agents = useChatStore((st) => st.state.agents);
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  const options = data.projects.some(p => p.localId === project) ? data.projects : [{ localId: project, name: project }, ...data.projects];
  // Server clock only (never the browser's): without a roster nothing time-based renders, machines and workers come from it,
  // and the flow tab prefers its own activity clock.
  const now = data.roster?.now ?? 0;
  return <div className={`${c.tokens} ${s.page}`} data-collab-view="team">
    <header className={s.top}>
      <button type="button" className={s.back} aria-label={t("返回")} title={t("返回")} onClick={closeCollab}><Icon name="arrowLeft" size={16} /></button>
      <div className={s.title}>
        <span className={s.kicker}>{t("团队")}</span>
        <h1>{teamNameOf(project) ?? t("团队")}</h1>
        {data.directory && <span className={s.count}>{data.directory.length} {t("人")}</span>}
      </div>
      <div className={s.actions}>
        <select className={s.select} aria-label={t("项目")} value={project} onChange={(e) => showTeamView(e.target.value)}>
          {options.map(p => <option key={p.localId} value={p.localId}>{p.name}</option>)}
        </select>
        {fp ? <OpenInCollab key={fp + project} fp={fp} project={project} /> : null}
      </div>
    </header>
    <div className={s.body}>
      <TeamPanel ov={null} project={project} agents={agents} now={now} />
    </div>
  </div>;
}

/** Same source choice as the sidebar team rows (projects-entry.tsx): the center key when bound, the local id when not, disabled while blocked. */
function OpenInCollab({ fp, project }: { fp: string; project: string }) {
  const t = useEntryT(), collabT = useCollabT(), projectTr = sharedProjectsTr(useLang());
  const { choice } = useCollabChoice(fp, project);
  const key = choice.kind === "center" ? choice.key : choice.kind === "local" ? project : null;
  const reason = choice.kind === "blocked" ? (choice.reason === "ambiguous" ? projectTr : collabT)(BLOCKED_REASON[choice.reason]) : null;
  const open = () => { if (key && machines.currentFp() === fp) openCollab(key); };
  return <button type="button" className={s.open} disabled={!key} title={reason ?? t("在协作视图打开")} onClick={open}>
    {t("在协作视图打开")}<Icon name="chevronRight" size={14} />
  </button>;
}
