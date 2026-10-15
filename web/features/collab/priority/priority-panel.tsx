'use client';
import { useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { answerAskCard } from '@/lib/api/asks';
import { fetchPriorityHistory, priorityResult, requestPriority, type PanelRow, type PriorityBand, type PriorityChange,
  type PriorityHistoryEntry, type PrioritySnapshot } from '@/lib/api/priority';
import { PriorityRow } from './priority-row';
import s from './priority-panel.module.css';

const modes = { off: '已关闭', observe: '观察中', on: '已启用' };
type Prepared = { askId: string; label: string; choice: string; change: PriorityChange };
export interface PriorityPanelProps {
  project: string | null; now: number; data: PrioritySnapshot | null; error: string; stale: boolean; reload: () => Promise<void>;
  onNode: (feature: string, node: string) => void; onTask: (task: string) => void;
}
export function PriorityPanel({ project, now, data, error, stale, reload, onNode, onTask }: PriorityPanelProps) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [words, setWords] = useState('');
  const [history, setHistory] = useState<PriorityHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const off = data?.modes.priorityPanel.mode === 'off';
  if (off) return null;
  const writable = !!project && !!data?.canWrite && !stale && !error && !busy;
  const observe = data?.modes.priorityPanel.mode === 'observe';
  const showError = (e: unknown) => {
    setNotice(e instanceof ApiError && e.status === 409 ? `版本冲突或快照过期，请刷新：${e.message}` : e instanceof Error ? e.message : '操作失败，请刷新核对');
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
      if (!result.verified) throw new Error('命令已处理，但当前读回不一致，请刷新核对');
      await reload();
      setNotice(result.observed ? '已记录本会调整，业务档位与顺序未变。' : '已应用，服务端读回一致。');
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
  return <section className={s.panel} aria-label="当前现在做" data-priority-panel>
    <header className={s.header}><div><h2>当前现在做</h2><p>有效 now · 未完成卡与未绑卡计划 · 本机项目队列</p></div>
      <div className={s.tools}>{data && <span className={s.mode}>{modes[data.modes.priorityPanel.mode]}</span>}
        <button type="button" onClick={() => void reload()} disabled={busy}>刷新</button>
        <button type="button" onClick={() => void toggleHistory()} aria-expanded={historyOpen}>优先级历史</button></div></header>
    {data && <div className={s.switches}><span>排序配置：{modes[data.modes.prioritySort.mode]}</span>
      <span>开工配置：{modes[data.modes.priorityNowStart.mode]}</span><span>升级：尚未启用（配置{modes[data.modes.priorityStall.mode]}）</span>
      <span>登记 now 不代表机制已生效</span></div>}
    {observe && <p className={s.info}>观察中：只读展示。owner 可记录「本会调整」，不会应用调档或排序。</p>}
    {(error || stale) && <p role="alert" className={s.warning}>{data ? '旧快照已过期，操作已停用。' : '无法确认 now 工作，请重试。'} {error}</p>}
    {!project && <p className={s.warning}>当前团队未绑定本机项目，优先级数据未知。</p>}
    {project && !data && !error && <div className={s.loading} role="status">正在读取 now 工作…</div>}
    {data && !stale && !error && data.rows.length === 0 && <p className={s.empty}>当前没有有效 now 工作。已完成卡仍可在原卡与优先级历史查询。</p>}
    <div className={s.rows}>{data?.rows.map((row, index) => <PriorityRow key={row.key} row={row} index={index} total={data.rows.length}
      now={now} owner={data.canWrite} writable={writable} observe={observe} open={open} prepare={prepare} />)}</div>
    {prepared && <div className={s.confirm} role="group" aria-label="确认优先级请求"><strong>{prepared.label}</strong>
      <p>目标：{prepared.change.target.id}{'nodeKey' in prepared.change.target ? ` / ${prepared.change.target.nodeKey}` : ''} · 版本 {prepared.change.rev}</p>
      <label>补充原话（可选）<input value={words} onChange={e => setWords(e.target.value)} maxLength={600} disabled={busy} /></label>
      <button type="button" disabled={!writable} onClick={() => void confirm()}>确认{observe ? '记录' : '应用'}</button>
      <button type="button" disabled={busy} onClick={() => setPrepared(null)}>收起</button></div>}
    {notice && <p role="status" className={s.info}>{notice}</p>}
    {historyOpen && <div className={s.history} aria-label="优先级历史">{history === null ? '正在读取历史…' : history.length ? history.slice(-40).reverse().map(e => <p key={e.seq}>
      <time>{new Date(e.ts).toLocaleString()}</time> · {e.actor} · {e.text || e.data.ownerWords || e.data.op}</p>) : '暂无优先级历史'}</div>}
  </section>;
}
