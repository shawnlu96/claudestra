"use client";
import { teamKey, type ProjectSnapshot, type ProjectTeam } from "@/lib/shared-projects-model";
import { useChatNav } from "../../chat/components/nav-context";
import { showTeamView, useCollabNav } from "../collab-nav";
import { sharedIdentity } from "../team-source-key";
import { rosterText } from "./roster-i18n";
import { useEntryT } from "./entry-i18n";

const SHOWN = 4;
/**
 * Team display names by local project id, recorded when an avatar stack opens the team page: the page's own snapshot read
 * (use-team-roster) does not expose the team record, and a second snapshot read is what this entry must not add.
 */
const teamNames = new Map<string, string | null>();
export const teamNameOf = (project: string): string | null => teamNames.get(project) ?? null;

/** This team's projects bound on this machine, in snapshot order (the same filter as use-team-roster's dropdown list). */
const boundLocals = (snapshot: ProjectSnapshot, team: ProjectTeam) =>
  snapshot.projects.filter(p => p.local && p.centerId === team.centerId && p.teamId === team.teamId);

/** The open collab project when it belongs to this team (local id or center key), else the team's first bound local project. */
export function teamLocalProject(snapshot: ProjectSnapshot, team: ProjectTeam, open: string | null): string | null {
  const mine = boundLocals(snapshot, team);
  const id = open ? sharedIdentity(open) : null;
  const hit = open ? mine.find(p => id ? p.centerId === id.center && p.teamId === id.team && p.projectId === id.project : p.local!.id === open) : undefined;
  return (hit ?? mine[0])?.local!.id ?? null;
}

/** Sidebar team header: one avatar stack per team with a directory, from the panel's existing snapshot (no read of its own). */
export function TeamEntry({ snapshot }: { snapshot: ProjectSnapshot | null }) {
  const teams = snapshot?.teams.filter(t => t.directory?.length) ?? [];
  if (!snapshot || !teams.length) return null;
  return <div className="flex min-w-0 flex-1 items-center gap-1">
    {teams.map(t => <AvatarStack key={teamKey(t)} snapshot={snapshot} team={t} />)}
  </div>;
}

function AvatarStack({ snapshot, team }: { snapshot: ProjectSnapshot; team: ProjectTeam }) {
  const t = useEntryT();
  const nav = useChatNav();
  const open = useCollabNav().project;
  const members = team.directory ?? [];
  const codes = members.map(m => rosterText(m.code, "?"));
  const target = teamLocalProject(snapshot, team, open);
  const go = () => {
    if (!target) return;
    for (const p of boundLocals(snapshot, team)) teamNames.set(p.local!.id, team.team?.name ?? null);
    showTeamView(target);
    nav.toContent();
  };
  return <button type="button" disabled={!target} onClick={go} data-team-entry={team.teamId}
    aria-label={`${t("团队成员")}（${members.length}）`} title={target ? codes.join("、") : t("这个团队还没有绑定本机项目")}
    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-1 hover:bg-base-300 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-7">
    {codes.slice(0, SHOWN).map((code, i) => <span key={members[i]!.personId} aria-hidden="true"
      className={`grid size-6 place-items-center rounded-full bg-base-300 text-[11px] font-semibold text-base-content/70 ring-2 ring-base-200 ${i ? "-ml-1.5" : ""}`}>
      {Array.from(code)[0]?.toUpperCase()}
    </span>)}
    {members.length > SHOWN && <span aria-hidden="true" className="ml-1 text-[11px] text-base-content/60">+{members.length - SHOWN}</span>}
  </button>;
}
