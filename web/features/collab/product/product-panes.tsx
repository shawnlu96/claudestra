import type { ReactNode } from 'react';
import type { ProductBoard } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import type { DagTab } from '../dag/use-dag-ui';
import type { DagBoard } from '../dag/dag-types';
import { hasFeatureSnapshot } from './dag-availability';
import { FeatureCards, FeatureTrail, ProductView } from './product-view';
import v from '../v4/v4.module.css';
import d from '../dag/dag.module.css';
import s from './product.module.css';

const LABELS: Record<DagTab, string> = { product: '产品 DAG', dag: '子 DAG', progress: '谁在干活', team: '团队' };
interface Props {
  board: ProductBoard | null;
  dagBoard: DagBoard | null;
  featureId: string | null;
  tab: DagTab;
  setTab: (tab: DagTab) => void;
  onFeature: (id: string) => void;
  onTask: (id: string) => void;
  subdag: ReactNode;
  fallback: ReactNode;
  progress: ReactNode;
  team?: ReactNode;
  graph: boolean;
  narrow: boolean;
  now: number;
  tr: Tr;
}

/** Product failure returns the existing grouped sub-DAG without moving its viewport or erasing the work board. */
export function ProductPanes(p: Props) {
  const feature = p.board?.features.find(f => f.id === p.featureId);
  const tab = !p.board && p.tab === 'product' ? 'dag' : p.board && p.tab === 'dag' && !feature ? 'product' : p.tab;
  const keys: DagTab[] = p.board ? p.narrow ? ['product', 'progress'] : ['product', 'dag', 'progress', 'team']
    : p.narrow ? ['dag', 'progress'] : ['dag', 'progress', 'team'];
  const content = tab === 'team' ? <div className={v.teamPane}>{p.team}</div> : tab === 'progress' ? p.progress
    : p.board && tab === 'product' ? <ProductView board={p.board} narrow={p.narrow} now={p.now} onFeature={p.onFeature} tr={p.tr} />
      : p.board && feature ? <>
        <FeatureTrail title={feature.title} onBack={() => p.setTab('product')} tr={p.tr} />
        <div key={hasFeatureSnapshot(p.dagBoard, feature.id) ? 'snapshot' : 'fallback'} className={s.recovery}>
          {feature.hasDag ? hasFeatureSnapshot(p.dagBoard, feature.id) ? p.subdag : p.fallback
            : <FeatureCards feature={feature} onTask={p.onTask} tr={p.tr} />}
        </div>
      </> : p.graph ? p.subdag : p.fallback;
  return <div className={p.narrow ? s.panes : v.center}>
    <div className={p.narrow ? d.mseg : v.tabs} role="tablist">
      {keys.map(k => {
        const disabled = k === 'dag' && !!p.board && !feature;
        const on = p.narrow && k === 'product' ? tab !== 'progress' : tab === k;
        const label = k === 'dag' && feature ? `${p.tr(LABELS[k])} · ${feature.title}`
          : p.tr(k === 'dag' && !p.board && !p.graph ? '因果线' : LABELS[k]);
        return <button key={k} type="button" role="tab" disabled={disabled} aria-selected={on}
          title={disabled ? p.tr('先在产品 DAG 里选一个 feature') : label}
          className={`${s.tab} ${p.narrow ? `${d.msegBtn} ${on ? d.msegOn : ''}` : `${v.tab} ${on ? v.tabOn : ''}`}`}
          onClick={() => p.setTab(k)}>{label}</button>;
      })}
    </div>
    {content}
  </div>;
}
