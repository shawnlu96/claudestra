'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assertExecView, type ExecTransport, type ExecView } from '../../../../lib/api/shared-ledger-v2';
import { sharedExecTr } from '../../../../lib/i18n-dict-shared-ledger-v2';
import { TaskEditor } from '../task/task-forms';
import { createDraft, editDraft, isDataStale, type TaskCapabilities, type TaskDraft } from '../task/task-model';
import { ApprovalPanel } from '../approve/approve-panel';
import type { ApprovalView, ApprovalSubmission } from '../approve/approve-model';
import { ExecSubmission, type ExecContext, type ExecPort } from './exec-model';
import { Icon } from '../../collab-icons';
import s from '../shared.module.css';
import c from '../../collab.module.css';

export interface ExecPanelProps {
  featureId: string; taskId: string | null; context: ExecContext; transport: ExecTransport; port: ExecPort;
  now: number; language: 'zh' | 'en';
}
function useExecPanel(p: ExecPanelProps) {
  const tr = sharedExecTr(p.language);
  const submission = useMemo(() => new ExecSubmission(p.transport), [p.transport]);
  const controllerRef = useRef<AbortController | null>(null);
  const lastSeq = useRef(-1);
  const [view, setView] = useState<ExecView | null>(null), [observedAt, setObservedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null), [approval, setApproval] = useState<ApprovalView | null>(null);
  const [atomicPending, setAtomicPending] = useState<ApprovalSubmission | null>(null);
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false), [saved, setSaved] = useState(false);
  const load = async (ctrl = controllerRef.current!) => {
    try {
      const next = assertExecView(await p.transport.snapshot(p.featureId, ctrl.signal), p.context.scope, p.featureId);
      if (ctrl.signal.aborted) return;
      if (lastSeq.current > next.serverSeq) throw new Error('stale_snapshot');
      lastSeq.current = next.serverSeq; setView(next);
      setObservedAt(Date.now()); setError(null);
    } catch (cause) {
      if (!ctrl.signal.aborted) setError('执行数据暂不可用'); // Keep the last snapshot and the unsaved editor on a failed refresh.
    }
  };
  useEffect(() => {
    const ctrl = new AbortController(); controllerRef.current = ctrl;
    void load(ctrl); return () => ctrl.abort();
  }, [p.transport]);
  const stale = isDataStale(observedAt, p.now);
  const blocked = pending || stale || p.context.mode !== 'on';
  const caps = Object.fromEntries(['task.new', 'task.set', 'task.spec'].map(action => {
    const cap = view?.capabilities[action] ?? { enabled: false, code: 'unavailable', reason: tr('尚未接线') };
    return [action, { ...cap, enabled: cap.enabled && !blocked }];
  })) as TaskCapabilities;
  const submit = async (command: Parameters<ExecSubmission['submit']>[0]) => {
    const ctrl = controllerRef.current!;
    if (blocked || !view?.capabilities[command.type]?.enabled) return { ok: false as const, code: 'execution_not_shared' };
    const result = await submission.submit(command, ctrl.signal);
    if (!ctrl.signal.aborted) { setPending(!!submission.pending); if (result.ok) { setSaved(true); void load(); } }
    return result;
  };
  const receipt = async () => {
    const ctrl = controllerRef.current!;
    try {
      const committed = atomicPending
        ? (await p.port.receiptApproval?.(atomicPending, ctrl.signal))?.ok === true
        : await submission.receipt(ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (committed) setAtomicPending(null);
      setPending(!committed && (!!atomicPending || !!submission.pending)); setError(committed ? null : '未查到回执，保留草稿');
      if (committed) { setSaved(true); setDraft(null); setApproval(null); void load(); }
    } catch (cause) {
      if (!ctrl.signal.aborted) setError('未查到回执，保留草稿'); // Failed reads never clear or resubmit an ambiguous write.
    }
  };
  const openApproval = async (askId: string) => {
    const ctrl = controllerRef.current!;
    try {
      const full = p.port.approvalView ? await p.port.approvalView(askId, ctrl.signal) : null;
      const ask = full?.ask ?? await p.transport.ask(askId, ctrl.signal);
      if (!view || ask.id !== askId || ask.featureId !== view.feature.id) throw new Error('invalid_snapshot');
      const task = view.tasks.find(t => t.id === ask.taskId);
      if (!ctrl.signal.aborted) setApproval(full ?? { ask, feature: { ...view.feature }, proposal: null,
        task: task ? { rev: task.rev, specRev: task.specRev } : null,
        document: task ? { summary: task.spec.summary, originalDigest: task.spec.originalDigest, copy: null } : null });
    } catch (cause) {
      if (!ctrl.signal.aborted) setError('执行数据暂不可用'); // Never present an unverified ask under a different feature.
    }
  };
  const approve = async (commands: ApprovalSubmission) => {
    const ctrl = controllerRef.current!;
    if (blocked || !view?.capabilities['ask.answer']?.enabled) return { ok: false as const, code: 'execution_not_shared' };
    // Scope decisions require the atomic composition port; never split them into two writes.
    if (commands.decide) {
      if (!p.port.submitApproval || !view.capabilities['dag.decide']?.enabled) return { ok: false as const, code: 'v2_unmapped' };
      try {
        const result = await p.port.submitApproval(commands, ctrl.signal);
        if (!result.ok && ['unknown', 'unavailable'].includes(result.code)) {
          setAtomicPending(commands); setPending(true); return { ok: false as const, code: 'unknown' };
        }
        return result;
      } catch (cause) {
        // The atomic port may have committed before losing its response; only its receipt port can resolve this.
        setAtomicPending(commands); setPending(true); return { ok: false as const, code: 'unknown' };
      }
    }
    return submit(commands.answer);
  };
  return { tr, view, stale, blocked, caps, draft, approval, error, pending, saved, observedAt, load, submit, receipt,
    openApproval, approve, setDraft, setSaved, setApproval };
}
export function ExecPanel(p: ExecPanelProps) {
  const { tr, view, stale, blocked, caps, draft, approval, error, pending, saved, observedAt, load, submit, receipt,
    openApproval, approve, setDraft, setSaved, setApproval } = useExecPanel(p);
  if (!view) return <section className={s.line} role="status">{tr('执行数据暂不可用')}</section>;
  const tasks = p.taskId ? view.tasks.filter(t => t.id === p.taskId) : view.tasks;
  return <section aria-label={tr('共享执行')}>
    <div className={s.head}>{tr('共享执行')}</div>
    <div className={s.line}><span>{tr('主场')} · {p.context.instanceNames[view.feature.homeInstanceId] ?? view.feature.homeInstanceId}</span>
      <span>{tr('中心 serverSeq')} · {view.serverSeq}</span>
      <button className={c.btn} type="button" onClick={() => void load()}><Icon name="rotateCcw" /> {tr('刷新')}</button></div>
    {stale && <div role="status" className={s.conflict}>{tr('数据已过期，请刷新')}</div>}
    {error && <div role="alert" className={s.line}>{tr(error)}</div>}
    {pending && <div role="status" className={s.conflict}>{tr('提交状态未知，请查回执')}
      <button className={c.btn} type="button" onClick={() => void receipt()}>{tr('查询回执')}</button></div>}
    {saved && <div role="status">{tr('已保存')}</div>}
    <div className={s.actions}><button className={c.btn} type="button" disabled={!caps['task.new'].enabled || !!draft} title={caps['task.new'].reason}
      onClick={() => { setSaved(false); setDraft(createDraft(view.feature, p.context.repository)); }}><Icon name="plus" /> {tr('开卡')}</button></div>
    {tasks.map(t => <div key={t.id} className={s.line}><span>{t.title}</span>
      <span>{tr('执行地')} · {t.executorInstanceId ? p.context.instanceNames[t.executorInstanceId] ?? t.executorInstanceId : '—'}</span>
      <button className={c.btn} type="button" disabled={blocked || !!draft || !caps[t.stage === 'spec' ? 'task.set' : 'task.spec'].enabled}
        onClick={() => { setSaved(false); setDraft(editDraft(t)); }}>{tr('编辑')}</button></div>)}
    {draft && <TaskEditor initialDraft={draft} capabilities={caps} scope={p.context.scope} instanceNames={p.context.instanceNames}
      observedAt={observedAt} now={p.now} submit={submit} onClose={() => setDraft(null)} tr={tr} />}
    {view.pendingAsks.filter(a => !p.taskId || a.taskId === p.taskId).map(a => <div className={s.line} key={a.id}>
      <span>{a.title}</span><button className={c.btn} type="button" disabled={pending} onClick={() => void openApproval(a.id)}>{tr('审批')}</button></div>)}
    {approval && <ApprovalPanel view={approval} viewer={blocked || !view.capabilities['ask.answer']?.enabled
      ? { ...p.context.viewer, role: 'member' } : p.context.viewer} scope={p.context.scope} now={p.now}
      instanceNames={p.context.instanceNames} submit={approve} onClose={() => setApproval(null)} tr={tr} />}
  </section>;
}
