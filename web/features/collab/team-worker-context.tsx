"use client";
import { useEffect, useState } from "react";
import { useMachineFp } from "../talk/use-talk";
import { api } from "@/lib/api/client";
import s from "./team-worker-context.module.css";

type Snapshot = {
  known: boolean; sessionId?: string; used?: number | null; size?: number | null; remaining?: number | null;
  today?: number | null; estimated?: boolean; cardAtLimit?: boolean; overRuntime?: boolean;
};
const number = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "未知";

/** Request state is bound to the selection; a failed read cannot retain a previous session's numbers. */
export function TeamWorkerContext({ agent, peer = "" }: { agent: string; peer?: string }) {
  const machine = useMachineFp();
  const key = `${machine}/${peer}/${agent}`;
  const [state, setState] = useState<{ key: string; value: Snapshot | null }>();
  useEffect(() => {
    const ctrl = new AbortController();
    let session: string | undefined;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const q = new URLSearchParams({ agent, peer, ...(session ? { session } : {}) });
      try {
        const value = await api<Snapshot>(`/team/worker-context?${q}`, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) { session = value.sessionId; setState({ key, value }); }
      } catch {
        // Transport errors and session drift must hide old facts until a fresh identity can be read.
        session = undefined;
        if (!ctrl.signal.aborted) setState({ key, value: null });
      } finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [agent, peer, key]);
  const v = state?.key === key && state.value?.known ? state.value : null;
  return <span data-context-over={v?.cardAtLimit || v?.overRuntime ? "true" : "false"} className={`${s.summary} ${v?.cardAtLimit || v?.overRuntime ? s.over : ""}`}>
    <span title="JSONL usage不提供系统提示、工具、记忆和消息的token分项；这些构成均未知。">
      系统／工具／记忆／消息：未知</span>
    <span title="剩余=已知runtime窗口−当前session用量；卡片300K线独立于runtime窗口。">
      {v?.estimated ? "~" : ""}上下文 {number(v?.used)} · 剩余 {number(v?.remaining)}</span>
    <span title="当前session的本地今日用量，含缓存读写；不代表agent跨会话今日总量。">
      今日（本会话，含缓存）{number(v?.today)}</span>
  </span>;
}
