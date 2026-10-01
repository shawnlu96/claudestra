"use client";
/**
 * 两张图的界面状态：中区标签、展开了哪些 feature（没动过就跟默认规则走，动过就按用户的）、哪些点开了「✓N」、正在看的对比、
 * 跳转要居中的 Focus 和闪一次的目标。标签状态放在中区组件外面，跳转才能切标签。
 * seq 单调递增：同一个节点再跳一次也会再居中、再闪。手动切标签清掉 Focus，免得画布重新挂载时又跳回旧的跳转目标。
 */
import { useMemo, useRef, useState } from "react";
import type { Focus } from "../v4/canvas-view";
import { compareAfterJump, type Compare } from "./dag-diff";
import { defaultOpen, drawable, openWith } from "./dag-layout";
import { jumpToNode } from "./dag-progress";
import type { FeatureCard } from "./dag-types";

export type DagTab = "dag" | "progress" | "team";

export function useDagUi(features: readonly FeatureCard[]) {
  const [tab, setTabRaw] = useState<DagTab>("dag");
  const [manual, setManual] = useState<string[] | null>(null);
  const [doneOpen, setDoneOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [compare, setCompare] = useState<Compare | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null);
  const [evicted, setEvicted] = useState<string | null>(null);
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
  return {
    tab, open, doneOpen, compare, focus, flash, evicted, ensureOpen,
    setTab: (t: DagTab) => {
      setTabRaw(t);
      setFocus(null);
    },
    toggleFeature: (id: string) => (open.includes(id) ? setManual(open.filter((x) => x !== id)) : ensureOpen(id)),
    toggleDone: (id: string) => setDoneOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    }),
    setCompare: (c: Compare | null) => {
      setCompare(c);
      if (c && !open.includes(c.featureId)) ensureOpen(c.featureId);
    },
    /** 进度 → DAG：退出该 feature 的历史对比、切标签、展开所在 feature（守 MAX_OPEN）、必要时点开 ✓N、居中并闪一次 */
    jumpNode: (featureId: string, key: string) => {
      const j = jumpToNode(features, open, featureId, key);
      if (!j) return;
      const seq = ++counter.current;
      setCompare((c) => compareAfterJump(c, features, featureId));
      setManual(j.open);
      setEvicted(j.evicted);
      if (j.expandDone) setDoneOpen((s) => new Set([...s, featureId]));
      setTabRaw("dag");
      setFocus({ id: j.id, seq });
      setFlash({ id: j.id, seq });
    },
    /** DAG → 进度：切标签、滚到那一行并闪一次 */
    jumpRow: (agent: string) => {
      setTabRaw("progress");
      setFlash({ id: `row:${agent}`, seq: ++counter.current });
    },
  };
}
