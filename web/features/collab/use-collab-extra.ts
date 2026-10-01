"use client";
/**
 * 协作视图第二版（T12c）的两份数据：「上次以来」与审查员信号。useCollab 的事件流与总览照旧，这里只挂在它旁边。
 *
 * 上次以来：打开时一个请求拿到基准 B 和 B 之后到服务端此刻的事件（local-api/last-seen.ts）——看着页面时发生的事是实时看到的，
 * 不进摘要。打开时不标记「看过」（刷新不丢摘要）；页面隐藏、离开视图（延迟 1.5s）、点「知道了」才标记；回前台重读。
 * 刷新在浏览器眼里也是一次「隐藏」，会先把看过记上：所以 pagehide 时把正在显示的摘要基准连同写入时刻记进 sessionStorage，
 * 刷新后的第一次读取只认几秒内写的那份。离开视图、点「知道了」都不写，已看过的摘要不会借刷新复活（审查 T12C r1 P1-1）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBgTasks, fetchLastSeen, markLastSeen } from "@/lib/api/ledger";
import { metaOf } from "@/lib/ledger-meta-guard";
import type { LedgerEventView, LedgerOverview } from "./collab-model";
import type { ReviewTarget } from "./collab-reviewer-parse";
import { isPlaceholderStart, pmSet, reduceReviewer, seedReviewers, type BgEvent, type ReviewerMap } from "./collab-reviewers";
import type { BridgeEvent } from "@/lib/chat/stream-shape";

export interface SinceState {
  /** 上次看的时刻；null = 第一次来 / 接口不可用 / 已点「知道了」 */
  since: number | null;
  events: LedgerEventView[];
  /** 事件太多、服务端只给了最新的一段：摘要要说「没列全」 */
  truncated: boolean;
}

const EMPTY: SinceState = { since: null, events: [], truncated: false };
const CARRY_PREFIX = "cstra.collab.since.";
/** pagehide 写入到新页面开始加载之间通常不到一秒；放宽到 10s 容慢机器，再久就当是另一次「来」 */
const CARRY_MAX_AGE_MS = 10_000;
/** 这次页面加载是不是刷新 */
const RELOADED = typeof performance !== "undefined" && (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";

/**
 * 页面加载时一次把所有 carry 读出来并删掉，不管是哪种导航；只有刷新才采用。否则整页离开时写下的 carry
 * 会留到以后某次刷新再被捡起来，已看过的摘要借机复活（审查 T12C r2 P2-1）。每个项目只沿用一次。
 */
const inherited: Map<string, number> = (() => {
  const out = new Map<string, number>();
  if (typeof window === "undefined") return out;
  const loadedAt = performance.timeOrigin || Date.now();
  let keys: string[] = [];
  try {
    keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i) ?? "").filter((k) => k.startsWith(CARRY_PREFIX));
  } catch {
    // 隐私模式 / 存储被禁：没有 carry 可读，刷新后摘要从服务端的新基准算，只是少几条
    return out;
  }
  for (const k of keys) {
    try {
      const c = JSON.parse(sessionStorage.getItem(k) ?? "null") as { since?: unknown; at?: unknown } | null;
      sessionStorage.removeItem(k);
      const fresh = c && typeof c.since === "number" && c.since > 0 && typeof c.at === "number" && Math.abs(loadedAt - c.at) <= CARRY_MAX_AGE_MS;
      if (RELOADED && fresh) out.set(k.slice(CARRY_PREFIX.length), c.since as number);
    } catch {
      // 内容写坏：这一条当没有
    }
  }
  return out;
})();

function carryTake(project: string): number | null {
  const v = inherited.get(project) ?? null;
  inherited.delete(project);
  return v;
}
/** 此刻挂着、正在显示摘要的项目 → 它的基准；pagehide 时写进 sessionStorage */
const showing = new Map<string, number>();
/**
 * 离开视图的「看过」晚一点发：同一个项目紧接着又挂上（StrictMode 的卸载-重挂、热更新、覆盖层重建）就撤销，
 * 否则重挂后的读取会拿到刚写的新基准，摘要一闪就没。真离开时 1.5s 后照发；这 1.5s 里页面被隐藏 / 关掉就立刻发（P2-1）。
 */
const LEAVE_MARK_MS = 1500;
const leaveMarks = new Map<string, ReturnType<typeof setTimeout>>();

function sendMark(project: string): void {
  markLastSeen(project).catch(() => undefined); // 标记没发出去：下次打开摘要多带几条已看过的事，不影响别的
}

function flushLeaveMarks(): void {
  for (const [project, t] of leaveMarks) {
    clearTimeout(t);
    sendMark(project);
  }
  leaveMarks.clear();
}

