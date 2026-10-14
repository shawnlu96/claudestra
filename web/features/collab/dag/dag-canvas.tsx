"use client";
/**
 * 子 DAG 图（桌面中区第一个标签）：布局全在 dag-layout.ts，这里只画。上方一条是收起的 feature（每个一枚小片，done / active / idle 计数），
 * 下面是画布：分组框（框头 = 标题 + 版本条 + ✓N 开关 + 收起）、底层 SVG 的依赖线、节点卡。视口沿用 v4 的 use-viewport.ts
 * （拖动平移、滚轮缩放、明确跳转才居中、刷新不动视口）。
 */
import { useCollabT } from "../collab-i18n";
import type { Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import { edgePath, type Focus } from "../v4/canvas-view";
import { usePort, useViewport } from "../v4/use-viewport";
import { ViewportTools } from "../v4/viewport-tools";
import v from "../v4/v4.module.css";
import type { Compare } from "./dag-diff";
import type { DagCanvas, DGroup, DNode, FoldKind } from "./dag-layout";
import { focusT } from "./focus-i18n";
import { NodeBody, nodeClass, type NodeLook } from "./dag-node";
import type { FeatureCard } from "./dag-types";
import d from "./dag.module.css";
import { featureWords } from "../count-words";
import { countText } from "../count-words-i18n";
import { useCountContext } from "../use-count-source";

export type Look = (n: DNode) => Omit<NodeLook, "node" | "kind" | "mark">;

export interface DagCanvasProps {
  canvas: DagCanvas;
  /** 收起着的 feature（有图的） */
  shelf: readonly FeatureCard[];
  /** 刚因为展开第 MAX_OPEN+1 个被挤下来的那个：小片带入场动画 */
  evicted: string | null;
  look: Look;
  compare: Compare | null;
  focus: Focus | null;
  onNode: (featureId: string, key: string) => void;
  onOwner: (agent: string) => void;
  /** kind：点的是哪种小片（dag-layout.ts DFold.kind）；框头「✓N 收起」和框角 ✓N 不带 */
  onFold: (featureId: string, kind?: FoldKind) => void;
  onFeature: (featureId: string) => void;
  onVersions: (featureId: string) => void;
  onBackground: () => void;
  tr: Tr;
}

/**
 * 框头的状态词（UXNUM1）：「在干活 a · 在等 b · 没开工 c」写字，数从 CountContext（count-words.ts，和顶栏同一份看板）；
 * 没载完是骨架。没有 context（老调用方 / 单测直接挂）返回 null，由调用方退回 feature 自带的计数
 */
export function FeatureWordsLine({ featureId }: { featureId: string }) {
  const tr = useCollabT();
  const counts = useCountContext();
  if (!counts || counts.status === "none") return null;
  const w = counts.status === "ready" ? featureWords(counts.snap, featureId) : null;
  const n = (x: number | undefined) => (x === undefined ? <span className={v.skel} aria-hidden /> : x);
  return (
    <span className={d.words} data-feature-words={featureId}>
      {countText(tr, "在干活")} {n(w?.working)} · {countText(tr, "在等")} {n(w?.waiting)} · {countText(tr, "没开工")} {n(w?.notStarted)}
    </span>
  );
}

/** 框头 / 小片的完成数：全站计数没载完时同样是骨架（和状态词一起出数）；没有 context 照旧直接出 */
function DoneNum({ f }: { f: FeatureCard }) {
  return useCountContext()?.status === "loading" ? <span className={v.skel} aria-hidden /> : <>{f.counts.done}</>;
}

/** activeUnknown：active / idle 显示「暂无」而不是占位的 0（桌面 Shelf 与手机列表共用）；done 照常是已知数。有计数 context 时 active / idle 换成写字的状态词 */
export function Counts({ f }: { f: FeatureCard }) {
  const tr = useCollabT();
  const counts = useCountContext();
  if (counts && counts.status !== "none") {
    return <><span className={`${d.cnum} ${d.ok}`}><Icon name="check" size={11} /><DoneNum f={f} /></span><FeatureWordsLine featureId={f.id} /></>;
  }
  const unknown = f.counts.activeUnknown === true;
  return (
    <>
      <span className={`${d.cnum} ${d.ok}`}><Icon name="check" size={11} />{f.counts.done}</span>
      <span className={`${d.cnum} ${d.run}`}><Icon name="zap" size={11} />{unknown ? tr("暂无") : f.counts.active}</span>
      <span className={d.cnum}><Icon name="clock" size={11} />{unknown ? tr("暂无") : f.counts.idle}</span>
    </>
  );
}

export function Shelf({ shelf, evicted, onFeature }: Pick<DagCanvasProps, "shelf" | "evicted" | "onFeature">) {
  if (!shelf.length) return null;
  return (
    <div className={d.shelf}>
      {shelf.map((f) => (
        <button key={f.id} type="button" className={`${d.chip} ${f.id === evicted ? d.chipIn : ""}`} title={f.title} onClick={() => onFeature(f.id)}>
          <span>{f.title || f.id}</span>
          <Counts f={f} />
        </button>
      ))}
    </div>
  );
}

function VersionBar({ g, compare, onVersions, tr }: { g: DGroup; compare: Compare | null; onVersions: (id: string) => void; tr: Tr }) {
  const f = g.feature;
  const on = compare?.featureId === f.id;
  const label = on ? `v${compare.from} → ${compare.to === "pending" ? tr("待批") : `v${compare.to}`}` : `v${f.currentVersion}`;
  return (
    <button type="button" className={`${d.vbtn} ${on ? d.vbtnOn : ""}`} onClick={() => onVersions(f.id)} aria-label={tr("版本")}>
      {on && <Icon name="gitCompare" size={11} />}
      {label}
      {f.pending && <span className={d.pend} title={tr("待批")} />}
    </button>
  );
}

function GroupFrame({ g, p }: { g: DGroup; p: DagCanvasProps }) {
  const f = g.feature;
  const doneShown = !g.focus && f.counts.done > 0 && !g.folds.some((x) => !x.kind) && p.compare?.featureId !== f.id;
  return (
    <div className={d.group} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
      <div className={d.gh}>
        <span className={d.gt} title={f.title}>{f.title || f.id}</span>
        <VersionBar g={g} compare={p.compare} onVersions={p.onVersions} tr={p.tr} />
        <FeatureWordsLine featureId={f.id} />
        <span className={d.gsp} />
        {doneShown && <button type="button" className={d.doneBtn} onClick={() => p.onFold(f.id)}><Icon name="check" size={11} /><DoneNum f={f} /><Icon name="chevronUp" size={11} /></button>}
        <button type="button" className={d.gbtn} aria-label={p.tr("收起")} onClick={() => p.onFeature(f.id)}><Icon name="chevronUp" size={14} /></button>
      </div>
    </div>
  );
}

/** 小片的字（focus-i18n.ts 的词）：框角 ✓N 只有数，读屏念「N 个已完成」 */
const FOLD_WORD: Record<FoldKind, string> = { rest: "其余 {n} 已完成", far: "更远 {n}", more: "还有 {n} 个已完成" };

export function DagCanvasView(p: DagCanvasProps) {
  const { canvas, tr } = p;
  const { box, port } = usePort();
  const vp = useViewport(canvas, port, p.focus, p.onBackground);
  const { view, glide, handlers } = vp;
  const nodes = canvas.groups.flatMap((g) => g.nodes);
  const ft = focusT(tr);
  return (
    <div className={d.wrap}>
      <Shelf shelf={p.shelf} evicted={p.evicted} onFeature={p.onFeature} />
      <div ref={box} className={v.canvas} {...handlers}>
        <div className={`${v.world} ${glide ? v.glide : ""}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {canvas.groups.map((g) => <GroupFrame key={g.id} g={g} p={p} />)}
          <svg className={d.edges} width={canvas.w} height={canvas.h}>
            {canvas.edges.map((e) => <path key={e.id} d={edgePath(e)} className={`${d.eLine} ${e.solid ? d.eSolid : d.eDotted}`} />)}
          </svg>
          {nodes.map((n) => {
            const l = p.look(n);
            return (
              <div key={`${n.id}#${l.flash ?? 0}`} className={`${nodeClass({ ...l, node: n.node, kind: n.kind, mark: n.mark })} ${l.flash ? d.flash : ""}`}
                style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
                <NodeBody {...l} node={n.node} kind={n.kind} mark={n.mark} onPick={() => p.onNode(n.featureId, n.key)} onOwner={p.onOwner} tr={tr} />
              </div>
            );
          })}
          {canvas.groups.flatMap((g) => g.folds).map((f) => (
            <button key={f.id} type="button" className={d.fold} style={{ left: f.x, top: f.y, width: f.w, height: f.h }} onClick={() => p.onFold(f.featureId, f.kind)}
              aria-label={f.kind ? undefined : ft("{n} 个已完成", { n: f.n })} data-fold={f.kind ?? "done"}>
              {f.kind !== "far" && <Icon name="check" size={12} />}{f.kind ? ft(FOLD_WORD[f.kind], { n: f.n }) : f.n}
            </button>
          ))}
        </div>
        <ViewportTools vp={vp} tr={tr} />
        {canvas.groups.length === 0 && <div className={v.blank}>{tr("没有展开的 feature")}</div>}
      </div>
    </div>
  );
}
