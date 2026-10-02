"use client";
/**
 * 子 DAG 两张图的数据（i28-L4 的三条读接口）。不另开事件流：useCollab 每重拉一次台账（rev 变）就跟着重拉快照，
 * 两张图永远用同一份快照。rev 0 是台账还没拉到（可能正显示缓存），这时不拉，免得一次打开拉两遍、两张图各拿一份。
 * 老 bridge 没有路由 = 404 → absent，中区回落到因果线画布；403 照入口的做法收起（collab-entry.tsx）。
 * 版本列表、对比只在点开时按需拉，跟着 rev 一起刷新。
 */
import { useEffect, useRef, useState } from "react";
import { assertDagSnapshot, dagRetryDelay } from "../product/dag-availability";
import { ApiError } from "@/lib/api/client";
import { fetchDagBoard, fetchDagDiff, fetchDagFeature } from "@/lib/api/ledger";
import { setLedgerAccess } from "../collab-cache";
import type { Compare } from "./dag-diff";
import type { BoardNode, DagBoard, DagDiffResponse, FeatureDetail } from "./dag-types";

export type DagLoad = { status: "loading" } | { status: "absent" } | { status: "forbidden" } | { status: "error"; message: string } | { status: "ok"; board: DagBoard };

export function useDagBoard(project: string, rev: number): DagLoad {
  const [load, setLoad] = useState<DagLoad>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const backoff = useRef(5_000);
  useEffect(() => { backoff.current = 5_000; }, [project, rev]);
  useEffect(() => {
    if (rev === 0) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetchDagBoard(project, ctrl.signal).then(board => { assertDagSnapshot(board); return board; }).then(
      (board) => { if (ctrl.signal.aborted) return; backoff.current = 5_000; setLoad({ status: "ok", board }); },
      (e: Error) => {
        if (ctrl.signal.aborted) return;
        timer = setTimeout(() => setRetry(n => n + 1), backoff.current);
        backoff.current = dagRetryDelay(backoff.current);
        if (e instanceof ApiError && e.status === 404) return setLoad({ status: "absent" });
        if (e instanceof ApiError && e.status === 403) {
          setLedgerAccess(project, "no");
          return setLoad({ status: "forbidden" });
        }
        setLoad({ status: "error", message: e.message });
      },
    );
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [project, rev, retry]);
  return load;
}

/** 某个 feature 的版本列表（属性区版本页）；featureId 为 null 不拉 */
export function useDagVersions(project: string, featureId: string | null, rev: number): FeatureDetail | null {
  const [got, setGot] = useState<{ id: string; d: FeatureDetail } | null>(null);
  useEffect(() => {
    if (!featureId) return;
    const ctrl = new AbortController();
    fetchDagFeature(project, featureId, undefined, ctrl.signal).then(
      (d) => setGot({ id: featureId, d }),
      (e: Error) => !ctrl.signal.aborted && console.warn(`[collab] 读 ${featureId} 的版本列表失败：${e.message}`), // 版本页显示加载中，下次 rev 变了再拉
    );
    return () => ctrl.abort();
  }, [project, featureId, rev]);
  return got && got.id === featureId ? got.d : null;
}

export interface CompareData {
  key: string;
  diff: DagDiffResponse;
  fromNodes: BoardNode[];
  /** to 是当前版时用快照里的节点（和另一张图同一时刻），否则是拉回来的那一版 */
  toNodes: BoardNode[];
}

const compareKey = (c: Compare) => `${c.featureId}:${c.from}:${c.to}`;

/** 对比要的三样：diff、from 版快照、to 版快照（to = 当前版时不拉，用 board 的节点）；拉齐之前是 null */
export function useDagCompare(project: string, c: Compare | null, board: DagBoard | null, rev: number): CompareData | null {
  const [got, setGot] = useState<CompareData | null>(null);
  const cur = c ? board?.features.find((f) => f.id === c.featureId) : undefined;
  const live = c && cur && c.to === cur.currentVersion ? cur.nodes : null;
  const fid = c?.featureId ?? null, from = c?.from ?? 0, to = c?.to ?? 0, needTo = !live;
  useEffect(() => {
    if (!fid) return;
    const ctrl = new AbortController();
    const key = compareKey({ featureId: fid, from, to });
    const snap = (v: number | "pending") => fetchDagFeature(project, fid, v, ctrl.signal).then((d) => d.snapshot?.nodes ?? []);
    Promise.all([fetchDagDiff(project, fid, from, to, ctrl.signal), snap(from), needTo ? snap(to) : Promise.resolve(null)]).then(
      ([diff, fromNodes, toNodes]) => setGot({ key, diff, fromNodes, toNodes: toNodes ?? [] }),
      (e: Error) => !ctrl.signal.aborted && console.warn(`[collab] 读 ${key} 的对比失败：${e.message}`), // 叠图先不出，下次 rev 变了再拉
    );
    return () => ctrl.abort();
  }, [project, fid, from, to, needTo, rev]);
  if (!c || !got || got.key !== compareKey(c)) return null;
  return live ? { ...got, toNodes: live } : got;
}
