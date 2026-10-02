'use client';
import { useEffect, useRef, useState } from 'react';
import { fetchProductBoard, type ProductBoard } from '@/lib/api/product-board';
import { collabLoader } from '../collab-loader';

/** Same revision as the sub-DAG, with V1h's retries independent of new ledger events. */
export function useProductBoard(project: string, rev: number) {
  const [load, setLoad] = useState<{ project: string; board: ProductBoard | null }>({ project, board: null });
  const loader = useRef<ReturnType<typeof collabLoader<ProductBoard>> | null>(null);
  useEffect(() => {
    const current = collabLoader({
      fetch: (signal) => fetchProductBoard(project, signal),
      success: (board) => setLoad({ project, board }),
      failure: () => setLoad({ project, board: null }),
      visibility: { hidden: () => document.hidden, onShow: cb => {
        const show = () => { if (!document.hidden) cb(); };
        document.addEventListener('visibilitychange', show);
        return () => document.removeEventListener('visibilitychange', show);
      } },
    });
    loader.current = current;
    return () => { current.dispose(); loader.current = null; };
  }, [project]);
  useEffect(() => { if (rev > 0) void loader.current?.refetch(); }, [project, rev]);
  return load.project === project ? load.board : null;
}
