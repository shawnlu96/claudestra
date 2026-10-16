'use client';
/** 画布右侧浮页：选中有效边时是边页，选中卡时是模块页（PDFOCUS1，同一个浮层外壳）。Esc 关闭并取消选中。 */
import { useEffect, useRef } from 'react';
import type { ProductBoard } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { productGraph } from './product-graph';
import { ProductEdgePage } from './product-edge-page';
import { ProductFeaturePage } from './product-feature-page';
import type { CriticalPath, ProductPick } from './product-focus';
import type { ProductCanvas } from './product-layout';
import s from './product-edges.module.css';

export type { ProductPick } from './product-focus';
export interface ProductSideProps {
  pick: ProductPick | null;
  board: ProductBoard;
  onClose: () => void;
  onFeature: (id: string) => void;
  onTask?: (id: string) => void;
  now: number;
  tr: Tr;
  /** 模块页要用：当前布局、关键路径（关着时 null）、在页里点上下游的一行 */
  layout?: Pick<ProductCanvas, 'nodes' | 'edges'>;
  cp?: CriticalPath | null;
  onPickFeature?: (id: string) => void;
}

export function ProductSide(p: ProductSideProps): React.ReactNode {
  const edge = p.pick?.kind === 'edge' ? productGraph(p.board).edges.find(e => e.id === p.pick!.id) : undefined;
  const node = p.pick?.kind === 'feature' ? p.layout?.nodes.find(n => n.id === p.pick!.id) : undefined;
  const edgeId = edge?.id, open = !!(edge || node), onClose = p.onClose;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  // 只有边页抢焦点：模块页要让焦点留在卡上，第二次 Enter 才能进模块
  useEffect(() => {
    if (!edgeId) return;
    const previous = document.activeElement;
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [edgeId]);
  if (edge) {
    return <div ref={ref} className={s.side} data-pd-side={edge.id}>
      <ProductEdgePage edge={edge} board={p.board} onClose={p.onClose} onTask={p.onTask} now={p.now} tr={p.tr} />
    </div>;
  }
  if (!node || !p.layout) return null;
  return <div className={s.side} data-pd-side={node.id} data-pd-side-kind="feature">
    <ProductFeaturePage node={node} layout={p.layout} board={p.board} cp={p.cp ?? null} onClose={p.onClose} onPick={id => p.onPickFeature?.(id)}
      onFeature={p.onFeature} onTask={p.onTask} now={p.now} tr={p.tr} />
  </div>;
}
