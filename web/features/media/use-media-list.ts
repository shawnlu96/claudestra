"use client";
import { useCallback, useEffect, useState } from "react";
import { listMedia, type MediaItem, type MediaQuery } from "@/lib/api/media";
import { appendOlder } from "./media-logic";

const PAGE = 60;

interface Result {
  key: string;
  items: MediaItem[];
  older: string | null;
  total: number;
  building: boolean;
  error?: boolean;
}

/**
 * 媒体列表的加载：一组筛选 = 一个 key，结果带着 key 回来，对不上的就是还在加载（不在 effect 里同步 setState）。
 * 滚到底的哨兵往更早翻页；索引首建没完成（building）就过几秒自动再拉一次，已有的先显示。
 * query 由 key 完整描述——since 按范围名记进 key，免得每次渲染的毫秒差触发重拉。
 */
export function useMediaList(query: MediaQuery, filterKey: string) {
  const [retry, setRetry] = useState(0);
  const key = `${filterKey}#${retry}`;
  const [res, setRes] = useState<Result | null>(null);
  const [paging, setPaging] = useState(false);
  const fresh = res?.key === key;
  const building = fresh && res.building;

  useEffect(() => {
    const ctl = new AbortController();
    listMedia(query, { limit: PAGE }, ctl.signal)
      .then((p) => setRes({ key, items: p.items, older: p.older, total: p.total, building: !!p.building }))
      .catch(() => !ctl.signal.aborted && setRes({ key, items: [], older: null, total: 0, building: false, error: true }));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!building) return;
    const id = setTimeout(() => setRetry((n) => n + 1), 4000);
    return () => clearTimeout(id);
  }, [building]);

  const loadOlder = useCallback(async () => {
    if (!res || !fresh || !res.older || paging) return;
    setPaging(true);
    try {
      const p = await listMedia(query, { before: res.older, limit: PAGE });
      setRes((cur) => (cur && cur.key === key ? { ...cur, items: appendOlder(cur.items, p.items), older: p.older } : cur));
    } catch {
      /* 翻页失败：哨兵还在，下次滚到底再试 */
    } finally {
      setPaging(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, fresh, paging, key]);

  // 回调 ref：哨兵挂上 / 换掉时重新观察
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void loadOlder(), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel, loadOlder]);

  return {
    items: res && !res.error ? res.items : null,
    total: res?.total ?? 0,
    fresh,
    error: fresh && !!res.error,
    building,
    loading: !fresh || paging,
    retry: () => setRetry((n) => n + 1),
    endMarker: setSentinel,
  };
}
