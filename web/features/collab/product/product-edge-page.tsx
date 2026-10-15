'use client';
/** 结构边保留手写原文与任务依据；锁依据只展示后端提供的条目，不推断省略的路径。 */
import type { ProductBoard, ProductLockEvidence, ProductTaskEvidence } from '@/lib/api/product-board-types';
import { stageWord } from '@/lib/owner-words';
import type { Tr } from '../collab-model';
import { relTime } from '../dag/focus-i18n';
import { Shell, Sec } from '../v4/v4-props';
import type { GraphEdge } from './product-graph';
import { LockIcon } from './product-edge-icons';
import { pdText } from './product-i18n';
import s from './product-edges.module.css';

interface Props {
  edge: GraphEdge; board: ProductBoard; onClose: () => void; onTask?: (id: string) => void; now: number; tr: Tr;
}
function TaskLink({ id, onTask }: { id: string; onTask?: (id: string) => void }) {
  return onTask ? <button type="button" className={s.task} onClick={() => onTask(id)}>{id}</button> : <span className={s.task}>{id}</span>;
}

function TaskRows({ rows, onTask, tr }: { rows: ProductTaskEvidence[]; onTask?: (id: string) => void; tr: Tr }) {
  return <ul className={s.rows}>{[...rows].sort((a, b) => Number(a.satisfied) - Number(b.satisfied)).map((r, i) =>
    <li key={i} className={s.row} data-pd-task-evidence data-pd-satisfied={r.satisfied}>
      <TaskLink id={r.from} onTask={onTask} /> {tr(stageWord(r.fromStage))} → <TaskLink id={r.to} onTask={onTask} /> {tr(stageWord(r.toStage))}
      {' · '}{pdText(tr, r.satisfied ? '已成立' : '在等')}
    </li>)}</ul>;
}

function LockRows({ rows, onTask, now, tr }: { rows: ProductLockEvidence[]; onTask?: (id: string) => void; now: number; tr: Tr }) {
  return <ul className={s.rows}>{rows.map((r, i) => <li key={i} className={s.row} data-pd-lock-evidence>
    <div>{pdText(tr, '{k} 想改 {path}', { k: r.node, path: r.wanted })}</div>
    <div>{pdText(tr, '被 {task} 的 {path} 占着', { task: '\u0001', path: '\u0002' }).split(/(\u0001|\u0002)/).map((part, j) =>
      part === '\u0001' ? <TaskLink key={j} id={r.holder} onTask={onTask} /> : <span key={j}>{part === '\u0002' ? r.held : part}</span>)}</div>
    <div className={s.since}>{pdText(tr, '{t} 起', { t: relTime(r.since, now, tr) })}</div>
  </li>)}</ul>;
}

export function ProductEdgePage({ edge, board, onClose, onTask, now, tr }: Props) {
  const word = (s: string) => pdText(tr, s);
  const title = (id: string) => board.features.find(f => f.id === id)?.title || id;
  const tasks = edge.links.filter(l => l.kind === 'task').flatMap(l => l.evidence) as ProductTaskEvidence[];
  const locks = edge.links.filter(l => l.kind === 'lock').flatMap(l => l.evidence) as ProductLockEvidence[];
  const types = edge.kinds.map(k => pdText(tr, k === 'lock' ? '等文件锁' : k === 'task' ? '{n} 条任务依赖' : '手写依赖', { n: edge.count })).join(' + ');
  return <Shell title={`${title(edge.from)} → ${title(edge.to)}`} sub={`${types} · ${word(edge.satisfied ? '已成立' : '在等')}`}
    onClose={onClose} tr={word} className={s.page}>
    {edge.kinds.includes('declared') && <Sec title={word('手写依赖')}>
      {edge.deps.map((d, i) => <p key={i} className={s.note} data-pd-declared>{d.note || word('手写依赖')}</p>)}
    </Sec>}
    {edge.kinds.includes('task') && <Sec title={pdText(tr, '{n} 条任务依赖', { n: edge.count })}>
      <TaskRows rows={tasks} onTask={onTask} tr={tr} />
    </Sec>}
    {edge.kinds.includes('lock') && <Sec title={word('等文件锁')}>
      <div className={s.lockHead}><LockIcon />{pdText(tr, '{n} 处等文件锁', { n: edge.count })}</div>
      <LockRows rows={locks} onTask={onTask} now={now} tr={tr} />
      {edge.count > locks.length && <p className={s.since}>{pdText(tr, '另有 {n} 处', { n: edge.count - locks.length })}</p>}
    </Sec>}
  </Shell>;
}
