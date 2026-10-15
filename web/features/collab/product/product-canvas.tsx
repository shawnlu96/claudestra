'use client';
/**
 * 项目地图的桌面画布：工具条 + 平移缩放的世界层（视口照用 v4 的 usePort / useViewport / ViewportTools）。
 * 世界层里画区头、泳道框、边、卡、链上和底部的小标签。点卡 / 小标签仍是 onFeature 进子 DAG；pick 状态在这里，本卡没有地方触发它。
 */
import { useMemo, useState } from 'react';
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { usePort, useViewport } from '../v4/use-viewport';
import { ViewportTools } from '../v4/viewport-tools';
import v from '../v4/v4.module.css';
import d from '../dag/dag.module.css';
import { productLayout, type ProductChip, type ProductNode, type ProductZone } from './product-layout';
import { ProductCard, ProductChipContent } from './product-card';
import { ProductEdgeLegend, ProductEdges } from './product-edges';
import { ProductSide, type ProductPick } from './product-side';
import { ProductToolbar, useMapPrefs } from './product-toolbar';
import { pdText } from './product-i18n';
import m from './product-map.module.css';
import { PRODUCT_MIN_K, productInitialView, singlesOffRight, zoomTier } from './product-zoom';
import z from './product-zoom.module.css';

export interface CanvasProps {
  board: ProductBoard; now: number; onFeature: (id: string) => void; onTask?: (id: string) => void; tr: Tr; project?: string;
  featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean;
}

const TAG = { done: null, paused: '已暂停', frozen: '冻结' } as const;

function Chip({ id, feature, tag, box, onFeature, tr }: { id: string; feature: ProductFeature; tag: keyof typeof TAG; box: { x: number; y: number; w: number; h: number };
  onFeature: (id: string) => void; tr: Tr }) {
  return <button type="button" className={`${m.chip} ${tag === 'done' ? m.chipDone : m.chipPaused}`} data-pd-chip={id}
    style={{ left: box.x, top: box.y, width: box.w, height: box.h }} title={feature.title} onClick={() => onFeature(feature.id)}>
    <ProductChipContent feature={feature} label={TAG[tag]} tr={tr} />
  </button>;
}

function Zone({ z, tr, onLane }: { z: ProductZone; tr: Tr; onLane: (key: string) => void }) {
  const words = [...(z.label !== null ? [z.label] : []), ...z.words.map(w => pdText(tr, w.w, w.n === undefined ? undefined : { n: w.n }))].join(' · ');
  if (z.kind !== 'lane') {
    return <div className={z.kind === 'row' ? m.rowLabel : m.zoneHead} data-pd-zone={z.kind} style={{ left: z.x, top: z.y, width: z.w, height: z.h }}>{words}</div>;
  }
  const lane = z.lane!;
  return <div className={m.lane} data-pd-zone="lane" style={{ left: z.x, top: z.y, width: z.w, height: z.h }}>
    <div className={m.laneHead} data-pd-lane-head>
      <span>{words}</span><span aria-hidden>·</span>
      {lane.done > 0 ? <button type="button" className={m.laneDone} aria-expanded={lane.open} onClick={() => onLane(lane.key)}>✓ {lane.done}</button>
        : <span>✓ 0</span>}
    </div>
  </div>;
}

export function ProductCanvas(p: CanvasProps) {
  const prefs = useMapPrefs(p.project);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [laneDone, setLaneDone] = useState<string[]>([]);
  const [pick, setPick] = useState<ProductPick | null>(null);
  const canvas = useMemo(() => productLayout(p.board, { mode: prefs.mode, doneOpen: prefs.doneOpen, pausedOpen, laneDone }),
    [p.board, prefs.mode, prefs.doneOpen, pausedOpen, laneDone]);
  const toggleLane = (key: string) => setLaneDone(ks => (ks.includes(key) ? ks.filter(k => k !== key) : [...ks, key]));
  const card = (n: ProductNode) => <ProductCard key={n.id} node={n} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown}
    onFeature={p.onFeature} onTask={p.onTask} />;
  const chip = (c: ProductNode | ProductChip, tag: keyof typeof TAG) => <Chip key={c.id} id={c.id} feature={c.feature} tag={tag} box={c} onFeature={p.onFeature} tr={p.tr} />;
  return <div className={d.wrap}>
    <ProductToolbar mode={canvas.mode} lanesOk={canvas.lanesOk} onMode={prefs.setMode} done={canvas.done.length} doneOpen={prefs.doneOpen}
      onDone={() => prefs.setDoneOpen(!prefs.doneOpen)} paused={canvas.paused.length} pausedOpen={pausedOpen} onPaused={() => setPausedOpen(o => !o)}
      summary={canvas.summary} tr={p.tr} />
    {/* 模式换了就重建视口：新布局有独立的初始摆放；数据刷新仍保留用户平移缩放。 */}
    <ProductViewport key={canvas.mode} canvas={canvas} tr={p.tr} onLane={toggleLane} onPick={setPick} pick={pick}>
      {canvas.nodes.map(n => (n.chip ? chip(n, 'done') : card(n)))}
      {canvas.chips.map(c => chip(c, c.tag))}
    </ProductViewport>
    <ProductSide pick={pick} board={p.board} onClose={() => setPick(null)} onFeature={p.onFeature} onTask={p.onTask} now={p.now} tr={p.tr} />
  </div>;
}

function ProductViewport({ canvas, tr, onLane, onPick, pick, children }: {
  canvas: ReturnType<typeof productLayout>; tr: Tr; onLane: (key: string) => void; onPick: (p: ProductPick) => void; pick: ProductPick | null; children: React.ReactNode;
}) {
  const { box, port } = usePort();
  const vp = useViewport(canvas, port, null, () => {}, { minK: PRODUCT_MIN_K, initial: productInitialView(canvas, canvas.mode) });
  const n = singlesOffRight(canvas, vp.view, port.w);
  return <div ref={box} className={`${v.canvas} ${z.viewport}`} {...vp.handlers}>
    <div className={`${v.world} ${z.world} ${vp.glide ? v.glide : ''}`} data-pd-mode={canvas.mode} data-zoom={zoomTier(vp.view.k)}
      style={{ transform: `translate(${vp.view.x}px, ${vp.view.y}px) scale(${vp.view.k})`, '--pd-k': vp.view.k } as React.CSSProperties}>
      {canvas.zones.map(zone => <Zone key={zone.id} z={zone} tr={tr} onLane={onLane} />)}
      <ProductEdges canvas={canvas} onPick={onPick} pick={pick} tr={tr} />
      {children}
    </div>
    <ProductEdgeLegend canvas={canvas} tr={tr} />
    <ViewportTools vp={vp} tr={tr} right={canvas.mode === 'dep' && n > 0 ? { n, text: '还有 {n} 个独立推进' } : undefined} />
  </div>;
}
