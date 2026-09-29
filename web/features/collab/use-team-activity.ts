"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { useMachineFp } from "../talk/use-talk";
import type { ActivitySnapshot } from "./team-graph-model";

/** Reads existing local buffers; never sends a message or probes a peer. */
export function useTeamActivity(project: string) {
  const fp = useMachineFp();
  const [value, setValue] = useState<{ key: string; snapshot: ActivitySnapshot | null } | null>(null);
  const key = JSON.stringify([fp, project]);
  useEffect(() => {
    const ctrl = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const snapshot = await api<ActivitySnapshot>(`/team/activity?project=${encodeURIComponent(project)}`, { signal: ctrl.signal, timeoutMs: 5000 });
        if (!ctrl.signal.aborted) setValue({ key, snapshot });
      } catch {
        // A missing source must not leave old interactions claiming to be current.
        if (!ctrl.signal.aborted) setValue({ key, snapshot: null });
      } finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    const visible = () => void load();
    document.addEventListener("visibilitychange", visible);
    return () => { ctrl.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [key, project]);
  return value?.key === key ? value.snapshot : null;
}
