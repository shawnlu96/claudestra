'use client';
/**
 * 项目地图的边（PDEDGEUI1 重写这个文件）。本卡只画实线 / 点线：成立的结构边实线，其余点线；back 边从两端底部绕下去。
 * ProductEdges 放在世界层里；ProductEdgeLegend 放在世界层外面（本卡没有图例，返回 null）。
 */
import type { Tr } from '../collab-model';
import { edgePath } from '../v4/canvas-view';
import d from '../dag/dag.module.css';
import type { ProductCanvas, ProductEdgeView } from './product-layout';
import type { ProductPick } from './product-side';

const loopPath = (e: ProductEdgeView) => `M ${e.x1} ${e.y1} C ${e.x1} ${e.loopY}, ${e.x2} ${e.loopY}, ${e.x2} ${e.y2}`;

export function ProductEdges({ canvas }: { canvas: ProductCanvas; onPick: (p: ProductPick) => void; tr: Tr }) {
  return <svg className={d.edges} width={canvas.w} height={canvas.h}>
    {canvas.edges.map(e => <path key={e.id} d={e.loopY === null ? edgePath(e) : loopPath(e)} data-pd-edge={e.id}
      className={`${d.eLine} ${e.solid ? d.eSolid : d.eDotted}`}>{e.note && <title>{e.note}</title>}</path>)}
  </svg>;
}

export function ProductEdgeLegend(p: { canvas: ProductCanvas; tr: Tr }): React.ReactNode {
  void p;
  return null;
}
