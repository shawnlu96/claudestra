'use client';
/** 项目地图的结构边、锁边与世界坐标 HTML 标签；图例独立于平移缩放层。 */
import { useId } from 'react';
import type { Tr } from '../collab-model';
import { edgePath, pointAt } from '../v4/canvas-view';
import type { ProductCanvas, ProductEdgeView } from './product-layout';
import type { ProductPick } from './product-side';
import { LockIcon } from './product-edge-icons';
import { pdText } from './product-i18n';
import s from './product-edges.module.css';

interface Box { x: number; y: number; w: number; h: number }
interface Label extends Box { id: string; text: string; dot: boolean }
const LABEL_H = 22, GAP = 3, MAX_W = 140 - GAP * 2;
const stateOf = (e: ProductEdgeView) => e.kinds.includes('lock') ? 'lock' : e.satisfied ? 'satisfied' : 'waiting';
const loopPath = (e: ProductEdgeView) => `M ${e.x1} ${e.y1} C ${e.x1} ${e.loopY}, ${e.x2} ${e.loopY}, ${e.x2} ${e.y2}`;
const hits = (a: Box, b: Box) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

function edgeLabel(e: ProductEdgeView, tr: Tr): string {
  if (e.kinds.includes('lock')) return pdText(tr, '{n} 处等文件锁', { n: e.count });
  if (e.kinds.includes('task')) return pdText(tr, e.kinds.includes('declared') ? '手写 + {n} 条任务依赖' : '{n} 条任务依赖', { n: e.count });
  const note = e.deps.map(d => d.note).filter(Boolean).join('\n');
  const chars = [...note];
  return note ? chars.slice(0, 18).join('') + (chars.length > 18 ? '…' : '') : pdText(tr, '手写依赖');
}

function anchor(e: ProductEdgeView, t: number) {
  if (e.loopY === null) return pointAt(e, t);
  const u = 1 - t;
  return { x: u ** 3 * e.x1 + 3 * u * u * t * e.x1 + 3 * u * t * t * e.x2 + t ** 3 * e.x2,
    y: u ** 3 * e.y1 + 3 * u * t * e.loopY + t ** 3 * e.y2 };
}

/** v4 的 placeLabels 按 96px 列缝、CEdge.label 定宽；这里按项目地图的 140px 列缝，并沿实际回绕曲线避让。 */
function labelsOf(canvas: ProductCanvas, tr: Tr): Label[] {
  const obstacles: Box[] = [...canvas.nodes, ...canvas.chips];
  const placed: Box[] = [];
  return canvas.edges.map(e => {
    const text = edgeLabel(e, tr);
    const width = Math.min(MAX_W, [...text].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? 11 : 6.5), e.kinds.includes('lock') ? 30 : 16));
    const candidates = [0.5, 0.35, 0.65].map(t => anchor(e, t));
    for (const p of candidates) {
      const box = { x: p.x - width / 2, y: p.y - LABEL_H / 2, w: width, h: LABEL_H };
      if ([...obstacles, ...placed].some(o => hits(box, o))) continue;
      placed.push(box);
      return { ...box, id: e.id, text, dot: false };
    }
    // 拥挤的交叉边保留可点的圆点；仍避开卡片，全文与证据由边页承载。
    for (const p of candidates) {
      const box = { x: p.x - 4, y: p.y - 4, w: 8, h: 8 };
      if ([...obstacles, ...placed].some(o => hits(box, o))) continue;
      placed.push(box);
      return { ...box, id: e.id, text, dot: true };
    }
    return { id: e.id, text, x: candidates[0].x, y: candidates[0].y, w: 0, h: 0, dot: true };
  });
}

interface Props { canvas: ProductCanvas; onPick: (p: ProductPick) => void; pick?: ProductPick | null; tr: Tr }
export function ProductEdges({ canvas, onPick, pick, tr }: Props) {
  const uid = useId();
  const labels = labelsOf(canvas, tr);
  const selected = (id: string) => pick?.kind === 'edge' && pick.id === id;
  const choose = (id: string) => onPick({ kind: 'edge', id });
  return <>
    <svg className={s.edges} width={canvas.w} height={canvas.h}>
      <defs>{['satisfied', 'waiting', 'lock'].map(state => <marker key={state} id={`${uid}-${state}`} viewBox="0 0 8 8"
        refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 1 1 L 7 4 L 1 7" className={`${s.arrow} ${s[state]}`} />
      </marker>)}</defs>
      {canvas.edges.map(e => {
        const state = stateOf(e), path = e.loopY === null ? edgePath(e) : loopPath(e);
        return <g key={e.id} className={`${s[state]} ${selected(e.id) ? s.selected : ''}`}>
          <path d={path} data-pd-edge={e.id} data-pd-edge-state={state} data-pd-back={e.back || undefined}
            className={s.line} markerEnd={`url(#${uid}-${state})`} />
          <path d={path} data-pd-hit={e.id} className={s.hit} strokeWidth={14} role="button" tabIndex={0}
            aria-label={edgeLabel(e, tr)} aria-pressed={selected(e.id)} onClick={() => choose(e.id)} onKeyDown={ev => {
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(e.id); }
            }} />
        </g>;
      })}
    </svg>
    {labels.map(l => {
      const e = canvas.edges.find(e => e.id === l.id)!;
      return <button type="button" key={l.id} data-pd-label={l.id} aria-label={l.text} aria-pressed={selected(l.id)}
        className={`${s.label} ${s[stateOf(e)]} ${selected(l.id) ? s.selected : ''} ${l.dot ? s.dot : ''}`}
        style={{ left: l.x, top: l.y, width: l.w, height: l.h }} onClick={() => choose(l.id)}>
        {!l.dot && <>{e.kinds.includes('lock') && <LockIcon />}<span>{l.text}</span></>}
      </button>;
    })}
  </>;
}

export function ProductEdgeLegend({ canvas, tr }: { canvas: ProductCanvas; tr: Tr }): React.ReactNode {
  if (!canvas.edges.length) return null;
  return <div className={s.legend} data-pd-legend>
    {(['satisfied', 'waiting', 'lock'] as const).map((state, i) => <span key={state} className={s.legendItem}>
      <svg width="25" height="10" aria-hidden className={s[state]}><path d="M 1 5 H 24" className={s.line} /></svg>
      {pdText(tr, ['已成立', '在等', '等文件锁'][i])}
    </span>)}
  </div>;
}
