'use client';
/**
 * 项目地图的卡：FeatureBody 保留手机正文；ProductCard 是桌面卡，主按钮和任务行分开，避免嵌套按钮。
 * 三个约定属性给 PDVIEW1 缩小时降级用：卡根 data-pd-card、标题 data-pd-title、标题 / 数字行 / 进度条以外的明细行 data-pd-detail。
 */
import type { ProductFeature } from '@/lib/api/product-board';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import v from '../v4/v4.module.css';
import { productEta, type ProductNode } from './product-layout';
import s from './product.module.css';
import m from './product-map.module.css';
import c from './product-card.module.css';
import { cardTasks, elapsedTime, frontierStage, progressSegments, staleBadge } from './product-card-model';
import type { ProductFrontierItem } from '@/lib/api/product-board-types';
import { featureWords } from '../count-words';
import { countText } from '../count-words-i18n';
import { useCountContext } from '../use-count-source';
import { pdText } from './product-i18n';
import fx from './product-focus.module.css';

export interface CardProps { now: number; tr: Tr; featureMeta?: (f: ProductFeature) => React.ReactNode; activeUnknown?: boolean }

/** mark = 桌面卡：标上 data-pd-title / data-pd-detail（手机列表不标，DOM 不变） */
export function FeatureBody({ feature: f, now, tr, featureMeta, activeUnknown, mark }: CardProps & { feature: ProductFeature; mark?: boolean }) {
  const eta = productEta(f.eta?.at, now, tr('今天'));
  return <>
    <strong className={s.title} style={featureMeta ? { flexShrink: 0 } : undefined} data-pd-title={mark || undefined}>{f.title || f.id}</strong>
    {f.hasDag ? <>
      <span className={s.numbers}>{f.counts.completed} / {f.counts.total}{f.status === 'paused' && <span>{tr('已暂停')}</span>}</span>
      <span className={s.bar} role="progressbar" aria-label={f.title} aria-valuemin={0} aria-valuemax={f.counts.total || 1}
        aria-valuenow={f.counts.completed}><span style={{ width: `${Math.min(100, f.counts.total ? f.counts.completed / f.counts.total * 100 : 0)}%` }} /></span>
    </> : <span className={s.numbers}>{f.counts.total} {tr('卡')}</span>}
    <span className={s.stats} data-pd-detail={mark || undefined}><FeatureStats feature={f} tr={tr} activeUnknown={activeUnknown} />
      {eta && <span className={s.eta}>{tr('预计')} {eta}</span>}</span>
    {featureMeta?.(f)}
  </>;
}

