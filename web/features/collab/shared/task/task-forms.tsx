'use client';
import { useState, type FormEvent } from 'react';
import { Icon } from '../../collab-icons';
import shared from '../shared.module.css';
import c from '../../collab.module.css';
import s from './task.module.css';
import {
  beginEditor, canSubmit, changeDraft, dataExpiry, digestText, instanceLabel, isDataStale, latestValue, markConflict,
  refreshConflict, sha256, taskCommand, type CreateDraft, type EditDraft, type TaskCapabilities,
  type EditField, type TaskCard, type TaskDraft, type TaskEditorState, type TaskScope, type RetainedEdit,
} from './task-model';

export type TaskSubmission = Awaited<ReturnType<typeof taskCommand>>;
export type SubmissionResult = { ok: true } | { ok: false; code: string; currentRev?: number; latest?: TaskCard | CreateDraft['feature'] };
const errorLabels: Record<string, string> = {
  unknown: '提交状态未知，请查回执',
  forbidden: '无权提交', execution_not_shared: '共享执行尚未开放', unavailable: '暂时无法提交',
  stale_epoch: '版本已过期', stale_generation: '数据已更新', invalid_field: '请检查填写内容',
};
export interface TaskEditorProps {
  tr?: (key: string) => string; initialDraft: TaskDraft; capabilities: TaskCapabilities; scope: TaskScope;
  instanceNames: Readonly<Record<string, string>>; observedAt: number | null; now: number;
  submit: (command: TaskSubmission) => Promise<SubmissionResult>; onClose: () => void;
}

const fieldLabels = { title: '标题', plan: '规划', specSummary: '规格摘要', reason: '改规格原因' };
/** Mine on the left, latest on the right; '最新版本' is its own key because the shared '最新' means fresh. */
function Compare({ mine, latest, tr }: { mine: string; latest: string; tr: (key: string) => string }) {
  return <div className={shared.compare}><div><div className={shared.sub}>{tr('我的修改')}</div>
    <p className={shared.preview}>{mine || tr('（空）')}</p></div>
    <div><div className={shared.sub}>{tr('最新版本')}</div><p className={shared.preview}>{latest || tr('（空）')}</p></div></div>;
}
function RetainedModification({ edit, latest, tr, busy, onDiscard }: {
  edit: RetainedEdit; latest: string; tr: (key: string) => string; busy: boolean; onDiscard: () => void;
}) {
  const [copy, setCopy] = useState<'done' | 'failed' | null>(null);
  const label = tr(fieldLabels[edit.field]);
  const copyText = async () => {
    try { await navigator.clipboard.writeText(edit.value); setCopy('done'); }
    catch { setCopy('failed'); } // Clipboard permissions can be denied; keep the text visible for manual selection.
  };
  return <section role="region" aria-label={`${tr('保留修改')}：${label}`} className={shared.nodeConflict}>
    <div className={shared.head}>{label}</div>
    <Compare mine={edit.value} latest={latest} tr={tr} />
    <div className={shared.actions}>
      <button className={c.btn} type="button" onClick={() => void copyText()}><Icon name="clipboard" /> {tr('复制')}</button>
      <button className={c.btn} type="button" disabled={busy} onClick={onDiscard}><Icon name="x" /> {tr('放弃')}</button>
      {copy && <span role={copy === 'done' ? 'status' : 'alert'}>{tr(copy === 'done' ? '已复制' : '复制失败，请选择文字复制')}</span>}
    </div>
  </section>;
}
function TaskConflicts({ state, tr, onRefresh, onDiscard, onUseLatest }: {
  state: TaskEditorState; tr: (key: string) => string; onRefresh: () => void; onDiscard: (index: number) => void;
  onUseLatest: (field: EditField, value: string) => void;
}) {
  const latest = state.draft.kind === 'edit' ? state.draft.base : null, draft = state.draft;
  const contested = latest && draft.kind === 'edit' ? state.contested.filter(f => draft[f] !== latestValue(latest, f)) : [];
  if (state.phase !== 'conflict' && !state.retained.length && !contested.length) return null;
  const busy = state.phase === 'submitting';
  return <div className={shared.conflict}>
    {state.phase === 'conflict'
      ? <div role="alert" className={shared.line}><Icon name="circleAlert" /> {tr('当前版本已更新；草稿仍在。')}
        {state.conflict?.latest && <button className={c.btn} type="button" onClick={onRefresh}>
          <Icon name="rotateCcw" /> {tr('刷新版本并保留草稿')}</button>}</div>
      // After an explicit refresh nothing is pending; the retained copies are reference material, not an alarm.
      : <div className={shared.line}><Icon name="history" /> {tr('保留修改')}</div>}
    {latest && draft.kind === 'edit' && contested.map(field => <section key={field} role="region"
      aria-label={`${tr('最新版本')}：${tr(fieldLabels[field])}`} className={shared.nodeConflict}>
      <div className={shared.head}>{tr(fieldLabels[field])}</div>
      <Compare mine={draft[field]} latest={latestValue(latest, field)} tr={tr} />
      <div className={shared.actions}><button className={c.btn} type="button" disabled={busy}
        onClick={() => onUseLatest(field, latestValue(latest, field))}><Icon name="check" /> {tr('用最新')}</button></div>
    </section>)}
    {latest && state.retained.map((edit, index) => <RetainedModification key={JSON.stringify(edit)} edit={edit} tr={tr}
      latest={latestValue(latest, edit.field)} busy={busy} onDiscard={() => onDiscard(index)} />)}
  </div>;
}

