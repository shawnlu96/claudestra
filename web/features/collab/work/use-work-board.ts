'use client';
import { useEffect, useMemo, useState } from 'react';
import { fetchWorkBoard } from '@/lib/api/work-board';
import { localProjectOf } from '@/lib/collab-source-binding';
import { sharedProjectsByBindings } from '@/lib/shared-projects-bindings';
import { collabLoader } from '../collab-loader';
import { NO_NAMES, peerInstanceNames, type InstanceNames } from '../team-instance-names';
import { sharedIdentity } from '../team-source-key';
import { mergeTeamWork, needsLocalBoard, needsNames } from './team-work-merge';
import type { TeamWorkBoard, WorkBoard } from './work-types';
/** Reuse V1h's abort-safe exponential retry, retaining the last snapshot. Hidden pages never poll. project = null: no request at all. */
export function useWorkBoard(project: string | null) {
  const [load, setLoad] = useState<{ project: string | null; board: WorkBoard | null; retrying: boolean }>({ project, board: null, retrying: false });
  useEffect(() => {
    if (project === null) return;
    let polling: ReturnType<typeof setTimeout> | undefined;
    const loader = collabLoader({
      fetch: (signal) => fetchWorkBoard(project, signal),
      success: (board) => {
        setLoad({ project, board, retrying: false });
        polling = setTimeout(() => { if (!document.hidden) void loader.refetch(); }, 30_000);
      },
      failure: () => setLoad(cur => ({ project, board: cur.project === project ? cur.board : null, retrying: true })),
      visibility: { hidden: () => document.hidden, onShow: cb => {
        const handler = () => { if (!document.hidden) cb(); };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      } },
    });
    const refresh = () => {
      clearTimeout(polling);
      if (!document.hidden) void loader.refetch();
    };
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => { clearTimeout(polling); loader.dispose(); document.removeEventListener('visibilitychange', refresh); };
  }, [project]);
  return load.project === project ? load : { project, board: null, retrying: false };
}

const names = new Map<string, InstanceNames>();
const reading = new Map<string, Promise<InstanceNames>>();
/** 本机 shared-projects 快照的 peers → 实例名表：一台机器同时只读一轮、成功的留到页面关掉；失败不缓存，下次挂载再读 */
function readNames(machine: string): Promise<InstanceNames> {
  const hit = names.get(machine);
  if (hit) return Promise.resolve(hit);
  let p = reading.get(machine);
  if (!p) {
    p = sharedProjectsByBindings({ fp: machine }).list(new AbortController().signal).then(
      (snap) => { const got = peerInstanceNames(snap.peers); names.set(machine, got); return got; },
      // 读不到快照（没绑定 / 老 bridge / 网络）只是少了 peer 名：机器退到「其他成员的机器」，不挡看板
      () => NO_NAMES,
    ).finally(() => reading.delete(machine));
    reading.set(machine, p);
  }
  return p;
}

/** machine = null（不需要名字）时不请求 */
export function useInstanceNames(machine: string | null): InstanceNames {
  const [got, setGot] = useState<{ machine: string; names: InstanceNames } | null>(null);
  useEffect(() => {
    if (!machine) return;
    let live = true;
    void readNames(machine).then((n) => { if (live) setGot({ machine, names: n }); });
    return () => { live = false; };
  }, [machine]);
  return machine && got?.machine === machine ? got.names : NO_NAMES;
}

/**
 * 团队视图的「谁在干活」：team = 团队数据转出的看板（team-work-model.ts）。至少一行主场是本机（团队键 homeInstanceId）才读本机 /work
 * （项目 id 用 localProjectOf），有别的成员机器上的行才读快照拿 peer 名；然后 team-work-merge.ts 合并命名
 */
export function useTeamWorkBoard(project: string, team: TeamWorkBoard | null): { board: TeamWorkBoard | null; retrying: boolean } {
  const id = sharedIdentity(project), localInstance = id?.homeInstanceId ?? null;
  const local = useWorkBoard(needsLocalBoard(team, localInstance) ? localProjectOf(project) : null);
  const peerNames = useInstanceNames(id && needsNames(team, localInstance) ? id.machine : null);
  const board = useMemo(() => (team ? mergeTeamWork(team, local.board, localInstance, peerNames) : null), [team, local.board, localInstance, peerNames]);
  return { board, retrying: local.retrying };
}
