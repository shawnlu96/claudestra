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
function activeFeatures(source: ExecSource, identity: ReturnType<typeof sharedIdentity>) {
  if (!identity || !source.sharedExec) return [];
  return (source.last?.()?.list.features ?? []).flatMap(f => {
    if (f.authorityMode !== 'execution') return [];
    const context = source.sharedExec!.context(f.id);
    return context && context.localProjectId && context.mode !== 'off' && context.scope.teamId === identity.team
      && context.scope.projectId === identity.project ? [{ featureId: f.id, context }] : [];
  });
}
export function ExecEntry({ source, project, taskId, now }: { source: ExecSource; project: string; taskId: string | null; now: number }) {
  const identity = sharedIdentity(project), language = useLang();
  const last = source.last?.(), at = taskId ? last?.team.index.get(taskId) : null, featureId = at?.featureId;
  return <>{activeFeatures(source, identity).filter(f => !taskId || f.featureId === featureId).map(f =>
    <ExecMount key={JSON.stringify([project, f.featureId, taskId, f.context.mode, f.context.scope, f.context.viewer, f.context.localProjectId])}
      featureId={f.featureId} taskId={taskId ? at?.taskId ?? null : null} context={f.context} machine={identity!.machine}
      port={source.sharedExec!} now={now} language={language} />)}</>;
}

function ExecMount(p: Omit<ExecPanelProps, 'transport'> & { machine: string }) {
  const transport = useMemo(() => sharedExecTransport(p.context.localProjectId, { fp: p.machine }), [p.context.localProjectId, p.machine]);
  return <ExecPanel {...p} transport={transport} />;
}

/** Decorate TV1's existing operation slots, so non-execution layouts keep exactly their existing structure. */
export function useExecCollab<T extends { source: ExecSource & { ops?: (taskId: string | null, now?: number) => ReactNode } }>(state: T, project: string): T {
  const source = state.source;
  const injected = useMemo(() => ({ ...source, ops: (taskId: string | null, now = Date.now()) =>
    <>{source.ops?.(taskId, now)}<ExecEntry source={source as ExecSource} project={project} taskId={taskId} now={now} /></> }), [source, project]);
  if (!source.ops && activeFeatures(source, sharedIdentity(project)).length === 0) return state;
  return { ...state, source: injected };
}
