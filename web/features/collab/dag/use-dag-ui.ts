"use client";
/**
 * 两张图的界面状态：中区标签、展开了哪些 feature（没动过就跟默认规则走，动过就按用户的）、哪些点开了「✓N」、正在看的对比、
 * 跳转要居中的 Focus 和闪一次的目标。标签状态放在中区组件外面，跳转才能切标签。
 * seq 单调递增：同一个节点再跳一次也会再居中、再闪。手动切标签清掉 Focus，免得画布重新挂载时又跳回旧的跳转目标。
 * view = 子 DAG 用分区列表还是画布（SUBDAG4）：本页会话内记住、换 feature 保留；listable 由 use-focus-pane.tsx 报，
 * 列表真的在显示时跳转只闪不动 compare / open（列表自己滚到那张卡，已完成的先展开），否则照画布的跳法。
 * 所以切到「图」时要补展开选中的 feature：不然列表里跨 feature 跳过来再切图，画布只剩折叠 shelf（tests/web-dom-subdag-focus-jump.test.ts）。
 * SUBDAG7：graph = 聚焦图（dag-focus-layout.ts），full = 完整画布（从聚焦图的两枚小片进）。完整画布的已完成按 donePages 分页：
 * 点开 ✓N = 第 1 页，列底「还有 N」= 下一页，收起 = 删掉页数；doneOpen 照旧（手机用）。图 / 完整画布下跳转：目标在聚焦图里就地居中，
 * 不在就切到完整画布，已完成目标的页数开到 donePageOf。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { Focus } from "../v4/canvas-view";
import { compareAfterJump, type Compare } from "./dag-diff";
import { defaultOpen, donePageOf, drawable, openWith } from "./dag-layout";
import { layoutFocus } from "./dag-focus-layout";
import { jumpToNode } from "./dag-progress";
import type { FeatureCard } from "./dag-types";

export type DagTab = "product" | "dag" | "progress" | "team";
export type DagView = "list" | "graph" | "full";

export function useDagUi(features: readonly FeatureCard[]) {
  const [tab, setTabRaw] = useState<DagTab>("product");
  const [featureId, setFeatureId] = useState<string | null>(null);
  const [manual, setManual] = useState<string[] | null>(null);
  const [doneOpen, setDoneOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [donePages, setDonePages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [compare, setCompare] = useState<Compare | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null);
  const [evicted, setEvicted] = useState<string | null>(null);
  const [view, setViewRaw] = useState<DagView>("list");
  const listable = useRef(false);
  const setListable = useCallback((on: boolean) => { listable.current = on; }, []);
  const counter = useRef(0);
  const open = useMemo(() => {
    const ids = new Set(drawable(features).map((f) => f.id));
    return (manual ?? defaultOpen(features)).filter((id) => ids.has(id));
  }, [manual, features]);

  const ensureOpen = (id: string) => {
    const o = openWith(open, id, features);
    setManual(o.open);
    setEvicted(o.evicted);
  };
  /** 点开 / 收起 ✓N：页数跟着设成 1 / 删掉 */
  const setDone = (id: string, on: boolean) => {
    setDoneOpen((s) => (s.has(id) === on ? s : on ? new Set([...s, id]) : new Set([...s].filter((x) => x !== id))));
    setDonePages((m) => {
      const n = new Map(m);
      if (on) n.set(id, Math.max(1, m.get(id) ?? 1)); else n.delete(id);
      return n;
    });
  };
  const setView = (v: DagView) => {
    setViewRaw(v);
    if (v !== "list" && featureId && !open.includes(featureId)) ensureOpen(featureId);
  };
  return {
    tab, featureId, open, doneOpen, donePages, compare, focus, flash, evicted, ensureOpen, view, setView,
    /** 聚焦图的小片进完整画布：「其余 N 已完成」带已完成第 1 页，「更远 N」已完成收起 */
    enterFull: (id: string, withDone: boolean) => {
      setView("full");
      setDone(id, withDone);
    },
    /** 完整画布列底「还有 N」：这个 feature 的已完成多翻一页 */
    moreDone: (id: string) => setDonePages((m) => new Map(m).set(id, (m.get(id) ?? 1) + 1)),
    /** 聚焦图画不出（没有进行中）时退回完整画布，已完成开到第 1 页（use-focus-pane.tsx 每个 feature 只调一次） */
    openDone: (id: string) => setDone(id, true),
    /** use-focus-pane.tsx 在 effect 里报告列表此刻能不能显示（桌面且有产品 DAG）；只给 jumpNode 读 */
    setListable,
    selectFeature: (id: string) => {
      setFeatureId(id); setManual([id]);
      setCompare(null); setFocus(null);
      setTabRaw("dag");
    },
    setTab: (t: DagTab) => {
      setTabRaw(t);
      setFocus(null);
    },
    toggleFeature: (id: string) => (open.includes(id) ? setManual(open.filter((x) => x !== id)) : ensureOpen(id)),
    toggleDone: (id: string) => setDone(id, !doneOpen.has(id)),
    setCompare: (c: Compare | null) => {
      setCompare(c);
      if (c && !open.includes(c.featureId)) ensureOpen(c.featureId);
    },
    /** 进度 → DAG：退出该 feature 的历史对比、切标签、展开所在 feature（守 MAX_OPEN）、必要时点开 ✓N、居中并闪一次 */
    jumpNode: (featureId: string, key: string) => {
      const j = jumpToNode(features, open, featureId, key);
      if (!j) return;
      const seq = ++counter.current;
      setFeatureId(featureId);
      setTabRaw("dag");
      setFlash({ id: j.id, seq });
      if (view === "list" && listable.current && compare?.featureId !== featureId) return;
      setCompare((c) => compareAfterJump(c, features, featureId));
      setManual([featureId]);
      setEvicted(j.evicted);
      const f = features.find((x) => x.id === featureId)!;
      const inFocus = view === "graph" && listable.current && layoutFocus(f)?.boxOf.get(j.id) === j.id;
      if (view === "graph" && listable.current && !inFocus) setViewRaw("full");
      if (j.expandDone && !inFocus) setDoneOpen((s) => new Set([...s, featureId]));
      if (j.expandDone && !inFocus && listable.current) setDonePages((m) => new Map(m).set(featureId, Math.max(m.get(featureId) ?? 0, donePageOf(f, key))));
      setFocus({ id: j.id, seq });
    },
    /** DAG → 进度：切标签、滚到那一行并闪一次 */
    jumpRow: (agent: string) => {
      setTabRaw("progress");
      setFlash({ id: `row:${agent}`, seq: ++counter.current });
    },
  };
}
