"use client";
import { useMemo, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import { type SharedProject } from "@/lib/shared-projects-model";
import { sharedCollabProject } from "../team-source-key";
import { openCollab } from "../collab-nav";
import { useChatNav } from "../../chat/components/nav-context";
import { SharedProjectsPanel } from "./projects-panel";

const subscribe = (fn: () => void) => machines.subscribe(fn);
const current = () => machines.currentFp();
const server = () => null;

/** One independent entry survives an empty agent/master list and remounts all state when the selected machine changes. */
export function SharedProjectsEntry() {
  const machine = useSyncExternalStore(subscribe, current, server);
  return machine ? <MachineProjects key={machine} machine={machine} /> : null;
}

function MachineProjects({ machine }: { machine: string }) {
  const nav = useChatNav();
  const port = useMemo(() => sharedProjectsByBindings({ fp: machine }), [machine]);
  const openFeatures = (project: SharedProject) => {
    if (!project.local || project.availability !== "ready" || !project.personId || !project.instanceId || machines.currentFp() !== machine) return;
    openCollab(sharedCollabProject({ machine, center: project.centerId, team: project.teamId, project: project.projectId,
      person: project.personId, homeInstanceId: project.instanceId })); nav.toContent();
  };
  return <SharedProjectsPanel port={port} openFeatures={openFeatures} />;
}