let pageHooked = false;
/** 模块级只挂一次：pagehide 把挂着的离开标记发出去、把正在显示的摘要基准留给刷新；隐藏时也先把离开标记发掉 */
function hookPage(): void {
  if (pageHooked || typeof window === "undefined") return;
  pageHooked = true;
  window.addEventListener("pagehide", () => {
    flushLeaveMarks();
    for (const [project, since] of showing) {
      try {
        sessionStorage.setItem(CARRY_PREFIX + project, JSON.stringify({ since, at: Date.now() }));
      } catch {
        // 同上：只影响刷新后能不能接着显示这份摘要
      }
    }
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushLeaveMarks());
}

export function useLastSeen(project: string): { state: SinceState; dismiss: () => void } {
  const [state, setState] = useState<SinceState>(EMPTY);
  const gen = useRef(0);

  useEffect(() => {
    hookPage();
    clearTimeout(leaveMarks.get(project));
    leaveMarks.delete(project);
    let visible = document.visibilityState !== "hidden";
    const ctrl = new AbortController();
    const show = (next: SinceState) => {
      setState(next);
      if (next.since !== null && next.events.length) showing.set(project, next.since);
      else showing.delete(project);
    };
    const load = async () => {
      // 后发的读取与「知道了」都会让先发的这次作废
      const mine = ++gen.current;
      const current = () => !ctrl.signal.aborted && mine === gen.current;
      try {
        const carry = carryTake(project);
        const got = await fetchLastSeen(project, ctrl.signal, carry);
        if (!current()) return;
        const since = carry ?? got.lastSeen;
        // 第一次来：没有「上次」，直接记下这次
        if (since === null) sendMark(project);
        show(since === null ? EMPTY : { since, events: got.events ?? [], truncated: got.truncated === true });
      } catch {
        // 老 bridge（404）/ 没权限 / 断网：这次不出摘要，首页照常
        if (current()) show(EMPTY);
      }
    };
    const onVisibility = () => {
      const now = document.visibilityState !== "hidden";
      if (now === visible) return;
      visible = now;
      if (now) void load();
      else sendMark(project);
    };
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ctrl.abort();
      showing.delete(project);
      inherited.delete(project);
      document.removeEventListener("visibilitychange", onVisibility);
      if (visible)
        leaveMarks.set(project, setTimeout(() => {
          leaveMarks.delete(project);
          sendMark(project);
        }, LEAVE_MARK_MS));
    };
  }, [project]);

  const dismiss = useCallback(() => {
    gen.current++;
    setState(EMPTY);
    showing.delete(project);
    inherited.delete(project);
    sendMark(project);
  }, [project]);
  return { state, dismiss };
}

/** description 晚到的占位 started：过这么久按快照重建一次（bridge 取快照时会重读 meta） */
const PLACEHOLDER_RESEED_MS = 8000;

/**
 * PM 审查员子 agent 的在跑表：流里的 bg_task_started / completed 增量维护；连上 / 重连（onOpen）与 PM 名单、任务变化时
 * 以各 PM 的 bg-tasks 快照整表重建。快照在途期间到的事件先记下，快照落地后叠在它上面重放——
 * 不然旧快照会把后到的 completed 盖回去、把在途的 started 丢掉（审查 T12C r1 P2-3）。onEvent / reseed 引用稳定。
 */
export function useReviewers(ov: LedgerOverview | null): { map: ReviewerMap; onEvent: (e: BridgeEvent) => void; reseed: () => void } {
  const [map, setMap] = useState<ReviewerMap>(() => new Map());
  const pmsKey = metaOf(ov).pms.join("\n");
  const targetsKey = JSON.stringify((ov?.tasks ?? []).map((t) => [t.id, t.pr ?? null]));
  const ctx = useRef({ pms: pmSet([]), targets: [] as ReviewTarget[], names: [] as string[] });
  const gen = useRef(0);
  const inflight = useRef<BgEvent[] | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reseed = useCallback(() => {
    const { pms, targets, names } = ctx.current;
    const mine = ++gen.current;
    clearTimeout(retry.current);
    if (!names.length || !targets.length) {
      inflight.current = null;
      return setMap(new Map());
    }
    inflight.current = [];
    void Promise.all(names.map(async (pm) => ({ pm, tasks: await fetchBgTasks(pm) }))).then((snaps) => {
      if (mine !== gen.current) return;
      const late = inflight.current ?? [];
      inflight.current = null;
      setMap(late.reduce<ReviewerMap>((m, e) => reduceReviewer(m, e, pms, targets, Date.now()), seedReviewers(snaps, pms, targets)));
    });
  }, []);

  useEffect(() => {
    const names = pmsKey ? pmsKey.split("\n") : [];
    const targets = (JSON.parse(targetsKey) as [string, string | null][]).map(([id, pr]) => ({ id, pr }));
    ctx.current = { pms: pmSet(names), targets, names };
    reseed();
  }, [pmsKey, targetsKey, reseed]);
  useEffect(() => () => clearTimeout(retry.current), []);

  const onEvent = useCallback((e: BridgeEvent) => {
    const { pms, targets } = ctx.current;
    inflight.current?.push(e);
    setMap((m) => reduceReviewer(m, e, pms, targets, Date.now()));
    if (isPlaceholderStart(e, pms)) {
      clearTimeout(retry.current);
      retry.current = setTimeout(reseed, PLACEHOLDER_RESEED_MS);
    }
  }, [reseed]);
  return { map, onEvent, reseed };
}
