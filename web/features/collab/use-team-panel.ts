"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { useMachineFp } from "../talk/use-talk";
import type { TeamAgent, TeamPeer, TeamQuota } from "./team-panel-model";

interface TeamData { agents: TeamAgent[] | null; peers: TeamPeer[] | null; quotas: TeamQuota[] | null }
const EMPTY: TeamData = { agents: null, peers: null, quotas: null };

/** Sources fail independently. Machine changes hide the old snapshot synchronously. */
export function useTeamPanel() {
  const fp = useMachineFp();
  const [state, setState] = useState<{ fp: string | null; data: TeamData }>({ fp, data: EMPTY });
  useEffect(() => {
    let live = true;
    let loading = false;
    const ctrl = new AbortController();
    const load = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      const opt = { signal: ctrl.signal, timeoutMs: 8000 };
      const results = await Promise.allSettled([
        api<{ agents?: TeamAgent[] }>("/agents?include=stopped", opt),
        api<{ contacts?: TeamPeer[] }>("/peers/contacts", opt),
        api<{ providers?: TeamQuota[] }>("/team/quota", opt),
      ]);
      const [a, p, q] = results;
      if (live) setState({ fp, data: {
        agents: a.status === "fulfilled" && Array.isArray(a.value.agents) ? a.value.agents : null,
        peers: p.status === "fulfilled" && Array.isArray(p.value.contacts) ? p.value.contacts : null,
        quotas: q.status === "fulfilled" && Array.isArray(q.value.providers) ? q.value.providers : null,
      } });
      loading = false;
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const visible = () => void load();
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; ctrl.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [fp]);
  return state.fp === fp ? state.data : EMPTY;
}
