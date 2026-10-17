'use client';
import { useCallback, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { answerAskCard } from '@/lib/api/asks';
import { fetchPriorityHistory, priorityResult, requestPriority, type PanelRow, type PriorityBand, type PriorityChange,
  type PriorityHistoryEntry, type PrioritySnapshot } from '@/lib/api/priority';
import { ownerWordsTr, PRIORITY_WORDS as W } from '@/lib/owner-words';
import { useLang } from '@/lib/i18n';
import { PriorityRow } from './priority-row';
import s from './priority-panel.module.css';

const modes = { off: W.off, observe: W.observe, on: W.on };
const expandedPages = new Map<string, boolean>();
type Prepared = { askId: string; label: string; choice: string; change: PriorityChange };
export interface PriorityPanelProps {
  project: string | null; now: number; data: PrioritySnapshot | null; error: string; stale: boolean; reload: () => Promise<void>;
  onNode: (feature: string, node: string) => void; onTask: (task: string) => void;
}
export function PriorityPanel({ project, now, data, error, stale, reload, onNode, onTask }: PriorityPanelProps) {
  const tr = ownerWordsTr(useLang());
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [words, setWords] = useState('');
  const [history, setHistory] = useState<PriorityHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const rememberOpen = useCallback((element: HTMLDetailsElement | null) => {
    if (!element) return;
    const key = `priority-panel:${location.pathname}:${project}`;
    try { element.open = sessionStorage.getItem(key) === 'open'; }
    catch { element.open = expandedPages.get(key) ?? false; } // Restricted storage still remembers within this page session.
  }, [project]);
  const off = data?.modes.priorityPanel.mode === 'off';
  if (off) return null;
  const writable = !!project && !!data?.canWrite && !stale && !error && !busy;
  const observe = data?.modes.priorityPanel.mode === 'observe';
  const showError = (e: unknown) => {
    setNotice(e instanceof ApiError && e.status === 409 ? W.versionChanged : e instanceof Error ? e.message : W.failed);
  };
  const open = (row: PanelRow) => {
    if (row.taskId) onTask(row.taskId);
    else if (row.featureId && row.nodeKey) onNode(row.featureId, row.nodeKey);
  };
  const prepare = async (row: PanelRow, operation: PriorityChange['operation'], band?: PriorityBand) => {
    if (!writable || !project || !data) return;
    setBusy(true); setNotice(''); setPrepared(null);
    const change: PriorityChange = { target: row.target, rev: row.priority.rev, operation, band, snapshot: data.version, observedAt: data.now };
    try { const got = await requestPriority(project, change); setPrepared({ ...got, change }); setWords(''); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!prepared || !project || !writable) return;
    setBusy(true); setNotice('');
    try {
      await answerAskCard(project, prepared.askId, { choices: [prepared.choice], text: words });
      const result = await priorityResult(project, prepared.askId);
      if (!result.verified) throw new Error(W.readbackFailed);
      await reload();
      setNotice(result.observed ? W.recorded : W.applied);
      setPrepared(null);
    } catch (e) { showError(e); setPrepared(null); }
    finally { setBusy(false); }
  };
  const toggleHistory = async () => {
    if (historyOpen) { setHistoryOpen(false); return; }
    setHistoryOpen(true);
    if (!project) return;
    try { setHistory((await fetchPriorityHistory(project)).history); }
    catch (e) { showError(e); }
  };
  return <section className={s.panel} aria-label={tr(W.heading)} data-priority-panel>
    <details ref={rememberOpen} onToggle={e => {
      const key = `priority-panel:${location.pathname}:${project}`, expanded = e.currentTarget.open;
      expandedPages.set(key, expanded);
      try { sessionStorage.setItem(key, expanded ? 'open' : 'closed'); }
      catch { /* Storage can be restricted; the page-session map retains the user's choice. */ }
    }}>
      <summary className={s.header}>
        <h2>{tr(W.heading)} {data ? tr(W.count, { n: data.rows.length }) : tr(W.noData)}</h2>
        {data && <><span className={s.mode}>{tr(modes[data.modes.priorityPanel.mode])}</span>
          <span className={s.switches}>{tr(W.switches, { sort: tr(modes[data.modes.prioritySort.mode]),
            start: tr(modes[data.modes.priorityNowStart.mode]), stall: tr(modes[data.modes.priorityStall.mode]) })}</span></>}
        {(error || stale) && <span className={s.stale}>{data ? tr(W.stale) : tr(W.readFailed)}</span>}
        <span className={s.expand}><span>{tr(W.expand)}</span><span>{tr(W.collapse)}</span><span aria-hidden>⌄</span></span>
      </summary>
      <div className={s.tools}>
        <span>{tr(W.mechanism)}</span>
        <button type="button" onClick={() => void reload()} disabled={busy}>{tr(W.refresh)}</button>
        <button type="button" onClick={() => void toggleHistory()} aria-expanded={historyOpen}>{tr(W.history)}</button>
      </div>
    {observe && <p className={s.info}>{tr(W.observeInfo)}</p>}
    {(error || stale) && <p role="alert" className={s.warning}>{data ? tr(W.expired) : tr(W.retry)} {error}</p>}
    {!project && <p className={s.warning}>{tr(W.unbound)}</p>}
    {project && !data && !error && <div className={s.loading} role="status">{tr(W.loading)}</div>}
    {data && !stale && !error && data.rows.length === 0 && <p className={s.empty}>{tr(W.empty)}</p>}
    <div className={s.rows}>{data?.rows.map((row, index) => <PriorityRow key={row.key} row={row} index={index} total={data.rows.length}
      now={now} threshold={data.stallThresholdMs}
      disabledReason={stale || error ? tr(W.expiredRetry) : busy ? tr(W.busy) : tr(W.unavailable)}
      owner={data.canWrite} writable={writable} observe={observe} open={open} prepare={prepare} />)}</div>
    {prepared && <div className={s.confirm} role="group" aria-label={tr(W.confirmRequest)}><strong>{prepared.label}</strong>
      <p>{tr(W.target, { id: prepared.change.target.id + ('nodeKey' in prepared.change.target ? ` / ${prepared.change.target.nodeKey}` : ''), rev: prepared.change.rev })}</p>
      <label>{tr(W.extra)}<input value={words} onChange={e => setWords(e.target.value)} maxLength={600} disabled={busy} /></label>
      <button type="button" disabled={!writable} onClick={() => void confirm()}>{tr(observe ? W.confirmRecord : W.confirmApply)}</button>
      <button type="button" disabled={busy} onClick={() => setPrepared(null)}>{tr(W.collapse)}</button></div>}
    {notice && <p role="status" className={s.info}>{tr(notice)}</p>}
    {historyOpen && <div className={s.history} aria-label={tr(W.history)}>{history === null ? tr(W.loadingHistory) : history.length ? history.slice(-40).reverse().map(e => <p key={e.seq}>
      <time>{new Date(e.ts).toLocaleString()}</time> · {e.actor} · {e.text || e.data.ownerWords || e.data.op}</p>) : tr(W.noHistory)}</div>}
    </details>
  </section>;
}
