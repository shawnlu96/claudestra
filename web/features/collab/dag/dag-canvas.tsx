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
import type { DagCanvas, DGroup, DNode } from "./dag-layout";
import { NodeBody, nodeClass, type NodeLook } from "./dag-node";
import type { FeatureCard } from "./dag-types";
import d from "./dag.module.css";

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
  onFold: (featureId: string) => void;
  onFeature: (featureId: string) => void;
  onVersions: (featureId: string) => void;
  onBackground: () => void;
  tr: Tr;
}

/** activeUnknown：active / idle 显示「暂无」而不是占位的 0（桌面 Shelf 与手机列表共用）；done 照常是已知数 */
export function Counts({ f }: { f: FeatureCard }) {
  const tr = useCollabT();
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
  const doneShown = f.counts.done > 0 && g.folds.length === 0 && p.compare?.featureId !== f.id;
  return (
    <div className={d.group} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
      <div className={d.gh}>
        <span className={d.gt} title={f.title}>{f.title || f.id}</span>
        <VersionBar g={g} compare={p.compare} onVersions={p.onVersions} tr={p.tr} />
        <span className={d.gsp} />
        {doneShown && <button type="button" className={d.doneBtn} onClick={() => p.onFold(f.id)}><Icon name="check" size={11} />{f.counts.done}<Icon name="chevronUp" size={11} /></button>}
        <button type="button" className={d.gbtn} aria-label={p.tr("收起")} onClick={() => p.onFeature(f.id)}><Icon name="chevronUp" size={14} /></button>
      </div>
    </div>
  );
}

export function DagCanvasView(p: DagCanvasProps) {
  const { canvas, tr } = p;
  const { box, port } = usePort();
  const vp = useViewport(canvas, port, p.focus, p.onBackground);
  const { view, glide, handlers } = vp;
  const nodes = canvas.groups.flatMap((g) => g.nodes);
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
            <button key={f.id} type="button" className={d.fold} style={{ left: f.x, top: f.y, width: f.w, height: f.h }} onClick={() => p.onFold(f.featureId)}>
              <Icon name="check" size={12} />{f.n}
            </button>
          ))}
        </div>
        <ViewportTools vp={vp} tr={tr} />
        {canvas.groups.length === 0 && <div className={v.blank}>{tr("没有展开的 feature")}</div>}
      </div>
    </div>
  );
}
