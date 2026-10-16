"use client";
/**
 * GET /borrow 的轮询 hook（XMACH1）：useBorrowView 从 borrow-panel.tsx 原样搬出（设置 · 伙伴机器页的借入面板）；
 * useSharedBorrowView 是今天页共用的一份（计数 + 团队与额度的借入行）。挂着时每 15 秒拉一次，页面切到后台就停；403 / 404 → hidden。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { POLL_MS } from "./borrow-model";
import { borrowFeed, EMPTY_FEED, type FeedState } from "./borrow-feed";

/** 年龄的时钟：tick 从 0 开始（= 按服务端 now 算），之后每 ms 走一次（设置页借入面板与今天页借入行共用） */
export function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

export function useBorrowView() {
  const [s, setS] = useState<FeedState>(EMPTY_FEED);
  const [feed] = useState(() => borrowFeed(setS));
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      void feed.load();
      iv ??= setInterval(() => void feed.load(), POLL_MS);
    };
    const stop = () => {
      if (iv) clearInterval(iv);
      iv = null;
      feed.stop();
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [feed]);
  return { ...s, feed };
}

/*
 * 今天页共用的一份（「N 个 agent 在干活」的借入数 + 团队与额度的借入行）：同一时刻挂多少处都只一条 15 秒轮询，
 * 最后一处卸下就停；页面切到后台同样停。只读，写操作留在设置页（上面的 useBorrowView 各自一份 feed）。
 */
let shared: FeedState = EMPTY_FEED;
const sharedSubs = new Set<() => void>();
let stopShared: (() => void) | null = null;

function startShared(): () => void {
  const feed = borrowFeed((s) => {
    shared = s;
    sharedSubs.forEach((f) => f());
  });
  let iv: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    void feed.load();
    iv ??= setInterval(() => void feed.load(), POLL_MS);
  };
  const stop = () => {
    if (iv) clearInterval(iv);
    iv = null;
    feed.stop();
  };
  const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
  if (document.visibilityState !== "hidden") start();
  document.addEventListener("visibilitychange", onVis);
  // 换机器：清掉上一台的数据马上重拉，不把 A 机器的借入单数算到 B 上
  let fp = machines.currentFp();
  const unMachines = machines.subscribe(() => {
    if (machines.currentFp() === fp) return;
    fp = machines.currentFp();
    shared = EMPTY_FEED;
    sharedSubs.forEach((f) => f());
    if (document.visibilityState !== "hidden") void feed.load();
  });
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    unMachines();
    stop();
    shared = EMPTY_FEED;
  };
}

function subscribeShared(cb: () => void): () => void {
  sharedSubs.add(cb);
  stopShared ??= startShared();
  return () => {
    sharedSubs.delete(cb);
    if (!sharedSubs.size && stopShared) {
      stopShared();
      stopShared = null;
    }
  };
}

/** enabled=false 不订阅（不发请求），给 EMPTY_FEED */
export function useSharedBorrowView(enabled = true): FeedState {
  return useSyncExternalStore(enabled ? subscribeShared : noSub, () => (enabled ? shared : EMPTY_FEED), () => EMPTY_FEED);
}
const noSub = () => () => {};
