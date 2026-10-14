"use client";
import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { useLang } from "@/lib/i18n";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { projectKey, teamKey, type CreateProject, type SharedProject, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { Icon } from "../collab-icons";
import { teamAreaProjects } from "./grouped-projects";
import { CreateProjectForm } from "./create-project";
import { ProjectDialog } from "./project-dialog";
import { ProjectMembers } from "./project-members";
import { LocalProjectSettings, ProjectSettings } from "./project-settings";
import { useProjects } from "./use-projects";
import { ProjectCards } from "./project-cards";
import { TeamSettings } from "./team-settings";

const NONE: ReadonlySet<string> = new Set();
/** No team projects on this machine at all (403 = no team binding, 404 / 501 = the bridge has no team projects): the section stays out. */
const ABSENT = new Set([403, 404, 501]);

/** A row of the team area. projects-entry.tsx supplies the production one (same source choice as the project-group entry). */
export type ProjectRowComponent = ComponentType<{ project: SharedProject }>;

/**
 * Mount once per machine. The port and the row are both pinned to that machine.
 * grouped = local projects that currently form a sidebar group: their group already carries the collab entry, so no row here.
 * Without Row (synthetic harness) each row is a plain button calling openFeatures.
 */
export function SharedProjectsPanel({ port, openFeatures, Row, grouped = NONE }: {
  port: SharedProjectsPort; openFeatures?: (project: SharedProject) => void; Row?: ProjectRowComponent; grouped?: ReadonlySet<string>;
}) {
  const tr = sharedProjectsTr(useLang());
  const { snapshot, error, status, refresh } = useProjects(port);
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [pending, setPending] = useState<CreateProject[]>([]);
  const project = snapshot?.projects.find(p => projectKey(p) === selected);
  if (!snapshot && error && ABSENT.has(status) && !opened) return null;
  return <section className="my-2 space-y-1" aria-label={tr("团队项目")}>
    <div className="flex items-center justify-between gap-2 px-2">
      <h2 className="text-xs font-semibold opacity-60">{tr("团队")}</h2>
      <button type="button" className="btn btn-ghost btn-xs" disabled={!snapshot?.teams.length} onClick={() => setOpened(true)}>{tr("项目设置")}</button>
    </div>
    {!snapshot && !error && <PendingRow />}
    {!snapshot && error && !ABSENT.has(status) && <FailedRow refresh={refresh} />}
    {snapshot?.sourceWarnings?.map(warning => <p key={warning} role="status" className="px-2 text-xs opacity-60">{tr(warning)}</p>)}
    {snapshot && teamAreaProjects(snapshot, grouped).map(p => Row ? <Row key={projectKey(p)} project={p} /> : <button key={projectKey(p)} type="button"
      className="block w-full truncate rounded-lg px-2 py-2 text-left text-sm hover:bg-base-300" onClick={() => openFeatures?.(p)} aria-label={p.name} title={p.name}>
      <span>{p.name}</span>{p.status === "archived" ? ` · ${tr("已归档")}` : ""}
    </button>)}
    {opened && <ProjectDialog title={tr("团队项目")} close={() => setOpened(false)}>
      {error && <p role="alert" className="text-sm text-error">{tr(error)}</p>}
      {!snapshot && !error && <p role="status">{tr("正在读取团队项目…")}</p>}
      {snapshot && <>
        {snapshot.teams.map(t => <TeamSettings key={teamKey(t)} team={t} teams={snapshot.teams} port={port} refresh={refresh} />)}
        <CreateProjectForm snapshot={snapshot} port={port} refresh={refresh} pending={pending} setPending={setPending} locked={locked} setLocked={setLocked} />
        <section className="space-y-3 border-t border-base-300 pt-4">
          <h3 className="font-semibold">{tr("项目设置")}</h3>
          {!snapshot.projects.length && <p className="text-sm opacity-60">{tr("暂无团队项目。加入后会自动出现在这里。")}</p>}
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
          <LocalProjectSettings project={project} port={port} refresh={refresh} leaveAvailable={snapshot.capabilities?.leave !== false} />
          <ProjectMembers project={project} snapshot={snapshot} port={port} />
        </div>}
      </>}
      <ProjectCards port={port} refresh={refresh} />
    </ProjectDialog>}
  </section>;
}

/** First read still out: one row-high bar so the section is already in place when the list arrives (no text, not clickable). */
function PendingRow() {
  return <div aria-hidden="true" data-team-projects="pending" className="flex items-center px-2 py-2 text-sm">
    <span className="h-3 w-24 animate-pulse rounded bg-base-content/15" /><span className="w-0">{"\u200b"}</span>
  </div>;
}

/** No snapshot and the read failed for a reason worth retrying. One click = one refresh; the icon spins while it runs. */
function FailedRow({ refresh }: { refresh: (signal: AbortSignal) => Promise<void> }) {
  const tr = sharedProjectsTr(useLang());
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const retry = () => {
    if (active.current) return;
    const ctrl = new AbortController();
    active.current = ctrl; setBusy(true);
    void refresh(ctrl.signal).finally(() => { if (!ctrl.signal.aborted) { active.current = null; setBusy(false); } });
  };
  return <div data-team-projects="failed" className="flex items-center gap-2 px-2 py-2 text-sm text-base-content/50">
    <span className="truncate">{tr("没读到团队项目")}</span>
    <button type="button" className="-my-1 ml-auto shrink-0 rounded p-1 text-base-content/60 hover:bg-base-300/60 hover:text-base-content"
      aria-label={tr("重试")} title={tr("重试")} aria-busy={busy || undefined} onClick={retry}>
      <Icon name="rotateCcw" size={14} className={busy ? "animate-spin" : undefined} />
    </button>
  </div>;
}