/** X12 wires submit to the shared command client and supplies the verified fence/snapshot. */
export function TaskEditor(p: TaskEditorProps) {
  const tr = p.tr ?? ((key: string) => key);
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
  return <section className={`${c.sec} ${s.panel}`}>
    <div className={c.ph}><div className={c.tt}><small>{draft.kind === 'create' ? draft.feature.id : draft.base.featureId}</small>
      <h2 className={c.a}>{tr(draft.kind === 'create' ? '新建 spec 卡' : '编辑 spec 卡')}</h2></div>
      <button className={c.btn} type="button" onClick={p.onClose}><Icon name="x" /> {tr('关闭')}</button></div>
    <div className={`${c.s2} ${shared.line}`}>
      <span>{tr('主场')} · {instanceLabel(home, p.instanceNames)}</span>
      <span>{tr('执行地')} · {instanceLabel(executor, p.instanceNames)}</span>
      <span className={isDataStale(p.observedAt, p.now) ? s.expired : undefined}>
        {tr('数据过期时间')} · {expiry === null ? '—' : new Date(expiry).toLocaleString()}</span>
    </div>
    <div className={shared.actions}>
      {(['dag.bind', 'task.stage', 'task.assign', 'approval'] as const).map(action =>
        <button className={c.btn} key={action} type="button" disabled title={tr('能力尚未开放')}><Icon name="shieldCheck" />
          {tr({ 'dag.bind': '绑卡', 'task.stage': '改阶段', 'task.assign': '分配', approval: '审批' }[action])}</button>)}
    </div>
    <TaskConflicts state={state} tr={tr} onRefresh={() => setState(refreshConflict(state))}
      onDiscard={index => setState(current => ({ ...current, retained: current.retained.filter((_, i) => i !== index) }))}
      onUseLatest={update} />
    {error && <div role="alert" className={`${c.nowbox} ${s.feedback}`}>
      <Icon name="circleAlert" /> {tr(errorLabels[error] ?? '提交失败')}</div>}
    {state.phase === 'saved' && <div role="status" className={s.feedback}><Icon name="circleCheck" /> {tr('已保存')}</div>}
    <form className={shared.form} onSubmit={send}>
      {draft.kind === 'create' && <small>{tr('所属 feature')} · {draft.feature.id} · rev {draft.feature.rev}</small>}
      {draft.kind === 'edit' && <small>{tr('卡')} rev {draft.base.rev} · specRev {draft.base.specRev}</small>}
      <label>{tr('标题')}<input required maxLength={300} value={draft.title} disabled={inFlight || state.phase === 'submitting'}
        onChange={e => update('title', e.target.value)} /></label>
      <label>{tr('规划说明')}<textarea maxLength={16000} value={draft.plan} disabled={inFlight || state.phase === 'submitting'}
        onChange={e => update('plan', e.target.value)} /></label>
      {inFlight && <><label>{tr('新规格摘要')}<textarea maxLength={16000} value={(draft as EditDraft).specSummary}
        disabled={state.phase === 'submitting'} onChange={e => update('specSummary', e.target.value)} /></label>
        <label>{tr('改规格原因')}<textarea required maxLength={2000} value={(draft as EditDraft).reason}
          disabled={state.phase === 'submitting'} onChange={e => update('reason', e.target.value)} /></label>
        <div className={s.version}><Icon name="history" /> {tr('提交后产生 specRev')} {(draft as EditDraft).base.specRev + 1}</div></>}
      <div className={shared.actions}><button className={c.btn} type="submit" disabled={!canSubmit(state, p.capabilities)} title={cap.reason}>
        <Icon name="send" /> {tr(inFlight ? '提交新 specRev' : draft.kind === 'create' ? '开卡' : '保存')}</button>
        <button className={c.btn} type="button" onClick={p.onClose}>{tr('取消')}</button></div>
    </form>
  </section>;
}
