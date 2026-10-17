'use client';
import { useState } from 'react';
import type { PanelRow, PriorityBand, PriorityChange } from '@/lib/api/priority';
import { ownerWordsTr, prioritySystemText, PRIORITY_WORDS as W, stageWord } from '@/lib/owner-words';
import { useLang } from '@/lib/i18n';
import s from './priority-panel.module.css';
const bands: Record<PriorityBand, string> = { now: W.now, next: W.next, later: W.later };
const states: Record<string, string> = { dependency: W.dependency, capacity: W.capacity, owner: W.owner, uncertain: W.uncertain, unknown: W.unknown,
  working: W.working, waiting: W.waiting, ready: W.ready };
function duration(since: number | null, now: number, tr: ReturnType<typeof ownerWordsTr>): string {
  if (since === null) return tr(W.durationUnknown);
  const mins = Math.floor(Math.max(0, now - since) / 60000);
  return mins >= 1440 ? tr(W.durationDays, { d: Math.floor(mins / 1440), h: Math.floor(mins % 1440 / 60) })
    : mins >= 60 ? tr(W.durationHours, { h: Math.floor(mins / 60), m: mins % 60 }) : tr(W.durationMinutes, { m: mins });
}
interface Props {
  row: PanelRow; index: number; total: number; now: number; threshold: number; owner: boolean; writable: boolean; observe: boolean; disabledReason: string;
  open: (row: PanelRow) => void; prepare: (row: PanelRow, op: PriorityChange['operation'], band?: PriorityBand) => Promise<void>;
}
export function PriorityRow({ row, index, total, now, threshold, owner, writable, observe, disabledReason, open, prepare }: Props) {
  const language = useLang(), tr = ownerWordsTr(language);
  const [menu, setMenu] = useState(false);
  const state = tr(states[row.state] ?? W.unknown);
  const source = tr(row.priority.source === 'explicit' ? W.sourceExplicit : row.priority.source === 'feature' ? W.sourceModule : W.sourceSystem);
  const reason = prioritySystemText(row.reason, states[row.state] ?? W.unknown, language);
  const module = row.feature ?? row.priority.inheritedFrom ?? (row.featureId || (row.priority.source === 'feature' ? tr(W.unnamedModule) : tr(W.noModule)));
  const note = row.priority.source === 'system' ? prioritySystemText(row.priority.note ?? '', W.sourceSystem, language) : row.priority.note;
  const sourceDetail = [module, note].filter(Boolean).join(' · ');
  const stalled = row.since !== null && now - row.since > threshold;
  const choose = (op: PriorityChange['operation'], band?: PriorityBand) => { setMenu(false); void prepare(row, op, band); };
  return <article className={s.row} data-state={row.state} data-stalled={stalled}>
    <button type="button" className={s.open} onClick={() => open(row)} title={tr(W.moduleTitle, { title: row.title, module })}>
      <span className={s.rank}>{index + 1}</span><span><strong>{row.title}</strong>
        <small>{row.taskId ? `${row.taskId} · ${tr(stageWord(row.stage))}` : tr(W.plannedNode, { key: row.nodeKey ?? '' })}</small></span>
    </button>
    <div className={s.state} title={reason}><span>{state}</span>{reason !== state && <small>{reason}</small>}</div>
    <span className={s.duration} title={tr(W.durationTitle, { h: threshold / 3600000 })}>
      {stalled ? tr(W.stalled) : ''}{duration(row.since, now, tr)}</span>
    <span className={s.source} title={tr(W.sourceTitle, { source, module: sourceDetail })}>
      <small>{tr(W.sourceLabel)}</small>{source}</span>
    <span className={s.order}><small>{tr(W.order)}</small>{row.priority.order === null ? tr(W.defaultOrder) : row.priority.order + 1}</span>
    {owner && <div className={s.actions} aria-label={tr(W.actions, { title: row.title })} title={!writable ? disabledReason : undefined}>
      <button type="button" disabled={!writable} aria-expanded={menu && writable} aria-label={tr(W.adjustTitle, { title: row.title })}
        onClick={() => setMenu(!menu)}>{tr(W.adjust)}</button>
      {menu && writable && <div className={s.menu} role="group" aria-label={tr(W.options)} onKeyDown={e => { if (e.key === 'Escape') setMenu(false); }}>
        {(['now', 'next', 'later'] as const).map(band => <button key={band} type="button"
          onClick={() => choose('set', band)}>{observe ? tr(W.record) : ''}{tr(bands[band])}</button>)}
        <button type="button" onClick={() => choose('clear')}>{observe ? tr(W.record) : ''}{tr(W.inherit)}</button>
        <button type="button" disabled={index === 0} onClick={() => choose('up')}>{observe ? tr(W.record) : ''}{tr(W.up)}</button>
        <button type="button" disabled={index === total - 1} onClick={() => choose('down')}>{observe ? tr(W.record) : ''}{tr(W.down)}</button>
      </div>}
    </div>}
  </article>;
}
