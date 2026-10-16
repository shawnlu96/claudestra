import type { ReactNode } from 'react';
import type { ProductBoard, ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import type { ModuleBy } from '../dag/use-dag-ui';
import type { DagBoard } from '../dag/dag-types';
import { Icon } from '../collab-icons';
import { useProjectTabsT } from '../project-tabs/project-tabs-i18n';
import p from '../project-tabs/project-tabs.module.css';
import { hasFeatureSnapshot } from './dag-availability';
import { FeatureCards, ProductView } from './product-view';
import d from '../dag/dag.module.css';
import s from './product.module.css';

interface Common {
  board: ProductBoard | null;
  /** No answer yet: placeholder instead of the causal fallback (board null + !loading = definitely none). */
  loading?: boolean;
  onFeature: (id: string) => void;
  onTask: (id: string) => void;
  /** No product board: desktop causal canvas / phone grouped list (the caller decides which). */
  fallback: ReactNode;
  narrow: boolean;
  now: number;
  tr: Tr;
}

const Loading = ({ tr }: { tr: Tr }) => <div className={s.loading} role="status">{tr('加载中…')}</div>;

/**
 * 项目地图标签：产品看板；没有产品看板的项目退回因果线（fallback）。看板还在读时是占位，因果线不先闪一下
 * （tests/web-dom-product-panes-loading.test.ts）。project-map-* 卡只换这一块。
 */
export function MapPane(props: Common & { project?: string }) {
  const { board, loading = false } = props;
  const body = loading ? <Loading tr={props.tr} />
    : board ? <ProductView board={board} narrow={props.narrow} now={props.now} onFeature={props.onFeature} tr={props.tr} onTask={props.onTask} project={props.project} />
      : props.fallback;
  return <div className={props.narrow ? s.panes : p.fill}>{body}</div>;
}

function ModuleList({ modules, onFeature, tr }: { modules: readonly ProductFeature[]; onFeature: (id: string) => void; tr: Tr }) {
  return <ul className={p.modules} aria-label={tr('模块')}>
    {modules.map(f => <li key={f.id}>
      <button type="button" className={p.moduleRow} data-module={f.id} onClick={() => onFeature(f.id)}>
        <span className={p.moduleTitle}>{f.title}</span>
        <span className={p.moduleMeta}>{tr('{d}/{t} 完成', { d: f.counts.completed, t: f.counts.total })}</span>
        <Icon name="chevronRight" size={14} />
      </button>
    </li>)}
  </ul>;
}

function ModuleTrail({ title, onBack, tr }: { title: string; onBack: () => void; tr: Tr }) {
  return <nav className={s.trail} aria-label={tr('模块')}>
    <button type="button" onClick={onBack}>{tr('模块')}</button><Icon name="chevronRight" size={14} /><strong>{title}</strong>
  </nav>;
}

interface ModuleProps extends Common {
  dagBoard: DagBoard | null;
  featureId: string | null;
  by: ModuleBy;
  setBy: (by: ModuleBy) => void;
  onBack: () => void;
  /** 选中模块的子图（桌面 FocusBoard / 画布，手机 MobileDag） */
  subdag: ReactNode;
  /** 「按人」= 谁在干活看板 */
  progress: ReactNode;
  /** 老 bridge 没有产品看板但有子图：按模块直接是全部模块的子图 */
  graph: boolean;
}

/**
 * 模块进度标签：顶上「按模块 / 按人」。按模块 = 没选模块时是有子图的模块列表（点一行选中），选了是它的子图；
 * 没有任何可列的模块时不出分段，直接是按人。
 */
export function ModulePane(props: ModuleProps) {
  const tr = useProjectTabsT(props.tr);
  const { board, loading = false } = props;
  const modules = board?.features.filter(f => f.hasDag) ?? [];
  const feature = board?.features.find(f => f.id === props.featureId);
  const any = loading || modules.length > 0 || !!feature || (!board && props.graph);
  const by: ModuleBy = any ? props.by : 'person';
  const snapshot = !!feature && hasFeatureSnapshot(props.dagBoard, feature.id);
  const content = by === 'person' ? props.progress
    : loading ? <Loading tr={tr} />
    : feature ? <>
      <ModuleTrail title={feature.title} onBack={props.onBack} tr={tr} />
      <div key={snapshot ? 'snapshot' : 'fallback'} className={s.recovery}>
        {feature.hasDag ? snapshot ? props.subdag : props.fallback : <FeatureCards feature={feature} onTask={props.onTask} tr={props.tr} />}
      </div>
    </>
    : board ? <ModuleList modules={modules} onFeature={props.onFeature} tr={tr} />
    : props.subdag;
  return <div className={props.narrow ? s.panes : p.fill} data-module-by={by}>
    {any && <div className={props.narrow ? d.mseg : p.seg} role="tablist" aria-label={tr('模块进度')}>
      {(['module', 'person'] as const).map(k => <button key={k} type="button" role="tab" aria-selected={by === k}
        className={props.narrow ? `${d.msegBtn} ${by === k ? d.msegOn : ''}` : `${p.segBtn} ${by === k ? p.segOn : ''}`}
        onClick={() => props.setBy(k)}>{tr(k === 'module' ? '按模块' : '按人')}</button>)}
    </div>}
    {content}
  </div>;
}
