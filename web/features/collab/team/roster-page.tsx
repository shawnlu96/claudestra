"use client";
import { useEffect, useSyncExternalStore } from "react";
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
import { useEntryT } from "./entry-i18n";
import c from "../collab.module.css";
import s from "./roster-page.module.css";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

/**
 * This team's bound local projects as last listed, by local project id. Once a later snapshot drops the open project's binding,
 * use-team-roster no longer finds its team (empty list), so the page moves to the next remembered sibling and that sibling's own
 * read confirms or rejects it; every rejected id leaves the list, so the walk ends. Module-level: the pane remounts per project.
 */
const siblings = new Map<string, readonly string[]>();
function remember(ids: readonly string[]) { for (const id of ids) siblings.set(id, ids); }
function forget(project: string): string | null {
  const rest = (siblings.get(project) ?? []).filter(id => id !== project);
  siblings.delete(project);
  remember(rest);
  return rest[0] ?? null;
}

/**
 * Standalone team page for one local project (collab-nav view "team"). The dropdown and member count come from the snapshot
 * use-team-roster already reads, the body is the same TeamPanel as the collab view's team tab (local source, no ledger overview).
 */
export function RosterPage({ project }: { project: string }) {
  const t = useEntryT();
  const data = useTeamRoster(project);
  const agents = useChatStore((st) => st.state.agents);
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  const listed = data.projects.some(p => p.localId === project);
  // Only a snapshot that was read and lacks the binding proves it is gone; loading or a failed first read is not that.
  const gone = data.snapshotReady && !listed;
  const ids = data.projects.map(p => p.localId).join("\n");
  useEffect(() => {
    if (ids) remember(ids.split("\n"));
    if (!gone) return;
    const next = forget(project);
    if (next) showTeamView(next);
  }, [ids, gone, project]);
  // Server clock only (never the browser's): without a roster nothing time-based renders, machines and workers come from it,
  // and the flow tab prefers its own activity clock.
  const now = data.roster?.now ?? 0;
  return <div className={`${c.tokens} ${s.page}`} data-collab-view="team">
    <header className={s.top}>
      <button type="button" className={s.back} aria-label={t("返回")} title={t("返回")} onClick={closeCollab}><Icon name="arrowLeft" size={16} /></button>
      <div className={s.title}>
        <span className={s.kicker}>{t("团队")}</span>
        <h1>{data.teamName ?? t("团队")}</h1>
        {data.directory && <span className={s.count}>{data.directory.length} {t("人")}</span>}
      </div>
      <div className={s.actions}>
        {listed && <select className={s.select} aria-label={t("项目")} value={project} onChange={(e) => showTeamView(e.target.value)}>
          {data.projects.map(p => <option key={p.localId} value={p.localId}>{p.name}</option>)}
        </select>}
        {fp && !gone ? <OpenInCollab key={fp + project} fp={fp} project={project} /> : null}
      </div>
    </header>
    <div className={s.body}>
      {gone ? <p className={s.gone} data-roster-page="unbound">{t("这个项目已不再绑定到这个团队")}</p>
        : <TeamPanel ov={null} project={project} agents={agents} now={now} />}
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
