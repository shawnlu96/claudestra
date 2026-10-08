"use client";
import { useState } from "react";
import { ProjectFailure, teamDisplayName, type ProjectTeam, type SharedProjectsPort, type TeamRecord } from "@/lib/shared-projects-model";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

const SAVED = "团队名称已保存。";
type Outcome = { current: TeamRecord; name: string } | "unconfirmed" | null;

/** Team display name, and an owner-only rename with the same draft / base revision / explicit retry semantics as project names. */
export function TeamSettings({ team, teams, port, refresh }: {
  team: ProjectTeam; teams: readonly ProjectTeam[]; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const record = team.team;
  const [editor, setEditor] = useState({ source: record, draft: record?.name ?? "", baseRev: record?.rev ?? 0, baseName: record?.name ?? null,
    dirty: false, quiet: false, outcome: null as Outcome });
  // A dirty draft keeps its original CAS revision; a refresh only exposes a newer competing value in the conflict box.
  if (editor.source !== record) setEditor(previous => {
    const outcome = record && previous.outcome && previous.outcome !== "unconfirmed" && record.rev > previous.outcome.current.rev
      ? { ...previous.outcome, current: record } : previous.outcome;
    return { ...previous, source: record, outcome: outcome ?? (previous.dirty && record && record.rev > previous.baseRev
      && record.name !== previous.baseName ? { current: record, name: previous.draft.trim() } : null),
      ...(!previous.dirty && record ? { draft: record.name ?? "", baseRev: record.rev, baseName: record.name } : {}) };
  });
  const { draft, baseRev, outcome } = editor;
  const action = useProjectAction(refresh);
  const owner = team.teamRole === "owner" && !!record && !!port.updateTeam;
  const rename = async (rev: number, name: string, signal: AbortSignal) => {
    setEditor(previous => ({ ...previous, outcome: null, quiet: false }));
    try {
      const saved = await port.updateTeam!(team, { rev, name }, signal);
      if (!signal.aborted) setEditor(previous => previous.draft.trim() === name
        ? { ...previous, baseRev: saved.rev, baseName: saved.name, dirty: false } : previous);
    } catch (e) {
      if (signal.aborted || !(e instanceof ProjectFailure) || e.status !== 409) throw e;
      // Handled here, not as projectErrorText(409): the run then re-reads the snapshot once and nothing is resubmitted.
      const current = e.conflict?.code === "team_conflict" ? e.conflict.team : null;
      setEditor(previous => ({ ...previous, quiet: true, outcome: current ? { current, name } : "unconfirmed" }));
    }
  };
  return <section className="space-y-3">
    <h3 className="font-semibold">团队</h3>
    <p className="break-words text-sm">{teamDisplayName(team, teams)}</p>
    {owner && <>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); void action.run(s => rename(baseRev, draft.trim(), s), SAVED); }}>
        <label className="block text-sm">团队显示名
          <input className="input mt-1 w-full" value={draft} required maxLength={64} onChange={e => {
            const value = e.target.value; setEditor(previous => ({ ...previous, draft: value, dirty: true, outcome: null }));
          }} />
        </label>
        <button className="btn btn-sm" disabled={action.busy || !draft.trim()}>保存团队名称</button>
      </form>
      {outcome === "unconfirmed" ? <p role="alert" className="rounded-lg border border-warning p-3 text-sm">结果未确认，请刷新</p>
        : outcome && <div role="alert" className="space-y-2 rounded-lg border border-warning p-3 text-sm">
          <p className="break-words">当前名称：{teamDisplayName(team, teams, outcome.current)}</p>
          <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => {
            setEditor(previous => ({ ...previous, baseRev: outcome.current.rev, baseName: outcome.current.name }));
            void action.run(s => rename(outcome.current.rev, outcome.name, s), SAVED);
          }}>按当前版本重试</button>
        </div>}
    </>}
    <ActionStatus error={action.error} notice={editor.quiet ? "" : action.notice} />
  </section>;
}
