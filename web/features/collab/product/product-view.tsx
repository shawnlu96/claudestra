'use client';
/**
 * 项目地图（产品 DAG 标签的内容）：这里只分路——手机走 ProductMobile，桌面走 ProductCanvas。
 * FeatureTrail / FeatureCards 是进子 DAG 后的面包屑和无 DAG 卡列表，product-panes.tsx 从这里 import。
 */
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { STAGE_NAME } from '../collab-detail-model';
import { Icon } from '../collab-icons';
import { ProductCanvas } from './product-canvas';
import { ProductMobile } from './product-mobile';
import s from './product.module.css';

interface Props {
  board: ProductBoard; narrow: boolean; now: number; onFeature: (id: string) => void; tr: Tr; featureMeta?: (f: ProductFeature) => React.ReactNode;
  activeUnknown?: boolean; onTask?: (id: string) => void;
}

export function ProductView(p: Props) {
  if (p.narrow) return <ProductMobile board={p.board} now={p.now} onFeature={p.onFeature} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown} />;
  return <ProductCanvas board={p.board} now={p.now} onFeature={p.onFeature} onTask={p.onTask} tr={p.tr} featureMeta={p.featureMeta}
    activeUnknown={p.activeUnknown} />;
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
