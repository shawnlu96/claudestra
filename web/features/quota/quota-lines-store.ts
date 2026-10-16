"use client";
/**
 * 额度的一个读数源（QUOTA1）：顶部额度卡、「今天 · 团队与额度」、用量看板顶部摘要、协作视图的 useWeekQuota 都从这里读，
 * 同一个读数只轮询一份。
 * - /lend/quota-lines：模块级缓存 + 60 秒一次（useQuotaLines）；
 * - /quota/wall：30 秒一次（useQuotaWall），「已恢复」后 reloadQuotaWall() 立刻重读。
 * 有订阅者才拉、页面隐藏就停（回到前台时距上次已过一个周期才补拉一次）、订阅者归零就停。
 * 403 / 404（不给看 / 老 bridge）与 401（凭据失效）= null，这台机器本页不再拉；其他失败保留上次读数，下一轮再试。
 * 回包按发出顺序落地：慢的旧回包不盖新的。切机器清空读数、按新机器重拉。不读 GET /quota（用量看板「有人在看」的心跳）。
 */
import { useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";
import { fetchQuotaLines } from "../lend/lend-quota-api";
import type { QuotaLinesView } from "../lend/lend-quota-model";
import type { WallResponse } from "../quota-wall/wall-banner-model";

/** value：undefined = 还没读到；null = 读不到（403 / 404 / 401）；at = 最近一次读数落地的时刻；
 *  checkedAt = 最近一次轮询结束（成功或失败）/ 回到前台的时刻，模型判「已过重置」用它当现在：接口失败读数不变，时钟照样往前走 */
export interface Reading<T> { fp: string; value: T | null | undefined; at: number; checkedAt: number }

interface Source<T> {
  subscribe(cb: () => void): () => void;
  get(): Reading<T>;
  reload(): void;
  /** 测试用：回到刚建好的样子（清读数、解除停拉、忘掉上次拉取时刻） */
  resetForTest(): void;
}

const fpNow = () => machines.currentFp() ?? "local";
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

function createSource<T>(name: string, load: () => Promise<T | null>, periodMs: () => number): Source<T> {
  const subs = new Set<() => void>();
  let snap: Reading<T> = { fp: fpNow(), value: undefined, at: 0, checkedAt: 0 };
  let stopped = false;
  let sent = 0;
  let landed = 0;
  let lastAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let offMachines: (() => void) | null = null;

  const emit = () => { for (const cb of subs) cb(); };
  const land = (value: T | null) => { const t = Date.now(); snap = { fp: snap.fp, value, at: t, checkedAt: t }; emit(); };
  /** 读数不变、只推进时钟（失败 / 回到前台）：已过重置的提醒随之收起 */
  const tick = () => { snap = { ...snap, checkedAt: Date.now() }; emit(); };

  function fetchNow() {
    if (stopped || !visible()) return;
    const fp = snap.fp, ticket = ++sent;
    lastAt = Date.now();
    load().then((v) => {
      if (fp !== snap.fp || ticket < landed) return; // 旧机器 / 比已落地的更旧：丢掉
      landed = ticket;
      if (v === null) stopped = true; // 403 / 404：这台机器本页不再拉
      land(v);
    }, (e: unknown) => {
      if (fp !== snap.fp) return;
      if (e instanceof ApiError && e.status === 401) { // 凭据失效（不论先后都生效）：清掉已显示的读数再停拉
        stopped = true;
        landed = Math.max(landed, ticket);
        return land(null);
      }
      console.debug(`[quota] ${name} 拉取失败（保持上次读数，下一轮再试）:`, e);
      tick();
    });
  }
  const arm = () => {
    if (timer) clearInterval(timer);
    timer = visible() && !stopped ? setInterval(fetchNow, periodMs()) : null;
  };
  const onVisibility = () => {
    if (visible()) {
      if (Date.now() - lastAt >= periodMs()) fetchNow();
      tick();
    }
    arm(); // 隐藏就停表，回前台重新起表
  };
  /** 换了机器：清空读数、解除停拉（新机器重新问）；返回是否换了 */
  const switchMachine = (): boolean => {
    const fp = fpNow();
    if (fp === snap.fp) return false;
    snap = { fp, value: undefined, at: 0, checkedAt: 0 };
    stopped = false;
    lastAt = 0;
    return true;
  };
  const onMachine = () => {
    if (!switchMachine()) return;
    emit();
    fetchNow();
    arm();
  };
  function start() {
    offMachines = machines.subscribe(onMachine);
    document.addEventListener("visibilitychange", onVisibility);
    switchMachine();
    if (Date.now() - lastAt >= periodMs()) fetchNow(); // 刚拉过（含在途）就不重复拉：挂载抖动不多发请求
    arm();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    offMachines?.();
    offMachines = null;
    document.removeEventListener("visibilitychange", onVisibility);
  }
  return {
    subscribe(cb) {
      subs.add(cb);
      if (subs.size === 1) start();
      return () => {
        subs.delete(cb);
        if (subs.size === 0) stop();
      };
    },
    get: () => snap,
    reload: fetchNow,
    resetForTest() {
      snap = { fp: fpNow(), value: undefined, at: 0, checkedAt: 0 };
      stopped = false;
      sent = 0;
      landed = 0;
      lastAt = 0;
    },
  };
}

const period = { lines: 60_000, wall: 30_000 };

async function fetchWall(): Promise<WallResponse | null> {
  try {
    return await api<WallResponse>("/quota/wall", { timeoutMs: 8000 });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null; // 不是 owner / bridge 太老
    throw e;
  }
}

const lines = createSource<QuotaLinesView>("/lend/quota-lines", fetchQuotaLines, () => period.lines);
const wall = createSource<WallResponse>("/quota/wall", fetchWall, () => period.wall);
const serverSnap = { fp: "local", value: undefined, at: 0, checkedAt: 0 };
const serverReading = () => serverSnap as Reading<never>;

/** /lend/quota-lines 的读数（整份 Reading：fp 用来丢掉别的机器的旧值，checkedAt 当「现在」，见 quotaNow） */
export function useQuotaLinesReading(): Reading<QuotaLinesView> {
  return useSyncExternalStore(lines.subscribe, lines.get, serverReading);
}
/** /quota/wall 的读数 */
export function useQuotaWallReading(): Reading<WallResponse> {
  return useSyncExternalStore(wall.subscribe, wall.get, serverReading);
}

/** 只要值：undefined = 还没读到，null = 读不到 */
export const useQuotaLines = (): QuotaLinesView | null | undefined => useQuotaLinesReading().value;
export const useQuotaWall = (): WallResponse | null | undefined => useQuotaWallReading().value;

/** 模型的「现在」：两个读数最近一次检查的时刻（失败也算），不用最近成功回包时间，接口一直失败也会判出已过重置 */
export const quotaNow = (...rs: Reading<unknown>[]): number => Math.max(...rs.map((r) => r.checkedAt));

/** 「已恢复」POST /quota/wall/clear 之后立刻重读一次闸 */
export const reloadQuotaWall = (): void => wall.reload();

/** 测试用：缩短两个轮询周期（只影响之后起的表） */
export function setQuotaPollForTest(ms: Partial<typeof period>): void {
  Object.assign(period, ms);
}

/** 测试用：两份读数回到初始。读数是模块级的，同一进程里前一个测试文件对同一台机器答过 404 就会一直停拉（tests/web-dom-today-home.test.ts） */
export function resetQuotaReadingsForTest(): void {
  lines.resetForTest();
  wall.resetForTest();
}
