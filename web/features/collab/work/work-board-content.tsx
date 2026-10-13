'use client';
/**
 * 「谁在干活」的纯展示：四栏（在干活 / 在等合并 / 在等 / 待做）、行、手机分段切换。本机吃 /work 的 WorkBoard（work-board-view.tsx 取数，
 * team-work-merge.ts localColumns 把合并相关的行移进「在等合并」）；团队视图吃 team-work-merge.ts 合并命名后的 TeamWorkBoard（team = true）：
 * 主场本机的行就是本机看板的行（计时照常显示，行上带机器名），其余团队行没有开工时间 / 估时 / 轮次，计时、剩余都不显示，
 * 每行带卡的镜像过期 / 阻塞提问（collab-model.ts teamNote）；概览行换成镜像新鲜度，不显示全部做完。
 */
import { useState } from 'react';
import { mirrorCounts, teamNote, type Tr } from '../collab-model';
import { localColumns, localMachine } from './team-work-merge';
import type { TeamBoardRow, TeamWorkBoard, WorkBoard, WorkColumns, WorkRow } from './work-types';
import s from './work-board.module.css';
import { workText } from './work-i18n';

const STAGES: Record<string, string> = { spec: '规格', restate: '复述', build: '写', review: '审', fix: '修',
  merge: '合并', blocked: '被挡' };
