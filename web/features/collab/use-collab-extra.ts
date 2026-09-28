"use client";
/**
 * 协作视图第二版（T12c）的两份数据：「上次以来」与审查员信号。useCollab 的事件流与总览照旧，这里只挂在它旁边。
 *
 * 上次以来：打开时读基准 B（服务端按 principal × 项目记），用 ?since=B 拉一次总览，只留 B 到打开那一刻（服务端时刻）的事件——
 * 看着页面时发生的事是实时看到的，不进摘要。打开时不标记「看过」（刷新不丢摘要）；页面隐藏、离开、点「知道了」才标记；
 * 回前台重读，摘要就是离开期间的事。老 bridge 没有这个接口：读失败就当没有摘要。
 * 刷新页面在浏览器眼里也是一次「隐藏」，会先把看过记上；所以同一个标签页刷新后的第一次读取，沿用刷新前那份基准（sessionStorage）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBgTasks, fetchLastSeen, fetchLedger, markLastSeen } from "@/lib/api/ledger";
import type { LedgerEventView, LedgerOverview } from "./collab-model";
import { pmSet, reduceReviewer, seedReviewers, type ReviewerMap } from "./collab-reviewers";
import type { BridgeEvent } from "@/lib/chat/stream-shape";

export interface SinceState {
  /** 上次看的时刻；null = 第一次来 / 接口不可用 / 已点「知道了」 */
  since: number | null;
  events: LedgerEventView[];
}

const EMPTY: SinceState = { since: null, events: [] };
const CARRY_KEY = (project: string) => `cstra.collab.since.${project}`;
/** 这次页面加载是不是刷新；每个项目只沿用一次（之后在 App 里关了再开，就是新的一次「来」） */
const RELOADED = typeof performance !== "undefined" && (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
const carried = new Set<string>();
/**
 * 离开视图的「看过」晚一点发：同一个项目紧接着又挂上（开发态 StrictMode 的卸载-重挂、热更新、覆盖层重建）就撤销，
 * 否则重挂后的读取会拿到刚写的新基准，摘要一闪就没。真离开时 1.5s 后照发。
 */
const LEAVE_MARK_MS = 1500;
const leaveMarks = new Map<string, ReturnType<typeof setTimeout>>();

function carryRead(project: string): number | null {
  if (!RELOADED || carried.has(project)) return null;
  carried.add(project);
  try {
    const n = Number(sessionStorage.getItem(CARRY_KEY(project)));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // 隐私模式 / 存储被禁：刷新后摘要从服务端的新基准算，只是少几条
    return null;
  }
}

function carryWrite(project: string, since: number | null): void {
  try {
    if (since === null) sessionStorage.removeItem(CARRY_KEY(project));
    else sessionStorage.setItem(CARRY_KEY(project), String(since));
  } catch {
    // 同上：只影响刷新后能不能接着显示这份摘要
  }
}

export function useLastSeen(project: string): { state: SinceState; dismiss: () => void } {
  const [state, setState] = useState<SinceState>(EMPTY);
  const gen = useRef(0);
  const mark = useCallback(() => {
    markLastSeen(project).catch(() => undefined); // 标记没发出去：下次打开摘要多带几条已看过的事，不影响别的
  }, [project]);

  useEffect(() => {
    clearTimeout(leaveMarks.get(project));
    leaveMarks.delete(project);
    let visible = document.visibilityState !== "hidden";
    const ctrl = new AbortController();
    const load = async () => {
      // 后发的读取与「知道了」都会让先发的这次作废
      const mine = ++gen.current;
      const current = () => !ctrl.signal.aborted && mine === gen.current;
      try {
        const got = await fetchLastSeen(project, ctrl.signal);
        const carry = carryRead(project);
        const { now } = got;
        const lastSeen = carry !== null && (got.lastSeen === null || carry < got.lastSeen) ? carry : got.lastSeen;
        if (lastSeen === null) {
          // 第一次来：没有「上次」，直接记下这次
          mark();
          if (current()) setState(EMPTY);
          return;
        }
        const ov = await fetchLedger(project, ctrl.signal, lastSeen);
        if (!current()) return;
        const events = (ov.sinceEvents ?? []).filter((e) => e.ts <= now);
        setState({ since: lastSeen, events });
        carryWrite(project, events.length ? lastSeen : null);
      } catch {
        // 老 bridge（404）/ 没权限 / 断网：这次不出摘要，首页照常
        if (current()) setState(EMPTY);
      }
    };
    const onVisibility = () => {
      const now = document.visibilityState !== "hidden";
      if (now === visible) return;
      visible = now;
      if (now) void load();
      else mark();
    };
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ctrl.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      if (visible)
        leaveMarks.set(project, setTimeout(() => {
          leaveMarks.delete(project);
          mark();
        }, LEAVE_MARK_MS));
    };
  }, [project, mark]);

  const dismiss = useCallback(() => {
    gen.current++;
    setState(EMPTY);
    carryWrite(project, null);
    mark();
  }, [project, mark]);
  return { state, dismiss };
}

/**
 * PM 审查员子 agent 的在跑表：流里的 bg_task_started / completed 增量维护；连上 / 重连（onOpen）与 PM 名单、任务号变化时
 * 以各 PM 的 bg-tasks 快照整表重建。onEvent / reseed 引用稳定，useCollab 的流回调可以直接挂。
 */
export function useReviewers(ov: LedgerOverview | null): { map: ReviewerMap; onEvent: (e: BridgeEvent) => void; reseed: () => void } {
  const [map, setMap] = useState<ReviewerMap>(() => new Map());
  const pmsKey = (ov?.meta.pms ?? []).join("\n");
  const idsKey = (ov?.tasks ?? []).map((t) => t.id).join("\n");
  const ctx = useRef({ pms: pmSet([]), ids: [] as string[], names: [] as string[] });
  const gen = useRef(0);

  const reseed = useCallback(() => {
    const { pms, ids, names } = ctx.current;
    const mine = ++gen.current;
    if (!names.length || !ids.length) return setMap(new Map());
    void Promise.all(names.map(async (pm) => ({ pm, tasks: await fetchBgTasks(pm) }))).then((snaps) => {
      if (mine === gen.current) setMap(seedReviewers(snaps, pms, ids));
    });
  }, []);

  useEffect(() => {
    const names = pmsKey ? pmsKey.split("\n") : [];
    ctx.current = { pms: pmSet(names), ids: idsKey ? idsKey.split("\n") : [], names };
    reseed();
  }, [pmsKey, idsKey, reseed]);

  const onEvent = useCallback((e: BridgeEvent) => {
    const { pms, ids } = ctx.current;
    setMap((m) => reduceReviewer(m, e, pms, ids, Date.now()));
  }, []);
  return { map, onEvent, reseed };
}