/** 手机和桌面使用同一份未知态与 UXNUM1 统计口径。 */
function FeatureStats({ feature: f, tr, activeUnknown }: { feature: ProductFeature; tr: Tr; activeUnknown?: boolean }) {
  const words = useCountContext();
  const hideActive = activeUnknown || f.counts.activeUnknown === true;
  return words && words.status !== 'none' ? <FeatureWords id={f.id} tr={tr} /> : <>
    {!hideActive && <span><Icon name="zap" size={12} />{f.counts.active} {tr('进行中')}</span>}
    <span>{f.counts.blocked ?? f.cards?.filter(c => c.stage === 'blocked').length ?? 0} {tr('受阻')}</span>
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

/** 徽章优先级由服务端状态决定，split 只占没有状态徽章时的空位。 */
function CardBadge({ node: n, now, tr }: { node: ProductNode; now: number; tr: Tr }) {
  if (n.state === 'blocked') return <span className={`${c.badge} ${c.blocked}`}>
    <Icon name="circleAlert" size={11} />{pdText(tr, '{n} 受阻', { n: n.feature.counts.blocked ?? 0 })}</span>;
  if (n.state === 'stale') {
    const badge = staleBadge(n.feature.lastActivityAt, now);
    return <span className={`${c.badge} ${c.stale}`}><Icon name="clock" size={11} />{pdText(tr, badge.word, { n: badge.n ?? '' })}</span>;
  }
  if (n.state === 'gate') return <span className={c.badge}><Icon name="shieldCheck" size={11} />{pdText(tr, '待验收')}</span>;
  return n.splitFrom ? <span className={`${c.badge} ${m.splitFrom}`} data-pd-detail title={n.splitFrom}>
    {pdText(tr, '拆自 {x}', { x: n.splitFrom })}</span> : null;
}

function Progress({ feature: f, tr }: { feature: ProductFeature; tr: Tr }) {
  return <span className={c.progress} role="progressbar" aria-label={f.title} aria-valuemin={0}
    aria-valuemax={f.counts.total} aria-valuenow={f.counts.completed}>
    {progressSegments(f.counts).map(p => <span key={p.key} className={c[p.key]} title={`${pdText(tr, p.word)} ${p.count}`}
      style={{ width: `${p.width}%` }} />)}
  </span>;
}

/** 卡上按 top 绝对定位；模块页（product-feature-page.tsx）不给 top，按 flow 排 */
export function TaskRow({ row: r, top, now, tr, onTask }: { row: ProductFrontierItem; top?: number; now: number; tr: Tr; onTask?: (id: string) => void }) {
  const time = r.frozen ? null : elapsedTime(r.sinceMs, now);
  const details = [r.member, time && pdText(tr, time.word, { n: time.n })].filter(Boolean).join(' · ');
  const contents = <>
    <span className={c.stage}>{frontierStage(r, (word, params) => pdText(tr, word, params))}</span>
    <span className={c.taskKey}>{r.key}</span><span className={c.taskTitle}>{r.title}</span>
    {details && <span className={c.member}>{details}</span>}
  </>;
  const cls = `${c.task} ${r.frozen ? c.frozen : ''} ${r.stage === 'blocked' || r.stage === null ? c.taskBlocked : ''} ${top === undefined ? fx.flowTask : ''}`;
  const title = [frontierStage(r, (word, params) => pdText(tr, word, params)), r.key, r.title, details].filter(Boolean).join(' · ');
  const style = top === undefined ? undefined : { top };
  return r.taskId === null ? <div className={cls} style={style} data-pd-task={r.key} data-pd-detail title={title}>{contents}</div>
    : <button type="button" className={cls} style={style} data-pd-task={r.key} data-pd-detail title={title}
      onClick={() => onTask?.(r.taskId!)}>{contents}</button>;
}

export interface CardFocus {
  /** 单击 / 第一次 Enter：选中或取消（PDFOCUS1）；不给就照旧单击进模块 */
  onPick?: (id: string) => void;
  /** selected = 描边（含选中边的两端）；picked = 这张卡就是当前选中的模块（aria-pressed、再按 Enter 进入只看它） */
  selected?: boolean; picked?: boolean; dim?: boolean;
  /** 关键路径小标（已经过词表） */
  cp?: string;
}

/**
 * 主按钮和任务按钮是兄弟；主按钮覆盖整卡，任务区仅有按钮接收指针，留白仍能选中模块。
 * 有 onPick 时：鼠标单击 = 选中 / 再点取消，双击 = 进入；键盘（click 的 detail 为 0）Enter 先选中，已选中再按一次进入。
 */
export function ProductCard(p: CardProps & CardFocus & { node: ProductNode; onFeature: (id: string) => void; onTask?: (id: string) => void }) {
  const n = p.node, f = n.feature;
  const { rows, more } = cardTasks(f);
  const eta = ['run', 'blocked', 'ready'].includes(n.state) ? productEta(f.eta?.at, p.now, p.tr('今天')) : null;
  const click = (e: React.MouseEvent) => {
    if (!p.onPick) return p.onFeature(n.id);
    if (e.detail === 0) return p.picked ? p.onFeature(n.id) : p.onPick(n.id);
    if (e.detail === 1) p.onPick(n.id);
  };
  return <div className={`${c.card} ${fx.fade} ${p.selected ? fx.selected : ''} ${p.dim ? fx.dim : ''}`} data-pd-card={n.id} data-pd-state={n.state}
    data-pd-selected={p.selected || undefined} data-pd-dim={p.dim || undefined} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
    {p.cp && <span className={fx.cpTag} data-pd-cp>{p.cp}</span>}
    <button type="button" className={c.main} aria-pressed={p.onPick ? !!p.picked : undefined} onClick={click}
      onDoubleClick={p.onPick ? () => p.onFeature(n.id) : undefined}>
      <span className={c.header}><span className={c.dot} aria-hidden />
        <strong data-pd-title className={c.title} title={f.title}>{f.title || f.id}</strong><CardBadge node={n} now={p.now} tr={p.tr} /></span>
      <span className={c.numbers}>{f.counts.completed} / {f.counts.total}</span>
      <Progress feature={f} tr={p.tr} />
      <span className={`${s.stats} ${c.stats}`} data-pd-detail>
        <FeatureStats feature={f} tr={p.tr} activeUnknown={p.activeUnknown} />
        {eta && <span className={s.eta}>{p.tr('预计')} {eta}</span>}
      </span>
      {p.featureMeta && <span className={c.meta} data-pd-detail>{p.featureMeta(f)}</span>}
    </button>
    {rows.map((r, i) => <TaskRow key={r.key} row={r} top={81 + i * 21} now={p.now} tr={p.tr} onTask={p.onTask} />)}
    {more > 0 && <div className={c.more} style={{ top: 81 + rows.length * 21 }} data-pd-detail>
      {pdText(p.tr, '还有 {n} 个节点', { n: more })}</div>}
  </div>;
}

/** 所有已收尾 / 暂停的小标签共用；尺寸仍由布局的 176 × 34 决定。 */
export function ProductChipContent({ feature: f, label, tr }: { feature: ProductFeature; label: string | null; tr: Tr }) {
  const date = f.lastActivityAt == null ? null : new Date(f.lastActivityAt);
  const stamp = date ? `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null;
  return <>
    {label === null && <Icon name="check" size={12} />}<span className={m.chipTitle}>{f.title || f.id}</span>
    {label === null ? <>
      {stamp && <span className={m.chipTag}>{stamp}</span>}
      {f.complete && f.status !== 'done' && <span className={c.unclosed} title={pdText(tr, '全部完成，还没关单')} />}
    </> : <span className={m.chipTag}>{pdText(tr, label)}</span>}
  </>;
}
