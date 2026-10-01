'use client';
import { useEffect, useState } from 'react';
import { fetchWorkBoard } from '@/lib/api/work-board';
import { collabLoader } from '../collab-loader';
import type { WorkBoard } from './work-types';
/** Reuse V1h's abort-safe exponential retry, retaining the last snapshot. Hidden pages never poll. */
export function useWorkBoard(project: string) {
  const [load, setLoad] = useState<{ project: string; board: WorkBoard | null; retrying: boolean }>({ project, board: null, retrying: false });
  useEffect(() => {
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
