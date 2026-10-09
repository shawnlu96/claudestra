'use client';
import { useMemo, type ReactNode } from 'react';
import { useLang } from '../../../../lib/i18n';
import { sharedExecTransport } from '../../../../lib/api/shared-ledger-v2';
import { sharedIdentity } from '../../team-source-key';
import type { ExecPort } from './exec-model';
import { ExecPanel, type ExecPanelProps } from './exec-panel';

/** Optional TV1 extension: absent wiring or off means no execution DOM and zero new requests. */
export interface ExecSource {
  sharedExec?: ExecPort;
  last?: () => { list: { features: { id: string; authorityMode: string }[] };
    team: { index: ReadonlyMap<string, { featureId: string; taskId: string | null }> } } | null;
}
export function ExecEntry({ source, project, taskId, now }: { source: ExecSource; project: string; taskId: string | null; now: number }) {
  const identity = sharedIdentity(project), language = useLang();
  const last = source.last?.(), at = taskId ? last?.team.index.get(taskId) : null, featureId = at?.featureId;
  if (!source.sharedExec || !last || !identity) return null;
  return <>{last.list.features.filter(f => f.authorityMode === 'execution' && (!taskId || f.id === featureId)).map(f => {
    const context = source.sharedExec!.context(f.id);
    if (!context || !context.localProjectId || context.mode === 'off' || context.scope.teamId !== identity.team
      || context.scope.projectId !== identity.project) return null;
    return <ExecMount key={JSON.stringify([project, f.id, taskId, context.mode, context.scope, context.viewer, context.localProjectId])}
      featureId={f.id} taskId={taskId ? at?.taskId ?? null : null} context={context} machine={identity.machine} port={source.sharedExec!} now={now} language={language} />;
  })}</>;
}

function ExecMount(p: Omit<ExecPanelProps, 'transport'> & { machine: string }) {
  const transport = useMemo(() => sharedExecTransport(p.context.localProjectId, { fp: p.machine }), [p.context.localProjectId, p.machine]);
  return <ExecPanel {...p} transport={transport} />;
}

/** Decorate TV1's existing operation slots, so non-execution layouts keep exactly their existing structure. */
export function useExecCollab<T extends { source: { ops?: (taskId: string | null, now?: number) => ReactNode } }>(state: T, project: string): T {
  const source = state.source;
  const injected = useMemo(() => ({ ...source, ops: (taskId: string | null, now = Date.now()) =>
    <>{source.ops?.(taskId, now)}<ExecEntry source={source as ExecSource} project={project} taskId={taskId} now={now} /></> }), [source, project]);
  return { ...state, source: injected };
}
