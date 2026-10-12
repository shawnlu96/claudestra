'use client';
import { useEffect, useRef, useState } from 'react';
import { fetchProductBoard, type ProductBoard } from '@/lib/api/product-board';
import { useCollabSource } from '../team-source-context';
import { collabLoader } from '../collab-loader';

/** loading = no answer yet (draw a placeholder); absent = the read failed before any board arrived (draw the causal fallback). */
export type ProductLoad = { status: 'loading' } | { status: 'absent' } | { status: 'ok'; board: ProductBoard };
const LOADING: ProductLoad = { status: 'loading' };
const ABSENT: ProductLoad = { status: 'absent' };

/**
 * Same revision as the sub-DAG, with V1h's retries independent of new ledger events. Fetches on mount too (a cached
 * overview renders with rev 0); a failed refresh keeps the project's last board. Tests: tests/web-dom-product-panes-loading.test.ts.
 */
export function useProductBoard(project: string, rev: number): ProductLoad {
  const read = useCollabSource(project).product ?? fetchProductBoard;
  const [load, setLoad] = useState<{ project: string; value: ProductLoad }>({ project, value: LOADING });
  const loader = useRef<ReturnType<typeof collabLoader<ProductBoard>> | null>(null);
  useEffect(() => {
    const current = collabLoader({
      fetch: (signal) => read(project, signal),
      success: (board) => setLoad({ project, value: { status: 'ok', board } }),
      failure: () => setLoad(prev => prev.project === project && prev.value.status === 'ok' ? prev : { project, value: ABSENT }),
      visibility: { hidden: () => document.hidden, onShow: cb => {
        const show = () => { if (!document.hidden) cb(); };
        document.addEventListener('visibilitychange', show);
        return () => document.removeEventListener('visibilitychange', show);
      } },
    });
    loader.current = current;
    return () => { current.dispose(); loader.current = null; };
  }, [project, read]);
  useEffect(() => { void loader.current?.refetch(); }, [project, rev, read]);
  return load.project === project ? load.value : LOADING;
}
