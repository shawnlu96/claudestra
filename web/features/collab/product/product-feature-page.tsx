'use client';
/**
 * 项目地图右侧的模块页（PDFOCUS1，product-side.tsx 在 pick.kind === 'feature' 时渲染；PDMOBILE1 的抽屉复用它）。
 * 头：状态点 + 状态词（· 拆自 X）+ 标题；大数字；被挡着 / 挡着谁（点一行 = 选中那张卡并居中）；在跑的全部前沿行；关键链；「看模块进度」。
 * 团队视图没有 frontier / links：对应小节不渲染。
 */
import type { ProductBoard } from '@/lib/api/product-board-types';
import { READY_WORD } from '@/lib/owner-words';
import type { Tr } from '../collab-model';
import { relTime } from '../dag/focus-i18n';
import { Shell, Sec } from '../v4/v4-props';
import { TaskRow } from './product-card';
import { LockIcon } from './product-edge-icons';
import { cpSpan, type CriticalPath } from './product-focus';
import type { MapState } from './product-graph';
import { cpText, pdText } from './product-i18n';
import { productEta, type ProductCanvas, type ProductEdgeView, type ProductNode } from './product-layout';
import s from './product-edges.module.css';
import fx from './product-focus.module.css';

const STATE_WORD: Record<MapState, string> = {
  run: '在跑', blocked: '受阻', stale: '久未动', ready: READY_WORD, gate: '待验收', wait: '在等前置', done: '已收尾', paused: '已暂停', frozen: '冻结',
};

export interface FeaturePageProps {
  node: ProductNode; layout: Pick<ProductCanvas, 'nodes' | 'edges'>; board: ProductBoard; cp: CriticalPath | null;
  onClose: () => void; onPick: (id: string) => void; onFeature: (id: string) => void; onTask?: (id: string) => void; now: number; tr: Tr;
}

function EdgeList({ edges, other, title, empty, onPick, tr }: { edges: ProductEdgeView[]; other: (e: ProductEdgeView) => string;
  title: (id: string) => string; empty: string; onPick: (id: string) => void; tr: Tr }) {
  if (!edges.length) return <p className={fx.empty}>{pdText(tr, empty)}</p>;
  return <ul className={fx.list}>{edges.map(e => {
    const lock = e.kinds.includes('lock'), id = other(e);
    return <li key={e.id}><button type="button" className={fx.relRow} data-pd-related={id} onClick={() => onPick(id)}>
      {lock && <span className={fx.linkLock}><LockIcon /></span>}
      <span className={fx.linkTitle}>{title(id)}</span>
      <span className={fx.linkNote}>{lock ? pdText(tr, '{n} 个节点等锁', { n: e.count }) : pdText(tr, e.satisfied ? '已成立' : '在等')}</span>
    </button></li>;
  })}</ul>;
}

function Numbers({ node, now, tr }: { node: ProductNode; now: number; tr: Tr }) {
  const f = node.feature, eta = productEta(f.eta?.at, now, tr('今天'));
  const line = [
    ...(f.counts.activeUnknown ? [] : [`${f.counts.active} ${pdText(tr, '在跑')}`]), `${f.counts.waiting ?? 0} ${pdText(tr, '在等前置')}`,
    ...(eta ? [`${tr('预计')} ${eta}`] : []),
    ...(f.lastActivityAt != null ? [pdText(tr, '最近动静 {t}', { t: relTime(f.lastActivityAt, now, (w, p) => pdText(tr, w, p)) })] : []),
  ];
  return <div data-pd-numbers>
    <div className={fx.bigNum}>{f.counts.completed} / {f.counts.total}<small>{pdText(tr, '完成')}</small></div>
    <div className={fx.line}>{line.join(' · ')}</div>
  </div>;
}

export function ProductFeaturePage(p: FeaturePageProps) {
  const { node, tr } = p, f = node.feature, id = node.id;
  const title = (x: string) => p.layout.nodes.find(n => n.id === x)?.feature.title || p.board.features.find(b => b.id === x)?.title || x;
  const head = [pdText(tr, STATE_WORD[node.state]), ...(node.splitFrom ? [pdText(tr, '拆自 {x}', { x: node.splitFrom })] : [])].join(' · ');
  const onPath = p.cp && p.cp.ids.includes(id) ? p.cp : null;
  return <Shell title={f.title || f.id} onClose={p.onClose} tr={w => pdText(tr, w)} className={s.page}>
    <div className={fx.state} data-state={node.state} data-pd-state-line><span className={fx.stateDot} aria-hidden />{head}</div>
    <Numbers node={node} now={p.now} tr={tr} />
    {p.board.links !== undefined && <>
      <Sec title={pdText(tr, '被挡着')}>
        <EdgeList edges={p.layout.edges.filter(e => e.to === id)} other={e => e.from} title={title} empty="没有前置" onPick={p.onPick} tr={tr} />
      </Sec>
      <Sec title={pdText(tr, '挡着谁')}>
        <EdgeList edges={p.layout.edges.filter(e => e.from === id)} other={e => e.to} title={title} empty="没有谁在等它" onPick={p.onPick} tr={tr} />
      </Sec>
    </>}
    {f.frontier && f.frontier.length > 0 && <Sec title={`${pdText(tr, '在跑')} ${f.frontier.length}`}>
      <div className={fx.tasks} data-pd-frontier>{f.frontier.map(r => <TaskRow key={r.key} row={r} now={p.now} tr={tr} onTask={p.onTask} />)}</div>
    </Sec>}
    {onPath && <section data-pd-cp-chain>
      <div className={fx.cpHead}>{cpText(tr, '关键链', cpSpan(onPath.hours))}</div>
      <div className={fx.cpChips}>{onPath.ids.map(x => <span key={x} className={fx.cpChip} data-on={x === id}>{title(x)}</span>)}</div>
    </section>}
    <button type="button" className={fx.go} data-pd-open onClick={() => p.onFeature(id)}>{pdText(tr, '看模块进度')}</button>
  </Shell>;
}
