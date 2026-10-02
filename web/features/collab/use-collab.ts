"use client";
/**
 * 协作视图的数据：台账总览 + 一条 /events 连接（ledger 事件触发重拉、各 agent 的此刻动作）。
 * 约定（T8c 报告 · PM 09-28）：连上 / 重连一律全量重拉；只认本项目的 ledger 事件；
 * 视图卸载、页面隐藏都断开这条连接（手机后台挂长连接耗电），回前台再连。
 * 时间：总览带服务端 now，本地记偏移，之后每 30s 本地推算停留时长，不为了走表去重拉。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { collabLoader, type Visibility } from "./collab-loader";
import { useCollabSource } from "./team-source-context";
import type { FollowOpts } from "./team-source";
import { reduceAction, type ActionMap } from "./collab-action";
import { cachedOverview, cacheOverview, clearOverview, setLedgerAccess } from "./collab-cache";
import type { LedgerOverview, Stage } from "./collab-model";
import type { TaskDetail } from "./collab-detail-model";
import type { BridgeEvent } from "@/lib/chat/stream-shape";
import { useReviewers } from "./use-collab-extra";

export type CollabLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; ov: LedgerOverview; error?: string };

/** 刚推进的那一条：从哪个阶段来、什么时候（驱动品牌色高亮与短标签） */
export interface Advance {
  id: string;
  from: Stage;
  at: number;
}

const TICK_MS = 30_000;
const REFETCH_DEBOUNCE_MS = 250;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** 总览 403（设备没有台账权限）不会自己好：重试封顶放到 5 分钟，权限补上后最多等这么久 */
const FORBIDDEN_RETRY_CAP_MS = 5 * 60_000;
const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;
/** 标签页隐藏时总览的失败重试先停（事件流此时也断开），回到前台再拉 */
export const pageVisibility: Visibility = {
  hidden: () => document.visibilityState === "hidden",
  onShow: (cb) => {
    const h = () => document.visibilityState === "visible" && cb();
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  },
};

/** members：本项目的 agent（前端会话名）；别的项目的 agent 在跑什么与这里无关，不进此刻动作表 */
export function useCollab(project: string, members: ReadonlySet<string>) {
  const source = useCollabSource(project);
  const cached = cachedOverview(project);
  const [load, setLoad] = useState<CollabLoad>(cached ? { status: "ok", ov: cached.ov } : { status: "loading" });
  const [offset, setOffset] = useState(cached?.offset ?? 0);
  const [clock, setClock] = useState(() => Date.now());
  const [actions, setActions] = useState<ActionMap>(() => new Map());
  const [rev, setRev] = useState(0);
  const [advance, setAdvance] = useState<Advance | null>(null);
  const prevStages = useRef<Map<string, Stage> | null>(null);
  const loader = useRef<ReturnType<typeof collabLoader<LedgerOverview>> | null>(null);
  const refetch = useCallback(async () => { await loader.current?.refetch(); }, []);

  useEffect(() => {
    const seen = cachedOverview(project)?.ov;
    // 切项目会整个重挂（collab-switch.tsx 按 project 加 key），load / advance 的初值就是这个项目的，这里不再重置
    prevStages.current = seen ? new Map((seen.tasks ?? []).map((t) => [t.id, t.stage])) : null;
    const reader = collabLoader({
      fetch: (signal) => source.overview(signal),
      success: (ov) => {
        const prev = prevStages.current;
        const moved = prev ? (ov.tasks ?? []).find((t) => prev.has(t.id) && prev.get(t.id) !== t.stage) : undefined;
        if (moved) setAdvance({ id: moved.id, from: prev!.get(moved.id)!, at: Date.now() });
        prevStages.current = new Map((ov.tasks ?? []).map((t) => [t.id, t.stage]));
        cacheOverview(project, ov, ov.now - Date.now());
        setOffset(ov.now - Date.now());
        setClock(Date.now());
        setLoad({ status: "ok", ov });
        setRev((r) => r + 1);
      },
      failure: (e) => {
        // 没权限：侧栏入口先收起（读成功会再放出来），视图照样显示重试，只是隔得久一些
        if (forbidden(e)) setLedgerAccess(project, "no");
        const message = e instanceof Error ? e.message : String(e);
        setLoad((cur) => cur.status === "ok" ? { ...cur, error: message } : { status: "error", message });
      },
      capOf: (e) => (forbidden(e) ? FORBIDDEN_RETRY_CAP_MS : RETRY_MAX_MS),
      visibility: pageVisibility,
    });
    loader.current = reader;
    void reader.refetch();
    const tick = setInterval(() => setClock(Date.now()), TICK_MS);
    return () => {
      clearInterval(tick);
      reader.dispose();
    };
  }, [project, source]);
  const membersRef = useRef(members);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  const rv = useReviewers(load.status === "ok" ? load.ov : null);
  const { onEvent: onBg, reseed } = rv;
  const onAction = useCallback((e: BridgeEvent) => {
    if (e.type.startsWith("bg_task_")) return onBg(e);
    if (membersRef.current.has(e.agent.replace(/^agent-/, ""))) setActions((m) => reduceAction(m, e, Date.now()));
  }, [onBg]);
  // 连上 / 重连：全量重拉；断开期间丢掉的事件不补发，旧的此刻动作全部作废，等新事件或 /agents 的 busy 兜底；审查员表按快照重建
  const onOpen = useCallback(() => {
    setActions(new Map());
    reseed();
    void refetch();
  }, [refetch, reseed]);
  const connected = useCollabStream(project, onOpen, refetch, onAction, source.follow);

  const retry = useCallback(() => {
    clearOverview(project);
    setLoad({ status: "loading" });
    return refetch();
  }, [project, refetch]);
  return { load, now: clock + offset, actions, connected, rev, advance, refetch: retry, reviewers: rv.map, source };
}

