"use client";
import { useState } from "react";
import { boundProjects, projectKey, type CreateProject, type SharedProject, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { CreateProjectForm } from "./create-project";
import { ProjectDialog } from "./project-dialog";
import { ProjectMembers } from "./project-members";
import { LocalProjectSettings, ProjectSettings } from "./project-settings";
import { useProjects } from "./use-projects";

/** Mount once per machine. The port and the navigation callback are both pinned to that machine. */
export function SharedProjectsPanel({ port, openFeatures }: { port: SharedProjectsPort; openFeatures: (project: SharedProject) => void }) {
  const { snapshot, error, refresh } = useProjects(port);
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<CreateProject | null>(null);
  const project = snapshot?.projects.find(p => projectKey(p) === selected);
  return <section className="my-2 space-y-1" aria-label="团队项目">
    <div className="flex items-center justify-between gap-2 px-2">
      <h2 className="text-xs font-semibold opacity-60">团队 · 全部 feature</h2>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpened(true)}>项目设置</button>
    </div>
    {snapshot && boundProjects(snapshot).map(p => <button key={projectKey(p)} type="button"
      className="block w-full truncate rounded-lg px-2 py-2 text-left text-sm hover:bg-base-300" onClick={() => openFeatures(p)} title={p.name}>
      {p.name}{p.status === "archived" ? " · 已归档" : ""}
    </button>)}
    {opened && <ProjectDialog title="团队项目" close={() => setOpened(false)}>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      {!snapshot && !error && <p role="status">正在读取团队项目…</p>}
      {snapshot && <>
        <CreateProjectForm snapshot={snapshot} port={port} refresh={refresh} pending={pending} setPending={setPending} />
        <section className="space-y-3 border-t border-base-300 pt-4">
          <h3 className="font-semibold">项目设置</h3>
          {!snapshot.projects.length && <p className="text-sm opacity-60">暂无团队项目。加入后会自动出现在这里。</p>}
          <div className="flex flex-wrap gap-2">
            {snapshot.projects.map(p => <button key={projectKey(p)} type="button" className={`btn btn-sm max-w-full ${project === p ? "btn-primary" : "btn-outline"}`}
              onClick={() => setSelected(projectKey(p))} aria-pressed={project === p}>
              <span className="truncate">{p.name}</span>
            </button>)}
          </div>
        </section>
        {project && <div key={projectKey(project)} className="space-y-5">
          <h3 className="break-words text-lg font-semibold">{project.name}</h3>
          <ProjectSettings project={project} port={port} refresh={refresh} />
          <LocalProjectSettings project={project} port={port} refresh={refresh} />
          <ProjectMembers project={project} snapshot={snapshot} port={port} />
        </div>}
      </>}
    </ProjectDialog>}
  </section>;
}
