"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { api } from "@/lib/api/client";
import { sharedProjectsApi } from "@/lib/shared-projects-api";
import { list, object, text } from "@/lib/shared-projects-parse";
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
  const [sources, setSources] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const nav = useChatNav();
  useEffect(() => {
    const ctrl = new AbortController();
    api("/shared-ledger/context", { signal: ctrl.signal }, { fp: machine }).then(value => {
      const ids = list(object(value).identities, v => text(object(v).project, 32));
      if (!ctrl.signal.aborted) { setSources(ids); if (ids.length === 1) setSource(ids[0]!); }
    }).catch(() => {
      // The snapshot route reports fixed errors; a failed context read never supplies or guesses a credential binding.
      if (!ctrl.signal.aborted) { setSources([]); setSource(""); }
    });
    return () => ctrl.abort();
  }, [machine]);
  const port = useMemo(() => sharedProjectsApi({ fp: machine }, source || undefined), [machine, source]);
  const openFeatures = (project: SharedProject) => {
    if (!project.local || project.availability !== "ready" || !project.personId || !project.instanceId || machines.currentFp() !== machine) return;
    openCollab(sharedCollabProject({ machine, center: project.centerId, team: project.teamId, project: project.projectId,
      person: project.personId, homeInstanceId: project.instanceId })); nav.toContent();
  };
  return <div>
    {sources.length > 1 && <label className="block px-2 text-xs">项目权限来源
      <select aria-label="项目权限来源" className="select select-sm mt-1 w-full" value={source} onChange={e => setSource(e.target.value)}>
        <option value="">请选择已有绑定</option>
        {sources.map((id, i) => <option key={`${id}-${i}`} value={id}>{id}</option>)}
      </select>
    </label>}
    <SharedProjectsPanel key={source} port={port} openFeatures={openFeatures} />
  </div>;
}
