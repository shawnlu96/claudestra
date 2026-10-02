'use client';
import { useState, type FormEvent } from 'react';
import { Icon } from '../../collab-icons';
import shared from '../shared.module.css';
import s from './task.module.css';
import {
  beginEditor, canSubmit, changeDraft, dataExpiry, digestText, instanceLabel, isDataStale, markConflict,
  refreshConflict, sha256, taskCommand, type CreateDraft, type EditDraft, type TaskCapabilities,
  type TaskCard, type TaskDraft, type TaskEditorState, type TaskScope,
} from './task-model';

export type TaskSubmission = Awaited<ReturnType<typeof taskCommand>>;
export type SubmissionResult = { ok: true } | { ok: false; code: string; currentRev?: number; latest?: TaskCard | CreateDraft['feature'] };
const errorLabels: Record<string, string> = {
  forbidden: '无权提交', execution_not_shared: '共享执行尚未开放', unavailable: '暂时无法提交',
  stale_epoch: '版本已过期', stale_generation: '数据已更新', invalid_field: '请检查填写内容',
};
export interface TaskEditorProps {
  initialDraft: TaskDraft; capabilities: TaskCapabilities; scope: TaskScope;
  instanceNames: Readonly<Record<string, string>>; observedAt: number | null; now: number;
  submit: (command: TaskSubmission) => Promise<SubmissionResult>; onClose: () => void;
}

/** X12 wires submit to the shared command client and supplies the verified fence/snapshot. */
export function TaskEditor(p: TaskEditorProps) {
  const [state, setState] = useState<TaskEditorState>(() => beginEditor(p.initialDraft));
  const [error, setError] = useState<string | null>(null);
  const draft = state.draft, inFlight = draft.kind === 'edit' && draft.base.stage !== 'spec';
  const update = (field: 'title' | 'plan' | 'specSummary' | 'reason', value: string) => {
    if (draft.kind === 'create' && field !== 'title' && field !== 'plan') return;
    setState(changeDraft(state, { ...draft, [field]: value } as TaskDraft)); setError(null);
  };
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit(state, p.capabilities)) return;
    setState({ ...state, phase: 'submitting' }); setError(null);
    try {
      const digest = await sha256(digestText(draft));
      const command = taskCommand(state, p.capabilities, p.scope, digest, crypto.randomUUID());
      const result = await p.submit(command);
      if (result.ok) { setState({ ...state, phase: 'saved' }); return; }
      if (result.code === 'conflict') {
        setState(markConflict(state, { currentRev: result.currentRev ?? 0, latest: result.latest ?? null }));
      } else { setState({ ...state, phase: 'rejected' }); setError(result.code); }
    } catch (cause) {
      setState({ ...state, phase: 'rejected' });
      setError(cause instanceof Error ? cause.message : 'unavailable');
    }
  };
  const cap = p.capabilities[draft.kind === 'create' ? 'task.new' : inFlight ? 'task.spec' : 'task.set'];
  const expiry = dataExpiry(p.observedAt);
  const home = draft.kind === 'edit' ? draft.base.homeInstanceId : draft.feature.homeInstanceId;
  const executor = draft.kind === 'edit' ? draft.base.executorInstanceId : null;
  return <section className={`${shared.root} ${s.panel}`}>
    <div className={shared.detailHead}><div><small>{draft.kind === 'create' ? draft.feature.id : draft.base.featureId}</small>
      <h2>{draft.kind === 'create' ? '新建 spec 卡' : '编辑 spec 卡'}</h2></div>
      <button type="button" onClick={p.onClose}><Icon name="x" /> 关闭</button></div>
    <div className={shared.meta}>
      <span>主场 · {instanceLabel(home, p.instanceNames)}</span>
      <span>执行地 · {instanceLabel(executor, p.instanceNames)}</span>
      <span className={isDataStale(p.observedAt, p.now) ? s.expired : undefined}>
        数据过期时间 · {expiry === null ? '—' : new Date(expiry).toLocaleString()}</span>
    </div>
    <div className={shared.actions}>
      {(['dag.bind', 'task.stage', 'task.assign', 'approval'] as const).map(action =>
        <button key={action} type="button" disabled title="能力尚未开放"><Icon name="shieldCheck" />
          {{ 'dag.bind': '绑卡', 'task.stage': '改阶段', 'task.assign': '分配', approval: '审批' }[action]}</button>)}
    </div>
    {state.phase === 'conflict' && <div role="alert" className={`${shared.conflict} ${s.feedback}`}>
      <Icon name="circleAlert" /> 当前版本已更新；草稿仍在。
      {state.conflict?.latest && <button type="button" onClick={() => setState(refreshConflict(state))}>
        <Icon name="rotateCcw" /> 刷新版本并保留草稿</button>}
    </div>}
    {error && <div role="alert" className={`${shared.notice} ${s.feedback}`}>
      <Icon name="circleAlert" /> {errorLabels[error] ?? '提交失败'}</div>}
    {state.phase === 'saved' && <div role="status" className={s.feedback}><Icon name="circleCheck" /> 已保存</div>}
    <form className={shared.form} onSubmit={send}>
      {draft.kind === 'create' && <small>所属 feature · {draft.feature.id} · rev {draft.feature.rev}</small>}
      {draft.kind === 'edit' && <small>卡 rev {draft.base.rev} · specRev {draft.base.specRev}</small>}
      <label>标题<input required maxLength={300} value={draft.title} disabled={inFlight || state.phase === 'submitting'}
        onChange={e => update('title', e.target.value)} /></label>
      <label>规划说明<textarea maxLength={16000} value={draft.plan} disabled={inFlight || state.phase === 'submitting'}
        onChange={e => update('plan', e.target.value)} /></label>
      {inFlight && <><label>新规格摘要<textarea maxLength={16000} value={(draft as EditDraft).specSummary}
        disabled={state.phase === 'submitting'} onChange={e => update('specSummary', e.target.value)} /></label>
        <label>改规格原因<textarea required maxLength={2000} value={(draft as EditDraft).reason}
          disabled={state.phase === 'submitting'} onChange={e => update('reason', e.target.value)} /></label>
        <div className={s.version}><Icon name="history" /> 提交后产生 specRev {(draft as EditDraft).base.specRev + 1}</div></>}
      <div className={shared.actions}><button type="submit" disabled={!canSubmit(state, p.capabilities)} title={cap.reason}>
        <Icon name="send" /> {inFlight ? '提交新 specRev' : draft.kind === 'create' ? '开卡' : '保存'}</button>
        <button type="button" onClick={p.onClose}>取消</button></div>
    </form>
  </section>;
}
