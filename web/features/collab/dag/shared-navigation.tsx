'use client';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@/lib/api/client';
import { machines } from '@/lib/machines';
import type { Identity } from '@/lib/api/shared-ledger';
import { TeamSource } from '../shared/team-ops';
import { openCollab } from '../collab-nav';
import { useChatNav } from '../../chat/components/nav-context';

const subscribeMachines = (fn: () => void) => machines.subscribe(fn);
const currentMachine = () => machines.currentFp();
const noMachine = () => null;
const PREFIX = 'shared-ledger:';
export function sharedCollabProject(identity: Identity): string { return PREFIX + JSON.stringify(identity); }
function sharedIdentity(project: string): Identity | null {
  if (!project.startsWith(PREFIX)) return null;
  try {
    const identity = JSON.parse(project.slice(PREFIX.length)) as Identity;
    return identity && [identity.center, identity.team, identity.person, identity.project, identity.machine]
      .every(v => typeof v === 'string' && !!v) ? identity : null;
  }
  catch { return null; } // A malformed UI cache key cannot authorize a server request; render the local fallback.
}
interface Context { identities: (Omit<Identity, 'machine'> & { localProjectId?: string })[] }
export function SharedEntry({ projectId }: { projectId: string }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const nav = useChatNav();
  const machine = useSyncExternalStore(subscribeMachines, currentMachine, noMachine);
  useEffect(() => {
    const ctrl = new AbortController();
    if (!machine) return;
    api<Context>('/shared-ledger/context', { signal: ctrl.signal }, { fp: machine }).then(context => {
      if (ctrl.signal.aborted || machines.currentFp() !== machine) return;
      const found = context.identities.find(i => (i.localProjectId ?? i.project) === projectId);
      if (found) setIdentity({ ...found, machine });
    }).catch(e => {
      // Unsupported/unconfigured bridges have no team entry; authenticated local navigation still works.
      if (!ctrl.signal.aborted) console.debug('[shared-ledger] context unavailable', e);
    });
    return () => ctrl.abort();
  }, [projectId, machine]);
  if (!identity || identity.machine !== machine) return null;
  return <li><button type="button" className="w-full rounded-lg px-2 py-1.5 text-left text-[13px]"
    onClick={() => { openCollab(sharedCollabProject(identity)); nav.toContent(); }}>团队 · 全部 feature</button></li>;
}
export function SharedCollabContent({ project, fallback }: { project: string; fallback: ReactNode }) {
  const identity = sharedIdentity(project);
  // 团队视图就是本地 CollabView（fallback），只是数据换成中心共享台账（i28-TV1）
  return identity ? <TeamSource identity={identity}>{fallback}</TeamSource> : fallback;
}
