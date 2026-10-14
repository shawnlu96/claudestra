"use client";
/**
 * 「今天」页的跨项目数据（TODAY1）：每个本机项目的台账总览（fetchLedger）与产品看板（fetchProductBoard）。
 * - 只在 on（页面版挂着 / 侧栏条展开）时读；收起、卸载即中止在途请求与事件流（AbortSignal）。
 * - 台账 403 / 404：记 setLedgerAccess(id, "no")，这一页之后不再读它（看板也不读），只出项目行。
 * - 刷新：页面可见时每 60 秒一轮；/events 的 ledger 事件防抖 2 秒，只重读那一个项目。
 * - 不读 GET /quota（用量看板判「有人在看」的心跳，use-subscription-quota.ts），额度由 now-team-quota.tsx 读 /lend/quota-lines。
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchLedger, followCollabEvents } from "@/lib/api/ledger";
import { fetchProductBoard, type ProductBoard } from "@/lib/api/product-board";
import { setLedgerAccess } from "../collab/collab-cache";
import type { LedgerOverview } from "../collab/collab-model";
import { pageVisibility } from "../collab/use-collab";

export const LEDGER_POLL_MS = 60_000;
export const LEDGER_EVENT_DEBOUNCE_MS = 2_000;
const STREAM_RETRY_MIN_MS = 2_000;
const STREAM_RETRY_MAX_MS = 60_000;

export interface TodayLedgers {
  overviews: ReadonlyMap<string, LedgerOverview>;
  boards: ReadonlyMap<string, ProductBoard>;
  denied: ReadonlySet<string>;
}

const EMPTY: TodayLedgers = { overviews: new Map(), boards: new Map(), denied: new Set() };
const shut = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);

/** 各项目一读：台账读不了就记下不再读；看板读不到（没有看板 / 老 bridge）= 这个项目退回按 agent 列 */
async function readOne(id: string, signal: AbortSignal): Promise<{ ov?: LedgerOverview; board?: ProductBoard | null; denied?: true }> {
  const [ov, board] = await Promise.allSettled([fetchLedger(id, signal), fetchProductBoard(id, signal)]);
  if (ov.status === "rejected") return shut(ov.reason) ? { denied: true } : {};
  return { ov: ov.value, board: board.status === "fulfilled" ? board.value : shut(board.reason) ? null : undefined };
}

function untilShown(signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const done = () => { off(); r(); };
    const off = pageVisibility.onShow(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** 事件流断了就退避重连；页面隐藏时不连，回前台再连 */
async function follow(signal: AbortSignal, onLedger: (project: string) => void): Promise<void> {
  let wait = STREAM_RETRY_MIN_MS;
  while (!signal.aborted) {
    if (pageVisibility.hidden()) await untilShown(signal);
    if (signal.aborted) return;
    await followCollabEvents({
      signal,
      onOpen: () => { wait = STREAM_RETRY_MIN_MS; },
      onEvent: (e) => { if (e.type === "ledger" && typeof e.data?.project === "string") onLedger(e.data.project); },
    }).catch(() => undefined); // 连不上 / 断开：下面退避再连，不影响 60 秒一轮的轮询
    if (signal.aborted) return;
    await new Promise<void>((r) => { const t = setTimeout(r, wait); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    wait = Math.min(wait * 2, STREAM_RETRY_MAX_MS);
  }
}

export function useTodayLedgers(projectIds: readonly string[], on: boolean): TodayLedgers {
  const [data, setData] = useState<TodayLedgers>(EMPTY);
  const denied = useRef(new Set<string>());
  const key = projectIds.join("\n");
  useEffect(() => {
    if (!on) return;
    const ids = key ? key.split("\n") : [];
    const ctl = new AbortController(), signal = ctl.signal;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const read = async (id: string) => {
      if (denied.current.has(id) || signal.aborted) return;
      const got = await readOne(id, signal);
      if (signal.aborted) return;
      if (got.denied) {
        denied.current.add(id);
        setLedgerAccess(id, "no");
      }
      setData((d) => {
        const overviews = new Map(d.overviews), boards = new Map(d.boards);
        if (got.ov) overviews.set(id, got.ov);
        if (got.denied) overviews.delete(id);
        if (got.board) boards.set(id, got.board);
        else if (got.board === null || got.denied) boards.delete(id);
        return { overviews, boards, denied: new Set(denied.current) };
      });
    };
    let last = 0;
    const all = () => {
      if (pageVisibility.hidden()) return;
      last = Date.now();
      for (const id of ids) void read(id);
    };
    all();
    const poll = setInterval(all, LEDGER_POLL_MS);
    // 从后台回来：上一轮已经超过一分钟才补一轮，不在来回切标签时多读
    const offShow = pageVisibility.onShow(() => { if (Date.now() - last >= LEDGER_POLL_MS) all(); });
    void follow(signal, (project) => {
      if (!ids.includes(project) || denied.current.has(project)) return;
      clearTimeout(timers.get(project));
      timers.set(project, setTimeout(() => void read(project), LEDGER_EVENT_DEBOUNCE_MS));
    });
    return () => {
      ctl.abort();
      clearInterval(poll);
      offShow();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [key, on]);
  return data;
}
