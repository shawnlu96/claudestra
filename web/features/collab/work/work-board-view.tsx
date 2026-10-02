'use client';
import { useState } from 'react';
import type { Tr } from '../collab-model';
import { useWorkBoard } from './use-work-board';
import type { WorkBoard, WorkRow } from './work-types';
import s from './work-board.module.css';
import { workText } from './work-i18n';

const STAGES: Record<string, string> = { spec: '规格', restate: '复述', build: '写', review: '审', fix: '修',
  merge: '合并', blocked: '被挡' };
const STEPS = { restate: '复述', write: '写', review: '审', fix: '修', merge: '合并', deploy: '部署', publishing: '交付中' };
const minutes = (value: number) => value >= 60 ? `${Math.floor(value / 60)}h ${Math.floor(value % 60)}m` : `${Math.floor(value)}m`;
/** Lucide activity / clock / list-todo / refresh-cw paths; no emoji or external icon dependency. */
function Icon({ kind, className }: { kind: string; className?: string }) {
  const paths: Record<string, string> = { working: 'M22 12h-4l-3 9L9 3l-3 9H2', waiting: 'M12 8v4l2 2',
    chevron: 'm9 18 6-6-6-6', todo: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', retry: 'M3 12a9 9 0 0 1 15-6l3 3M21 3v6h-6M21 12a9 9 0 0 1-15 6l-3-3M3 21v-6h6' };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    {kind === 'waiting' && <circle cx="12" cy="12" r="10" />}<path d={paths[kind]} />
  </svg>;
}
interface Props { project: string; tr: Tr; onNode: (featureId: string, nodeKey: string) => void; onTask: (taskId: string) => void }
export function WorkBoardView(props: Props) {
  const load = useWorkBoard(props.project);
  return <WorkBoardContent {...props} board={load.board} retrying={load.retrying} />;
}
export function WorkBoardContent({ board, retrying, tr, onNode, onTask }: Omit<Props, 'project'> & { board: WorkBoard | null; retrying: boolean }) {
  const [tab, setTab] = useState('working');
  const t = (word: string) => workText(tr, word);
  const open = (row: WorkRow) => {
    if (row.featureId && row.nodeKey) onNode(row.featureId, row.nodeKey);
    else if (row.taskId) onTask(row.taskId);
  };
  const labels = { working: '在干活', waiting: '在等', todo: '待做' };
  const counts = { working: board?.working.length ?? 0, waiting: board?.waiting.length ?? 0,
    todo: (board?.todo.ready.length ?? 0) + (board?.todo.blocked.length ?? 0) };
  const rowView = (row: WorkRow, mode: string) => <button type="button" key={`${row.featureId}/${row.nodeKey}/${row.taskId}`}
    className={`${s.row} ${mode === 'working' && row.overMinutes > 0 ? s.over : ''}`} onClick={() => open(row)}>
    {row.who && <div className={s.who}>{row.who}</div>}
    <div className={s.title}><span className={s.key}>{row.taskId ?? row.nodeKey}</span>{row.title}</div>
    {mode === 'working' && <div className={s.meta}><span>{row.step ? t(STEPS[row.step]) : ''}
      {row.step === 'review' || row.step === 'fix' ? (tr('子 DAG') === '子 DAG' ? `第 ${row.round} 轮` : ` · Round ${row.round}`) : ''}</span>
      <span>{minutes(Math.max(0, (board!.now - row.since) / 60000))}</span>
      <span>{row.overMinutes > 0 ? `${tr('子 DAG') === '子 DAG' ? '超出常规' : 'Over usual'} ${minutes(row.overMinutes)}` :
        `${tr('子 DAG') === '子 DAG' ? '预计还要' : 'Remaining'} ${minutes(row.remainingMinutes)}`}</span></div>}
    {row.reason && <div className={s.reason}>{t(row.reason)}</div>}
    {mode === 'waiting' && <div className={s.meta}>{minutes(Math.max(0, (board!.now - row.since) / 60000))}</div>}
    {mode === 'todo' && <div className={s.meta}>{row.estimate || minutes(row.remainingMinutes)}</div>}
  </button>;
  return <div className={s.board}>
    <div className={s.summary}>{Object.entries(labels).map(([key, label]) => <span key={key}>{t(label)} <strong>{counts[key as keyof typeof counts]}</strong></span>)}
      <span>{t('全部做完预计')} <strong>{board ? board.completionHours === null ? t('名额不可用') : `${board.completionHours}h` : '—'}</strong></span>
      {retrying && <span role="status" aria-label={tr('没取到，正在重试')} title={tr('没取到，正在重试')}><Icon kind="retry" className={s.retry} /></span>}
    </div>
    <div className={s.basis}>{board && Object.entries(board.machines).map(([machine, count]) => {
      const name = machine === 'local' ? t('本机') : machine === 'Sekai' ? '孟总' : machine === 'HedeMacBook-Pro' ? 'He' : machine;
      return `${name} ${count}`;
    }).join(' / ')}
      {' · '}{t('按近 7 天每步中位数 + 关键路径')}</div>
    <div className={s.segment} role="tablist">{Object.entries(labels).map(([key, label]) => <button type="button" role="tab"
      aria-selected={tab === key} key={key} onClick={() => setTab(key)}>{t(label)} {counts[key as keyof typeof counts]}</button>)}</div>
    <div className={s.columns}>{Object.entries(labels).map(([key, label]) => <section key={key} className={s.column} data-active={tab === key}>
      <h3 className={s.heading}><Icon kind={key} />{t(label)}<span className={s.count}>{counts[key as keyof typeof counts]}</span></h3>
      {!board ? <div className={s.loading} /> : key === 'todo' ? <>{(['ready', 'blocked'] as const).map(group => <div key={group}>
        <div className={s.group}>{t(group === 'ready' ? '就绪可开' : '被挡')} · {board.todo[group].length}</div>
        {board.todo[group].map(row => rowView(row, key))}</div>)}</> : board[key as 'working' | 'waiting'].length ?
        board[key as 'working' | 'waiting'].map(row => rowView(row, key)) : <div className={s.empty}>{t('暂无')}</div>}
    </section>)}</div>
    {!!board?.legacy?.length && <details className={s.legacy}>
      <summary className={s.group}><Icon kind="chevron" />{t('老卡')} · {board.legacyTotal ?? board.legacy.length}</summary>
      {board.legacy.map(row => <button type="button" className={s.row} key={row.taskId} onClick={() => onTask(row.taskId)}>
        <div className={s.title}><span className={s.key}>{row.taskId}</span>{row.title}</div>
        <div className={s.meta}>{t(STAGES[row.stage] ?? row.stage)}</div>
      </button>)}
    </details>}
  </div>;
}
