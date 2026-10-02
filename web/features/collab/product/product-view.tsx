'use client';
import { useMemo, useState } from 'react';
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { STAGE_NAME } from '../collab-detail-model';
import { Icon } from '../collab-icons';
import { edgePath } from '../v4/canvas-view';
import { usePort, useViewport } from '../v4/use-viewport';
import { ViewportTools } from '../v4/viewport-tools';
import v from '../v4/v4.module.css';
import d from '../dag/dag.module.css';
import { productEta, productLayout } from './product-layout';
import s from './product.module.css';

interface Props { board: ProductBoard; narrow: boolean; now: number; onFeature: (id: string) => void; tr: Tr; featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean }

function FeatureBody({ feature: f, now, tr, featureMeta, activeUnknown }: Pick<Props, "now" | "tr" | "featureMeta" | "activeUnknown"> & { feature: ProductFeature }) {
  const eta = productEta(f.eta?.at, now, tr('今天'));
  return <>
    <strong className={s.title} style={featureMeta ? { flexShrink: 0 } : undefined}>{f.title || f.id}</strong>
    {f.hasDag ? <>
      <span className={s.numbers}>{f.counts.completed} / {f.counts.total}{f.status === 'paused' && <span>{tr('已暂停')}</span>}</span>
      <span className={s.bar} role="progressbar" aria-label={f.title} aria-valuemin={0} aria-valuemax={f.counts.total || 1}
        aria-valuenow={f.counts.completed}><span style={{ width: `${Math.min(100, f.counts.total ? f.counts.completed / f.counts.total * 100 : 0)}%` }} /></span>
    </> : <span className={s.numbers}>{f.counts.total} {tr('卡')}</span>}
    <span className={s.stats}>{!activeUnknown && <span><Icon name="zap" size={12} />{f.counts.active} {tr('进行中')}</span>}
      <span>{f.counts.blocked ?? f.cards?.filter(c => c.stage === 'blocked').length ?? 0} {tr('受阻')}</span>{eta && <span className={s.eta}>{tr('预计')} {eta}</span>}</span>
    {featureMeta?.(f)}
  </>;
}

export function ProductView(p: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const canvas = useMemo(() => productLayout(p.board, doneOpen), [p.board, doneOpen]);
  const fold = canvas.done.length > 0 && <button type="button" className={s.done} aria-expanded={doneOpen}
    onClick={() => setDoneOpen(value => !value)}><Icon name="check" size={14} />{canvas.done.length} {p.tr('已完成')}</button>;
  if (p.narrow) return <div className={s.mobile}>{fold}{canvas.nodes.map(n =>
    <button key={n.id} type="button" className={s.card} style={p.featureMeta ? { gap: 6 } : undefined} onClick={() => p.onFeature(n.id)}>
      <FeatureBody feature={n.feature} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown} />
    </button>)}</div>;
  return <ProductCanvas {...p} canvas={canvas} foldControl={fold} />;
}

function ProductCanvas(p: Props & { canvas: ReturnType<typeof productLayout>; foldControl: React.ReactNode }) {
  const { box, port } = usePort();
  const vp = useViewport(p.canvas, port, null, () => {});
  return <div className={d.wrap}>
    {!p.canvas.fold && p.foldControl && <div className={s.shelf}>{p.foldControl}</div>}
    <div ref={box} className={v.canvas} {...vp.handlers}>
      <div className={`${v.world} ${vp.glide ? v.glide : ''}`}
        style={{ transform: `translate(${vp.view.x}px, ${vp.view.y}px) scale(${vp.view.k})` }}>
        <svg className={d.edges} width={p.canvas.w} height={p.canvas.h}>
          {p.canvas.edges.map(e => <path key={e.id} d={edgePath(e)} className={`${d.eLine} ${e.solid ? d.eSolid : d.eDotted}`}><title>{e.note}</title></path>)}
        </svg>
        {p.canvas.fold && <div className={`${s.node} ${s.foldNode}`}
          style={{ left: p.canvas.fold.x, top: p.canvas.fold.y, width: p.canvas.fold.w, height: p.canvas.fold.h }}>{p.foldControl}</div>}
        {p.canvas.nodes.map(n => <button key={n.id} type="button" className={`${s.card} ${s.node}`}
          style={{ left: n.x, top: n.y, width: n.w, height: n.h, ...(p.featureMeta ? { gap: 6 } : {}) }}
          onClick={() => p.onFeature(n.id)}>
          <FeatureBody feature={n.feature} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown} />
        </button>)}
      </div>
      <ViewportTools vp={vp} tr={p.tr} />
    </div>
  </div>;
}

export function FeatureTrail({ title, onBack, tr }: { title: string; onBack: () => void; tr: Tr }) {
  return <nav className={s.trail} aria-label={tr('返回产品 DAG')}>
    <button type="button" onClick={onBack}>{tr('产品 DAG')}</button><Icon name="chevronRight" size={14} /><strong>{title}</strong>
  </nav>;
}

export function FeatureCards({ feature, onTask, tr }: { feature: ProductFeature; onTask: (id: string) => void; tr: Tr }) {
  return <div className={s.mobile}><span className={s.empty}>{tr('还没有子 DAG')}</span>
    {(feature.cards ?? []).map(c => <button key={c.id} type="button" className={s.card} onClick={() => onTask(c.id)}>
      <strong className={s.title}>{c.title}</strong><span className={s.stats}>{c.id} · {tr(STAGE_NAME[c.stage as keyof typeof STAGE_NAME] ?? c.stage)}</span>
    </button>)}
  </div>;
}
