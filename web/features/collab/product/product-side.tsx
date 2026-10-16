'use client';
/** 画布右侧浮页：只在选中有效边时打开；feature 页由 PDFOCUS1 接入。 */
import { useEffect, useRef } from 'react';
import type { ProductBoard } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { productGraph } from './product-graph';
import { ProductEdgePage } from './product-edge-page';
import s from './product-edges.module.css';

export type ProductPick = { kind: 'feature' | 'edge'; id: string };
export interface ProductSideProps {
  pick: ProductPick | null;
  board: ProductBoard;
  onClose: () => void;
  onFeature: (id: string) => void;
  onTask?: (id: string) => void;
  now: number;
  tr: Tr;
}

export function ProductSide(p: ProductSideProps): React.ReactNode {
  const edge = p.pick?.kind === 'edge' ? productGraph(p.board).edges.find(e => e.id === p.pick!.id) : undefined;
  const edgeId = edge?.id, onClose = p.onClose;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!edgeId) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [edgeId, onClose]);
  useEffect(() => {
    if (!edgeId) return;
    const previous = document.activeElement;
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [edgeId]);
  if (!edge) return null;
  return <div ref={ref} className={s.side} data-pd-side={edge.id}>
    <ProductEdgePage edge={edge} board={p.board} onClose={p.onClose} onTask={p.onTask} now={p.now} tr={p.tr} />
  </div>;
}
