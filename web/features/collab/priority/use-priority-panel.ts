'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPriority, type PrioritySnapshot } from '@/lib/api/priority';
import { machines } from '@/lib/machines';
import { collabLoader } from '../collab-loader';

/** Same retry/visibility loader as useWorkBoard; a retained snapshot is read-only until a fresh read succeeds. */
export function usePriorityPanel(project: string | null) {
  const [load, setLoad] = useState<{ project: string | null; data: PrioritySnapshot | null; error: string; readAt: number }>({ project, data: null, error: '', readAt: 0 });
  const [machine, setMachine] = useState(0);
  useEffect(() => machines.onSwitch(() => {
    setLoad({ project, data: null, error: '机器已切换，正在刷新', readAt: 0 }); setMachine(n => n + 1);
  }), [project]);
  const [clock, setClock] = useState(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (project === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loader = collabLoader({
      fetch: (signal) => fetchPriority(project, signal),
      success: data => {
        setClock(Date.now());
        setLoad({ project, data, error: '', readAt: Date.now() });
        timer = setTimeout(() => { if (!document.hidden) void loader.refetch(); }, 30000);
      },
      failure: error => setLoad(old => ({ project, data: old.project === project ? old.data : null, readAt: 0,
        error: error instanceof Error ? error.message : '读取失败，请重试' })),
      visibility: { hidden: () => document.hidden, onShow: cb => {
        const show = () => { if (!document.hidden) cb(); };
        document.addEventListener('visibilitychange', show);
        return () => document.removeEventListener('visibilitychange', show);
      } },
    });
    const read = async () => { clearTimeout(timer); if (!document.hidden) await loader.refetch(); };
    refresh.current = read;
    const visible = () => {
      clearTimeout(timer);
      // A returned tab must revalidate before enabling old buttons.
      setLoad(old => ({ ...old, readAt: 0 }));
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    const tick = setInterval(() => { if (!document.hidden) setClock(Date.now()); }, 10000);
    void read();
    return () => {
      clearTimeout(timer); clearInterval(tick); loader.dispose();
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible);
    };
  }, [project, machine]);
  const reload = useCallback(async () => { await refresh.current(); }, []);
  const current = load.project === project ? load : { data: null, error: '', readAt: 0 };
  const stale = !!current.data && (!current.readAt || clock - current.readAt > 60000);
  const now = (current.data?.now ?? 0) + (current.readAt ? Math.max(0, clock - current.readAt) : 0);
  return { ...current, stale, reload, now };
}
