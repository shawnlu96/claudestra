'use client';
/**
 * 项目地图的卡：FeatureBody 是卡的正文（手机列表与桌面卡共用，原样从 product-view.tsx 搬来）；ProductCard 是桌面整卡按钮。
 * 三个约定属性给 PDVIEW1 缩小时降级用：卡根 data-pd-card、标题 data-pd-title、标题 / 数字行 / 进度条以外的明细行 data-pd-detail。
 */
import type { ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import v from '../v4/v4.module.css';
import { productEta, type ProductNode } from './product-layout';
import s from './product.module.css';
import m from './product-map.module.css';
import { featureWords } from '../count-words';
import { countText } from '../count-words-i18n';
import { useCountContext } from '../use-count-source';
import { pdText } from './product-i18n';

export interface CardProps { now: number; tr: Tr; featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean }

/** mark = 桌面卡：标上 data-pd-title / data-pd-detail（手机列表不标，DOM 不变） */
export function FeatureBody({ feature: f, now, tr, featureMeta, activeUnknown, mark }: CardProps & { feature: ProductFeature; mark?: boolean }) {
  const eta = productEta(f.eta?.at, now, tr('今天'));
  // 全局（整个源没有进行中数）或本 feature 标了 activeUnknown：都不出「N 进行中」，占位 0 不能当真 0
  const hideActive = activeUnknown || f.counts.activeUnknown === true;
  const words = useCountContext();
  return <>
    <strong className={s.title} style={featureMeta ? { flexShrink: 0 } : undefined} data-pd-title={mark || undefined}>{f.title || f.id}</strong>
    {f.hasDag ? <>
      <span className={s.numbers}>{f.counts.completed} / {f.counts.total}{f.status === 'paused' && <span>{tr('已暂停')}</span>}</span>
      <span className={s.bar} role="progressbar" aria-label={f.title} aria-valuemin={0} aria-valuemax={f.counts.total || 1}
        aria-valuenow={f.counts.completed}><span style={{ width: `${Math.min(100, f.counts.total ? f.counts.completed / f.counts.total * 100 : 0)}%` }} /></span>
    </> : <span className={s.numbers}>{f.counts.total} {tr('卡')}</span>}
    <span className={s.stats} data-pd-detail={mark || undefined}>{words && words.status !== 'none' ? <FeatureWords id={f.id} tr={tr} /> : <>
      {!hideActive && <span><Icon name="zap" size={12} />{f.counts.active} {tr('进行中')}</span>}
      <span>{f.counts.blocked ?? f.cards?.filter(c => c.stage === 'blocked').length ?? 0} {tr('受阻')}</span></>}
      {eta && <span className={s.eta}>{tr('预计')} {eta}</span>}</span>
    {featureMeta?.(f)}
  </>;
}

/**
 * 产品卡的两个数（UXNUM1）：「在干活 a · 在等 b」，按看板行的 feature 归属数（count-words.ts，和顶栏同一份）；没载完是骨架。
 * 没有 CountContext 的老调用方（单测直接挂）照旧显示 feature 自带的「进行中 / 受阻」
 */
function FeatureWords({ id, tr }: { id: string; tr: Tr }) {
  const counts = useCountContext();
  const w = counts?.status === 'ready' ? featureWords(counts.snap, id) : null;
  const n = (x: number | undefined) => x === undefined ? <span className={v.skel} aria-hidden /> : x;
  return <>
    <span data-product-words="working"><Icon name="zap" size={12} />{countText(tr, '在干活')} {n(w?.working)}</span>
    <span data-product-words="waiting"><Icon name="clock" size={12} />{countText(tr, '在等')} {n(w?.waiting)}</span>
  </>;
}

/** 桌面整卡（本卡仍是一个整卡按钮，点了进子 DAG）。拆自哪个 feature 先写在明细里，摆位归 PDCARD1 */
export function ProductCard(p: CardProps & { node: ProductNode; onFeature: (id: string) => void; onTask?: (id: string) => void }) {
  const n = p.node;
  return <button type="button" className={`${s.card} ${s.node}`} data-pd-card={n.id} data-pd-state={n.state}
    style={{ left: n.x, top: n.y, width: n.w, height: n.h, ...(p.featureMeta ? { gap: 6 } : {}) }} onClick={() => p.onFeature(n.id)}>
    <FeatureBody feature={n.feature} now={p.now} tr={p.tr} featureMeta={p.featureMeta} activeUnknown={p.activeUnknown} mark />
    {n.splitFrom && <span className={m.splitFrom} data-pd-detail>{pdText(p.tr, '拆自 {x}', { x: n.splitFrom })}</span>}
  </button>;
}
