"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import { type SharedProject } from "@/lib/shared-projects-model";
import { openCollab } from "../collab-nav";
import { sharedCollabProject } from "../team-source-key";
import { BLOCKED_REASON, useCollabChoice } from "../team-view-entry";
import { useChatNav } from "../../chat/components/nav-context";
import { groupedProjectIds, type DirectoryEntryLike } from "./grouped-projects";
import { SharedProjectsPanel, type ProjectRowComponent } from "./projects-panel";

const subscribe = (fn: () => void) => machines.subscribe(fn);
const current = () => machines.currentFp();
const server = () => null;

/**
 * One independent entry survives an empty agent/master list and remounts all state when the selected machine changes.
 * entries = the sidebar's live directory entries (empty while searching): projects grouped there are not repeated here.
 */
export function SharedProjectsEntry({ entries }: { entries?: readonly DirectoryEntryLike[] }) {
  const machine = useSyncExternalStore(subscribe, current, server);
  return machine ? <MachineProjects key={machine} machine={machine} entries={entries} /> : null;
}

function MachineProjects({ machine, entries }: { machine: string; entries?: readonly DirectoryEntryLike[] }) {
  const port = useMemo(() => sharedProjectsByBindings({ fp: machine }), [machine]);
  const grouped = useMemo(() => groupedProjectIds(entries), [entries]);
  const Row = useCallback<ProjectRowComponent>(({ project }) => <ProjectRow machine={machine} project={project} />, [machine]);
  return <SharedProjectsPanel port={port} grouped={grouped} Row={Row} />;
}

/**
 * 团队区保留的一行：和项目组「协作视图」入口同一个选源（useCollabChoice → resolveCollabSource），开的是同一个中心键。
 * 选不出（绑定停用 / 这一轮没读到 / 这台机器的绑定里没有它）时行变灰，title 写原因，不再点了没反应。
 * 绑定 store 第一轮还没回包（!settled）时先按团队区自己这份快照拼键（sharedCollabProject，同一个拼法）：快照已经证明有这条绑定，
 * 不让行白等；回包后键对不上由 team-view-entry.tsx 的 OpenViewGuard 关掉（tests/web-collab-unified-browser.test.ts）。
 */
function ProjectRow({ machine, project }: { machine: string; project: SharedProject }) {
  const nav = useChatNav();
  const { choice, settled } = useCollabChoice(machine, project.local!.id);
  const early = !settled && project.personId && project.instanceId ? sharedCollabProject({ machine, center: project.centerId, team: project.teamId,
    project: project.projectId, person: project.personId, homeInstanceId: project.instanceId }) : null;
  const key = choice.kind === "center" ? choice.key : early;
  const blocked = key ? null : choice.kind === "blocked" ? choice.reason : "checking";
  const open = () => {
    if (!key || machines.currentFp() !== machine) return;
    openCollab(key); nav.toContent();
  };
  return <button type="button" className={`block w-full truncate rounded-lg px-2 py-2 text-left text-sm ${blocked ? "cursor-not-allowed opacity-50" : "hover:bg-base-300"}`}
    onClick={open} aria-label={project.name} aria-disabled={blocked ? true : undefined} data-collab-blocked={blocked ?? undefined}
    title={blocked ? `${project.name} · ${BLOCKED_REASON[blocked]}` : project.name}>
    <span>{project.name}</span>{project.status === "archived" ? " · 已归档" : ""}
  </button>;
}