/**
 * 协作视图自己的一条 /events：连上（含重连）→ onOpen（清旧动作 + 全量重拉）；本项目的 ledger 事件去抖后 onLedger；其余交给 onAction。
 * 卸载、页面隐藏都断开，回前台再连；断线按 2s → 30s 退避重连。返回此刻连没连着。
 */
function useCollabStream(project: string, onOpen: () => void, onLedger: () => Promise<void>, onAction: (e: BridgeEvent) => void, follow: (o: FollowOpts) => Promise<void>): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true;
    let ctrl: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let backoff = RETRY_MIN_MS;
    const disconnect = () => {
      clearTimeout(retry);
      ctrl?.abort();
      ctrl = null;
      setConnected(false);
    };
    const connect = () => {
      if (!alive || ctrl || document.visibilityState === "hidden") return;
      const mine = new AbortController();
      ctrl = mine;
      const lost = () => {
        if (ctrl === mine) ctrl = null;
        setConnected(false);
        if (!alive || mine.signal.aborted) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      };
      follow({
        signal: mine.signal,
        onOpen: () => {
          setConnected(true);
          backoff = RETRY_MIN_MS;
          onOpen();
        },
        onEvent: (e) => {
          if (e.type !== "ledger") return onAction(e);
          if (e.data?.project !== project) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => void onLedger(), REFETCH_DEBOUNCE_MS);
        },
      }).then(lost, lost);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? disconnect() : connect());
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(debounce);
      disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [project, onOpen, onLedger, onAction, follow]);
  return connected;
}

export type DetailLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; d: TaskDetail };

/** 详情：打开某条任务时拉一次；总览每重拉一次（rev 变）就跟着重拉，保持和首页同一时刻 */
export function useTaskDetail(project: string, id: string | null, rev: number): DetailLoad {
  const source = useCollabSource(project);
  const [load, setLoad] = useState<DetailLoad>({ status: "loading" });
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    // 换了任务才显示加载态；同一条任务的后台重拉不闪
    if (shown.current !== id) setLoad({ status: "loading" });
    source.task(id, ctrl.signal).then(
      (d) => {
        if (ctrl.signal.aborted) return;
        shown.current = id;
        setLoad({ status: "ok", d });
      },
      (e: Error) => {
        if (!ctrl.signal.aborted) setLoad((cur) => (cur.status === "ok" && shown.current === id ? cur : { status: "error", message: e.message }));
      },
    );
    return () => ctrl.abort();
  }, [project, id, rev, source]);
  return load;
}
