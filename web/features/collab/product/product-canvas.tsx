'use client';
/**
 * 项目地图的桌面画布：工具条 + 平移缩放的世界层（视口照用 v4 的 usePort / useViewport / ViewportTools）。
 * 世界层里画区头、泳道框、边、卡、链上和底部的小标签。小标签照旧单击进子 DAG。
 * PDFOCUS1：单击卡 = 选中（上下游亮、其余变暗、右侧模块页），双击 / 已选中再按 Enter / 页里「看模块进度」= onFeature 进子 DAG；
 * Esc、点空白、再点同一张卡取消。过滤和关键路径的变暗规则在 product-focus.ts 的 highlight。
 */
import { useMemo, useState } from 'react';
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import type { Focus } from '../v4/canvas-view';
import { usePort, useViewport } from '../v4/use-viewport';
import { ViewportTools } from '../v4/viewport-tools';
import v from '../v4/v4.module.css';
import d from '../dag/dag.module.css';
import { productLayout, type ProductChip, type ProductNode, type ProductZone } from './product-layout';
import { ProductCard, ProductChipContent } from './product-card';
import { ProductEdgeLegend, ProductEdges } from './product-edges';
import { ProductSide, type ProductPick } from './product-side';
import { ProductToolbar, useMapPrefs } from './product-toolbar';
import { cpText, pdText } from './product-i18n';
import { criticalPath, cpSpan, highlight, type Highlight } from './product-focus';
import fx from './product-focus.module.css';
import m from './product-map.module.css';
import { PRODUCT_MIN_K, productInitialView, singlesOffRight, zoomTier } from './product-zoom';
import z from './product-zoom.module.css';

export interface CanvasProps {
  board: ProductBoard; now: number; onFeature: (id: string) => void; onTask?: (id: string) => void; tr: Tr; project?: string;
  featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean;
}

const TAG = { done: null, paused: '已暂停', frozen: '冻结' } as const;

function Chip({ id, feature, tag, box, onFeature, tr, hl }: { id: string; feature: ProductFeature; tag: keyof typeof TAG; box: { x: number; y: number; w: number; h: number };
  onFeature: (id: string) => void; tr: Tr; hl: Highlight }) {
  const cls = `${fx.fade} ${hl.dim.has(id) ? fx.dim : ''} ${hl.selected.has(id) ? fx.chipSelected : ''}`;
  return <button type="button" className={`${m.chip} ${tag === 'done' ? m.chipDone : m.chipPaused} ${cls}`} data-pd-chip={id} data-pd-dim={hl.dim.has(id) || undefined}
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
  const [focus, setFocus] = useState<Focus | null>(null);
  const [cpOn, setCpOn] = useState(false);
  const canvas = useMemo(() => productLayout(p.board, { mode: prefs.mode, doneOpen: prefs.doneOpen, pausedOpen, laneDone }),
    [p.board, prefs.mode, prefs.doneOpen, pausedOpen, laneDone]);
  const cp = useMemo(() => criticalPath(p.board, canvas), [p.board, canvas]);
  const cpLive = cpOn && cp.ids.length ? cp : null;
  const hl = highlight(canvas, { pick, filter: prefs.filter, summary: canvas.summary, cp: cpLive });
  const cpTag = cpLive ? cpText(p.tr, '关键路径', cpSpan(cpLive.hours)) : undefined;
  const toggleLane = (key: string) => setLaneDone(ks => (ks.includes(key) ? ks.filter(k => k !== key) : [...ks, key]));
  const toggleCard = (id: string) => setPick(cur => (cur?.kind === 'feature' && cur.id === id ? null : { kind: 'feature', id }));
  const pickFeature = (id: string) => { setPick({ kind: 'feature', id }); setFocus(f => ({ id, seq: (f?.seq ?? 0) + 1 })); };
  const card = (n: ProductNode) => <ProductCard key={n.id} node={n} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown}
    onFeature={p.onFeature} onTask={p.onTask} onPick={toggleCard} selected={hl.selected.has(n.id)} picked={hl.picked === n.id} dim={hl.dim.has(n.id)}
    cp={cpLive?.ids.includes(n.id) ? cpTag : undefined} />;
  const chip = (c: ProductNode | ProductChip, tag: keyof typeof TAG) => <Chip key={c.id} id={c.id} feature={c.feature} tag={tag} box={c} onFeature={p.onFeature} tr={p.tr} hl={hl} />;
  return <div className={d.wrap}>
    <ProductToolbar mode={canvas.mode} lanesOk={canvas.lanesOk} onMode={m => { setFocus(null); prefs.setMode(m); }} done={canvas.done.length} doneOpen={prefs.doneOpen}
      onDone={() => prefs.setDoneOpen(!prefs.doneOpen)} paused={canvas.paused.length} pausedOpen={pausedOpen} onPaused={() => setPausedOpen(o => !o)}
      summary={canvas.summary} tr={p.tr} filter={prefs.filter} onFilter={prefs.setFilter}
      cp={{ on: cpOn, ok: cp.ids.length > 0, onToggle: () => setCpOn(o => !o) }} />
    {/* 模式换了就重建视口：新布局有独立的初始摆放；数据刷新仍保留用户平移缩放。 */}
    <ProductViewport key={canvas.mode} canvas={canvas} tr={p.tr} onLane={toggleLane} onPick={setPick} pick={pick} focus={focus} hl={hl}
      onBackground={() => setPick(null)}>
      {canvas.nodes.map(n => (n.chip ? chip(n, 'done') : card(n)))}
      {canvas.chips.map(c => chip(c, c.tag))}
    </ProductViewport>
    <ProductSide pick={pick} board={p.board} onClose={() => setPick(null)} onFeature={p.onFeature} onTask={p.onTask} now={p.now} tr={p.tr}
      layout={canvas} cp={cpLive} onPickFeature={pickFeature} />
  </div>;
}

function ProductViewport({ canvas, tr, onLane, onPick, pick, focus, hl, onBackground, children }: {
  canvas: ReturnType<typeof productLayout>; tr: Tr; onLane: (key: string) => void; onPick: (p: ProductPick) => void; pick: ProductPick | null;
  focus: Focus | null; hl: Highlight; onBackground: () => void; children: React.ReactNode;
}) {
  const { box, port } = usePort();
  const vp = useViewport(canvas, port, focus, onBackground, { minK: PRODUCT_MIN_K, initial: productInitialView(canvas, canvas.mode) });
  const n = singlesOffRight(canvas, vp.view, port.w);
  return <div ref={box} className={`${v.canvas} ${z.viewport}`} {...vp.handlers}>
    <div className={`${v.world} ${z.world} ${vp.glide ? v.glide : ''}`} data-pd-mode={canvas.mode} data-zoom={zoomTier(vp.view.k)}
      style={{ transform: `translate(${vp.view.x}px, ${vp.view.y}px) scale(${vp.view.k})`, '--pd-k': vp.view.k } as React.CSSProperties}>
      {canvas.zones.map(zone => <Zone key={zone.id} z={zone} tr={tr} onLane={onLane} />)}
      <ProductEdges canvas={canvas} onPick={onPick} pick={pick} tr={tr} dim={hl.dimEdges} strong={hl.strong} />
      {children}
    </div>
    <ProductEdgeLegend canvas={canvas} tr={tr} />
    <ViewportTools vp={vp} tr={tr} right={canvas.mode === 'dep' && n > 0 ? { n, text: '还有 {n} 个独立推进' } : undefined} />
  </div>;
}
