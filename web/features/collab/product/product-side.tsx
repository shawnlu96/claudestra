'use client';
/** 项目地图的右侧页插槽（PDFOCUS1 做成画布上的浮层）：本卡只定接口，返回 null，没有任何地方触发 pick */
import type { ProductBoard } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';

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
  void p;
  return null;
}
