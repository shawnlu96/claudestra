'use client';
import { useState } from 'react';
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
  row: PanelRow; index: number; total: number; now: number; threshold: number; owner: boolean; writable: boolean; observe: boolean; disabledReason: string;
  open: (row: PanelRow) => void; prepare: (row: PanelRow, op: PriorityChange['operation'], band?: PriorityBand) => Promise<void>;
}
export function PriorityRow({ row, index, total, now, threshold, owner, writable, observe, disabledReason, open, prepare }: Props) {
  const [menu, setMenu] = useState(false);
  const state = states[row.state] ?? '数据未知';
  const source = row.priority.source === 'explicit' ? 'owner 显式登记' : row.priority.source === 'feature' ? '继承 feature' : '系统缺省';
  const stalled = row.since !== null && now - row.since > threshold;
  const choose = (op: PriorityChange['operation'], band?: PriorityBand) => { setMenu(false); void prepare(row, op, band); };
  return <article className={s.row} data-state={row.state} data-stalled={stalled}>
    <button type="button" className={s.open} onClick={() => open(row)} title={`${row.title}\nfeature：${row.feature ?? '独立卡'}`}>
      <span className={s.rank}>{index + 1}</span><span><strong>{row.title}</strong>
        <small>{row.taskId ? `${row.taskId} · ${stageWord(row.stage)}` : `计划节点 · 未开卡 · 节点 key：${row.nodeKey}`}</small></span>
    </button>
    <div className={s.state} title={row.reason}><span>{state}</span>{row.reason !== state && <small>{row.reason}</small>}</div>
    <span className={s.duration} title={`当前状态已持续；警示阈值 ${threshold / 3600000} 小时`}>
      {stalled ? '停滞 ' : ''}{duration(row.since, now)}</span>
    <span className={s.source} title={`档位来源：${source} · ${row.feature ?? row.priority.inheritedFrom ?? row.priority.note ?? ''}`}>
      <small>档位来源：</small>{source}</span>
    <span className={s.order}><small>同档顺序：</small>{row.priority.order === null ? '默认' : row.priority.order + 1}</span>
    {owner && <div className={s.actions} aria-label={`${row.title}优先级操作`} title={!writable ? disabledReason : undefined}>
      <button type="button" disabled={!writable} aria-expanded={menu && writable} aria-label={`调整：${row.title}`}
        onClick={() => setMenu(!menu)}>调整</button>
      {menu && writable && <div className={s.menu} role="group" aria-label="调整选项" onKeyDown={e => { if (e.key === 'Escape') setMenu(false); }}>
        {(['now', 'next', 'later'] as const).map(band => <button key={band} type="button"
          onClick={() => choose('set', band)}>{observe ? '记录本会' : ''}{bands[band]}</button>)}
        <button type="button" onClick={() => choose('clear')}>{observe ? '记录本会' : ''}恢复继承</button>
        <button type="button" disabled={index === 0} onClick={() => choose('up')}>{observe ? '记录本会' : ''}前移</button>
        <button type="button" disabled={index === total - 1} onClick={() => choose('down')}>{observe ? '记录本会' : ''}后移</button>
      </div>}
    </div>}
  </article>;
}
