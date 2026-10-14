'use client';
/**
 * 手机上的产品列表：原样从 product-view.tsx 搬来，行为、顺序、DOM 都不变（PDMOBILE1 重做）。
 * 只收起 status=done（「N 已完成」），其余按 board 的顺序往下排，dropped 不显示。
 */
import { useState } from 'react';
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import { FeatureBody } from './product-card';
import s from './product.module.css';

interface Props { board: ProductBoard; now: number; onFeature: (id: string) => void; tr: Tr; featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean }

export function ProductMobile(p: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const all = p.board.features.filter(f => f.status !== 'dropped');
  const done = all.filter(f => f.status === 'done');
  const shown = all.filter(f => f.status !== 'done' || doneOpen);
  const fold = done.length > 0 && <button type="button" className={s.done} aria-expanded={doneOpen}
    onClick={() => setDoneOpen(value => !value)}><Icon name="check" size={14} />{done.length} {p.tr('已完成')}</button>;
  return <div className={s.mobile}>{fold}{shown.map(f =>
    <button key={f.id} type="button" className={s.card} style={p.featureMeta ? { gap: 6 } : undefined} onClick={() => p.onFeature(f.id)}>
      <FeatureBody feature={f} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown} />
    </button>)}</div>;
}
