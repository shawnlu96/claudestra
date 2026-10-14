"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import { type SharedProject } from "@/lib/shared-projects-model";
import { openCollab } from "../collab-nav";
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
 * 选不出（绑定停用 / 还没核对上 / 这台机器的绑定里没有它）时行变灰，title 写原因，不再点了没反应。
 */
function ProjectRow({ machine, project }: { machine: string; project: SharedProject }) {
  const nav = useChatNav();
  const { choice } = useCollabChoice(machine, project.local!.id);
  const reason = choice.kind === "center" ? null : BLOCKED_REASON[choice.kind === "blocked" ? choice.reason : "checking"];
  const open = () => {
    if (choice.kind !== "center" || machines.currentFp() !== machine) return;
    openCollab(choice.key); nav.toContent();
  };
  return <button type="button" className={`block w-full truncate rounded-lg px-2 py-2 text-left text-sm ${reason ? "cursor-not-allowed opacity-50" : "hover:bg-base-300"}`}
    onClick={open} aria-label={project.name} aria-disabled={reason ? true : undefined} data-collab-blocked={choice.kind === "center" ? undefined : choice.kind === "blocked" ? choice.reason : "checking"}
    title={reason ? `${project.name} · ${reason}` : project.name}>
    <span>{project.name}</span>{project.status === "archived" ? " · 已归档" : ""}
  </button>;
}
