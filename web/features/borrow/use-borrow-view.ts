"use client";
/**
 * GET /borrow 的轮询 hook（从 borrow-panel.tsx 原样搬出，XMACH1）：设置 · 伙伴机器页的借入面板与「今天 · 团队与额度」的借入行共用。
 * 挂着时每 15 秒拉一次，页面切到后台就停；403 / 404 → hidden。
 */
import { useEffect, useState } from "react";
import { POLL_MS } from "./borrow-model";
import { borrowFeed, EMPTY_FEED, type FeedState } from "./borrow-feed";

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