/** 团队行的阶段词：上线只有团队镜像会出现在栏里（本机老卡的 stage 照旧原样） */
const teamStage = (stage: string) => stage === 'live' ? '上线' : STAGES[stage] ?? stage;
const STEPS = { restate: '复述', write: '写', review: '审', fix: '修', merge: '合并', deploy: '部署', publishing: '交付中' };
const minutes = (value: number) => value >= 60 ? `${Math.floor(value / 60)}h ${Math.floor(value % 60)}m` : `${Math.floor(value)}m`;
/** Lucide activity / clock / git-merge / list-todo / refresh-cw paths; no emoji or external icon dependency. */
function Icon({ kind, className }: { kind: string; className?: string }) {
  const paths: Record<string, string> = { working: 'M22 12h-4l-3 9L9 3l-3 9H2', waiting: 'M12 8v4l2 2',
    merging: 'M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM6 21V9a9 9 0 0 0 9 9',
    chevron: 'm9 18 6-6-6-6', todo: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', retry: 'M3 12a9 9 0 0 1 15-6l3 3M21 3v6h-6M21 12a9 9 0 0 1-15 6l-3-3M3 21v-6h6' };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    {kind === 'waiting' && <circle cx="12" cy="12" r="10" />}<path d={paths[kind]} />
  </svg>;
}
type Row = TeamBoardRow;
const timed = (row: Row): row is WorkRow => 'since' in row;
/** 四栏的键与标题（手机分段同样四个） */
const LABELS = { working: '在干活', merging: '在等合并', waiting: '在等', todo: '待做' } as const;
type Col = keyof WorkColumns<Row>;

/** 团队概览行：各 feature 的镜像新鲜度（同 v4-props.tsx MirrorSec 的口径：有过期报过期数，全有镜像且新鲜才说最新） */
function mirrorText(board: TeamWorkBoard, tr: Tr) {
  const m = mirrorCounts(board.mirror, board.now);
  return m.stale > 0 ? tr('{n} 个 feature 主场镜像过期', { n: m.stale })
    : m.none === 0 && m.fresh > 0 ? tr('主场镜像最新') : tr('暂无');
}

interface Props {
  board: WorkBoard | TeamWorkBoard | null; retrying: boolean; tr: Tr;
  onNode: (featureId: string, nodeKey: string) => void; onTask: (taskId: string) => void;
  /** 团队数据源：board 是 TeamWorkBoard（加载中为 null 时也要知道是团队，好不显示「全部做完」） */
  team?: boolean;
}
export function WorkBoardContent({ board, retrying, tr, onNode, onTask, team }: Props) {
  const [tab, setTab] = useState('working');
  const t = (word: string) => workText(tr, word);
  const zh = tr('子 DAG') === '子 DAG';
  const open = (row: Row) => {
    if (row.featureId && row.nodeKey) onNode(row.featureId, row.nodeKey);
    else if (row.taskId) onTask(row.taskId);
  };
  const cols: WorkColumns<Row> | null = !board ? null : team ? board as TeamWorkBoard : localColumns(board as WorkBoard);
  const counts = { working: cols?.working.length ?? 0, merging: cols?.merging.length ?? 0, waiting: cols?.waiting.length ?? 0,
    todo: (board?.todo.ready.length ?? 0) + (board?.todo.blocked.length ?? 0) };
  const since = (row: WorkRow) => minutes(Math.max(0, (board!.now - row.since) / 60000));
  // 团队视图的行都带机器名（主场本机换来的本机行也是）；本机看板照旧只写执行者
  const who = (row: Row) => (timed(row) && !team ? row.who : [row.who, row.machine && machine(row.machine)].filter(Boolean).join(' · ') || null);
  const note = (row: Row) => timed(row) ? row.reason && t(row.reason) : [row.reason && t(row.reason), row.team && teamNote({ team: row.team }, board!.now, tr)].filter(Boolean).join(' · ');
  const rowView = (row: Row, mode: string) => <button type="button" key={`${row.featureId}/${row.nodeKey}/${row.taskId}`}
    className={`${s.row} ${mode === 'working' && timed(row) && row.overMinutes > 0 ? s.over : ''}`} onClick={() => open(row)}>
    {who(row) && <div className={s.who} title={!timed(row) && row.instance ? row.instance : undefined}>{who(row)}</div>}
    <div className={s.title}><span className={s.key}>{row.taskId ?? row.nodeKey}</span>{row.title}</div>
    {timed(row) ? <>
      {mode === 'working' && <div className={s.meta}><span>{row.step ? t(STEPS[row.step]) : ''}
        {row.step === 'review' || row.step === 'fix' ? (zh ? `第 ${row.round} 轮` : ` · Round ${row.round}`) : ''}</span>
        <span>{since(row)}</span>
        <span>{row.overMinutes > 0 ? `${zh ? '超出常规' : 'Over usual'} ${minutes(row.overMinutes)}` :
          `${zh ? '预计还要' : 'Remaining'} ${minutes(row.remainingMinutes)}`}</span></div>}
      {row.reason && <div className={s.reason}>{t(row.reason)}</div>}
      {(mode === 'waiting' || mode === 'merging') && <div className={s.meta}>{since(row)}</div>}
      {mode === 'todo' && <div className={s.meta}>{row.estimate || minutes(row.remainingMinutes)}</div>}
    </> : <>
      {row.stage && mode !== 'merging' && <div className={s.meta}><span>{t(teamStage(row.stage))}</span></div>}
      {note(row) && <div className={s.reason}>{note(row)}</div>}
    </>}
  </button>;
  // 机器名原样，只有本机看板的 local 写「本机」；团队看板的键已由 team-work-merge.ts 命名
  function machine(m: string) { return t(team ? m : localMachine(m)); }
  const local = team ? null : board as WorkBoard | null, shared = team ? board as TeamWorkBoard | null : null;
  return <div className={s.board} data-work-board={team ? 'team' : 'local'}>
    <div className={s.summary}>{Object.entries(LABELS).map(([key, label]) => <span key={key}>{t(label)} <strong>{counts[key as keyof typeof counts]}</strong></span>)}
      {!team && <span>{t('全部做完预计')} <strong>{local ? local.completionHours === null ? t('名额不可用') : `${local.completionHours}h` : '—'}</strong></span>}
      {retrying && <span role="status" aria-label={tr('没取到，正在重试')} title={tr('没取到，正在重试')}><Icon kind="retry" className={s.retry} /></span>}
    </div>
    <div className={s.basis}>{board && Object.entries(board.machines).map(([m, count]) => `${machine(m)} ${count}`).join(' / ')}
      {local && <>{' · '}{t('按近 7 天每步中位数 + 关键路径')}</>}
      {shared && <>{Object.keys(shared.machines).length ? ' · ' : ''}{tr('镜像')} · {mirrorText(shared, tr)}</>}</div>
    <div className={s.segment} role="tablist">{Object.entries(LABELS).map(([key, label]) => <button type="button" role="tab"
      aria-selected={tab === key} key={key} onClick={() => setTab(key)}>{t(label)} {counts[key as keyof typeof counts]}</button>)}</div>
    <div className={s.columns}>{Object.entries(LABELS).map(([key, label]) => <section key={key} className={s.column} data-active={tab === key}>
      <h3 className={s.heading}><Icon kind={key} />{t(label)}<span className={s.count}>{counts[key as keyof typeof counts]}</span></h3>
      {!board ? <div className={s.loading} /> : key === 'todo' ? <>{(['ready', 'blocked'] as const).map(group => <div key={group}>
        <div className={s.group}>{t(group === 'ready' ? '就绪可开' : '被挡')} · {board.todo[group].length}</div>
        {board.todo[group].map((row: Row) => rowView(row, key))}</div>)}</> : cols![key as Col].length ?
        cols![key as Col].map((row: Row) => rowView(row, key)) : <div className={s.empty}>{t('暂无')}</div>}
    </section>)}</div>
    {!!local?.legacy?.length && <details className={s.legacy}>
      <summary className={s.group}><Icon kind="chevron" />{t('老卡')} · {local.legacyTotal ?? local.legacy.length}</summary>
      {local.legacy.map(row => <button type="button" className={s.row} key={row.taskId} onClick={() => onTask(row.taskId)}>
        <div className={s.title}><span className={s.key}>{row.taskId}</span>{row.title}</div>
        <div className={s.meta}>{t(STAGES[row.stage] ?? row.stage)}</div>
      </button>)}
    </details>}
  </div>;
}
