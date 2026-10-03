"use client";
/**
 * 出借面板的数据与收回：GET 轮询（有停止中的单 2 秒，否则 30 秒）、收回的乐观「停止中」与撤回、授权淡出。
 * 渲染里不读时钟：now 由计时器推进。GET 落不落地由 lend-model 的 LoadGate 判；上一次轮询还没回来就跳过这一拍，请求不叠。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchLend, postRevoke } from "./lend-api";
import {
  finishLoad, invalidateLoads, markStopping, mergeOrders, needsFastPoll, newLoadGate, startLoad, STOPPING_POLL_MS, unmarkStopping, withSnapshot,
  type LendData, type OrderView,
} from "./lend-model";

const IDLE_POLL_MS = 30_000;
const FADE_MS = 300;

export function useLendState() {
  const [data, setData] = useState<LendData | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState("");
  const [view, setView] = useState<{ orders: OrderView[]; stopping: Map<string, number> }>({ orders: [], stopping: new Map() });
  const { orders, stopping } = view;
  const [now, setNow] = useState(0);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<{ peer: string; msg: string; n: number } | null>(null);

  const gate = useRef(newLoadGate());
  const load = useCallback(async (): Promise<LendData | null | undefined> => {
    const ticket = startLoad(gate.current);
    try {
      const d = await fetchLend();
      if (!finishLoad(gate.current, ticket, true)) return d;
      setData(d);
      setLoadErr("");
      if (d) setView((v) => mergeOrders(v.orders, d.orders, v.stopping));
      return d;
    } catch (e) {
      if (finishLoad(gate.current, ticket, false)) setLoadErr(e instanceof Error ? e.message : String(e)); // 拉失败保持上一份数据：停止中的单不会被误显示成已停
      return undefined;
    }
  }, []);

  const fast = needsFastPoll(stopping);
  useEffect(() => {
    void load();
    const iv = setInterval(() => { if (!gate.current.inflight) void load(); }, fast ? STOPPING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(iv);
  }, [load, fast]);
  useEffect(() => {
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), fast ? 1_000 : IDLE_POLL_MS);
    return () => clearInterval(iv);
  }, [fast]);

  const revoke = async (peer: string) => {
    const at = Date.now();
    const marked = markStopping(stopping, peer, [], orders, at);
    const added = [...marked.keys()].filter((id) => !stopping.has(id));
    invalidateLoads(gate.current);
    setBusy(peer);
    setView((v) => ({ ...v, stopping: markStopping(v.stopping, peer, [], v.orders, at) }));
    setNow(at);
    try {
      const r = await postRevoke(peer);
      const snap = r.orders ?? [];
      invalidateLoads(gate.current);
      setRevokeErr(null);
      setView((v) => ({ orders: withSnapshot(v.orders, snap), stopping: markStopping(v.stopping, peer, snap, v.orders, at) }));
      setLeaving((s) => new Set(s).add(peer));
      setTimeout(() => {
        setData((d) => (d ? { ...d, grants: d.grants.filter((g) => g.peer !== peer) } : d));
        setLeaving((s) => { const n = new Set(s); n.delete(peer); return n; });
        void load();
      }, FADE_MS);
    } catch (e) {
      setRevokeErr((x) => ({ peer, msg: e instanceof Error ? e.message : String(e), n: (x?.n ?? 0) + 1 }));
      // bridge 回 400 / 403 = 明确没收回，撤掉这次的停止标记；请求断了（超时 / 断网）说不准，重拉后授权还在才撤
      const refused = e instanceof ApiError && (e.status === 400 || e.status === 403);
      const d = refused ? undefined : await load();
      if (refused || !d || d.grants.some((g) => g.peer === peer)) setView((v) => ({ ...v, stopping: unmarkStopping(v.stopping, added) }));
    } finally {
      setBusy(null);
    }
  };

  return { data, loadErr, orders, stopping, now, leaving, busy, revokeErr, load, revoke };
}
