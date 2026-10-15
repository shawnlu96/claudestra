'use client';
import type { PanelRow, PriorityBand, PriorityChange } from '@/lib/api/priority';
import { stageWord } from '@/lib/owner-words';
import s from './priority-panel.module.css';
const bands: Record<PriorityBand, string> = { now: '现在做', next: '接着做', later: '可以拖' };
const states: Record<string, string> = { dependency: '等待依赖', capacity: '等容量', owner: '等 owner', uncertain: '结果不明', unknown: '数据未知',
  working: '执行中', waiting: '等待中', ready: '待开工' };
function duration(since: number | null, now: number): string {
  if (since === null) return '时长未知';
  const mins = Math.floor(Math.max(0, now - since) / 60000);
  return mins >= 1440 ? `${Math.floor(mins / 1440)} 天 ${Math.floor(mins % 1440 / 60)} 小时` : mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`;
}
interface Props {
  row: PanelRow; index: number; total: number; now: number; owner: boolean; writable: boolean; observe: boolean;
  open: (row: PanelRow) => void; prepare: (row: PanelRow, op: PriorityChange['operation'], band?: PriorityBand) => Promise<void>;
}
export function PriorityRow({ row, index, total, now, owner, writable, observe, open, prepare }: Props) {
  return <article className={s.row} data-state={row.state}>
    <button type="button" className={s.open} onClick={() => open(row)}><span className={s.rank}>{index + 1}</span>
      <span><strong>{row.title}</strong><small>{row.taskId ?? row.nodeKey} · {row.feature ?? '独立卡'} · {row.stage === 'planned' ? '未绑卡计划' : stageWord(row.stage)}</small></span>
      <span aria-hidden>›</span></button>
    <div className={s.facts}><span className={s.state}>{states[row.state] ?? '数据未知'}</span><span>{row.reason}</span>
      <span>当前状态已持续 {duration(row.since, now)}</span>
      <span>档位来源：{row.priority.source === 'explicit' ? 'owner 显式登记' : row.priority.source === 'feature' ? `继承 feature · ${row.feature ?? row.priority.inheritedFrom}` : '系统缺省、owner 未登记'}</span>
      <span>同档顺序：{row.priority.order === null ? '默认顺序' : row.priority.order + 1}</span><span>升级：{row.escalation}</span></div>
    {owner && <div className={s.actions} aria-label={`${row.title}优先级操作`}>
      {(['now', 'next', 'later'] as const).map(band => <button key={band} type="button" disabled={!writable}
        onClick={() => void prepare(row, 'set', band)}>{observe ? '记录本会' : '改为'}{bands[band]}</button>)}
      <button type="button" disabled={!writable} onClick={() => void prepare(row, 'clear')}>{observe ? '记录本会恢复继承' : '恢复继承'}</button>
      <button type="button" disabled={!writable || index === 0} onClick={() => void prepare(row, 'up')}>{observe ? '记录本会前移' : '前移'}</button>
      <button type="button" disabled={!writable || index === total - 1} onClick={() => void prepare(row, 'down')}>{observe ? '记录本会后移' : '后移'}</button>
    </div>}
  </article>;
}
