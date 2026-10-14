"use client";
/**
 * 「今天」页的跨项目数据（TODAY1）：每个本机项目的台账总览（fetchLedger）与产品看板（fetchProductBoard）。
 * - 只在 on（页面版挂着 / 侧栏条展开）时读；同时挂着几份也只跑一套（共用一份读取）；都收起 / 卸载即中止在途请求与事件流（AbortSignal）。
 * - 台账 403 / 404：记 setLedgerAccess(id, "no")，这一页之后不再读它（看板也不读），只出项目行。
 * - 刷新：页面可见时每 60 秒一轮；/events 的 ledger 事件防抖 2 秒，只重读那一个项目。
 * - 不读 GET /quota（用量看板判「有人在看」的心跳，use-subscription-quota.ts），额度由 now-team-quota.tsx 读 /lend/quota-lines。
 */
import { useEffect, useSyncExternalStore } from "react";
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

/**
 * 一份读取，大家共用：页面版（空状态主区、「整页」盖出来的那层）和展开的侧栏条可能同时挂着，
 * 各自起轮询就成了每项目每分钟读好几遍。这里按「谁在看」登记，所有在看的合起来只跑一套轮询 + 事件流，
 * 拒绝访问的记录也只有一份；最后一个不看了（收起 / 卸载）才中止。
 */
const shared = {
  data: EMPTY,
  denied: new Set<string>(),
  listeners: new Set<() => void>(),
  users: new Map<object, readonly string[]>(),
  run: null as { key: string; stop: () => void } | null,
};

function update(fn: (d: TodayLedgers) => TodayLedgers) {
  shared.data = fn(shared.data);
  for (const l of shared.listeners) l();
}

function subscribe(l: () => void): () => void {
  shared.listeners.add(l);
  return () => { shared.listeners.delete(l); };
}

/** 跑一套：立即读一轮，可见时 60 秒一轮，ledger 事件防抖只重读那一个项目；返回中止 */
function start(ids: readonly string[]): () => void {
  const ctl = new AbortController(), signal = ctl.signal;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const read = async (id: string) => {
    if (shared.denied.has(id) || signal.aborted) return;
    const got = await readOne(id, signal);
    if (signal.aborted) return;
    if (got.denied) {
      shared.denied.add(id);
      setLedgerAccess(id, "no");
    }
    update((d) => {
      const overviews = new Map(d.overviews), boards = new Map(d.boards);
      if (got.ov) overviews.set(id, got.ov);
      if (got.denied) overviews.delete(id);
      if (got.board) boards.set(id, got.board);
      else if (got.board === null || got.denied) boards.delete(id);
      return { overviews, boards, denied: new Set(shared.denied) };
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
    if (!ids.includes(project) || shared.denied.has(project)) return;
    clearTimeout(timers.get(project));
    timers.set(project, setTimeout(() => void read(project), LEDGER_EVENT_DEBOUNCE_MS));
  });
  return () => {
    ctl.abort();
    clearInterval(poll);
    offShow();
    for (const t of timers.values()) clearTimeout(t);
  };
}

/** 按在看的人合起来的项目集重排：集合没变就不动（第二个人来看不会多读一轮），变了才重起，没人看就中止 */
function sync() {
  const ids = [...new Set([...shared.users.values()].flat())];
  const key = ids.join("\n");
  if (shared.run?.key === key) return;
  shared.run?.stop();
  shared.run = ids.length ? { key, stop: start(ids) } : null;
}

/** 测试用：中止并清空共用的读取（拒绝访问的记录也清掉） */
export function resetTodayLedgersForTest() {
  shared.users.clear();
  shared.run?.stop();
  shared.run = null;
  shared.denied.clear();
  update(() => EMPTY);
}

export function useTodayLedgers(projectIds: readonly string[], on: boolean): TodayLedgers {
  const data = useSyncExternalStore(subscribe, () => shared.data, () => EMPTY);
  const key = projectIds.join("\n");
  useEffect(() => {
    if (!on) return;
    const me = {};
    shared.users.set(me, key ? key.split("\n") : []);
    sync();
    return () => {
      shared.users.delete(me);
      // 挪到微任务：同一拍里换人看（整页盖上 / StrictMode 重挂）不先中止再重读
      queueMicrotask(sync);
    };
  }, [key, on]);
  return data;
}
