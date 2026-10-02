'use client';
import type { Capabilities, Command, FeatureDetail, FeatureList, Identity } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
import { stale } from './shared-model';
import { SharedProduct } from '../dag/shared-product';
import { sharedLedgerTr } from '../../../lib/i18n-dict-shared-ledger';
import { SharedGraph } from './shared-graph';
import { NewFeature, PlanEditor } from './shared-forms';
import { Icon } from '../collab-icons';
import tokens from '../collab.module.css';
import s from './shared.module.css';
export const EXECUTION_ACTIONS = ['task.new', 'dag.bind', 'stage', 'approval'] as const;
const LABELS = ['开卡', '绑卡', '阶段', '审批'];
export function ExecutionActions({ capabilities, tr }: { capabilities: Capabilities; tr: ReturnType<typeof sharedLedgerTr> }) {
  return <div className={s.execution}><div className={s.actions}>{EXECUTION_ACTIONS.map((a, i) =>
    <button key={a} type="button" disabled={!capabilities[a]?.enabled}
      title={capabilities[a]?.reason ?? tr('V1 仅共享规划，执行操作仍在主场')}>
      <Icon name="shieldCheck" /> {tr(LABELS[i]!)}</button>)}</div><small>{tr('V1 仅共享规划，执行操作仍在主场')}</small></div>;
}
export interface SharedViewProps {
  identity: Identity; language?: 'zh' | 'en'; now: number; list: FeatureList | null; detail: FeatureDetail | null;
  previous?: FeatureDetail; draft: Draft | null; creating: boolean; busy: boolean; error: string | null; pendingRequest?: string | null;
  onOpen: (id: string) => void; onBack: () => void; onCreate: () => void; onCancelCreate: () => void;
  onNew: (command: Command) => void; onEdit: () => void; onDraft: (draft: Draft | null) => void;
  onSubmit: () => void; onReload: () => void; onRetry: () => void; onReceipt: () => void;
}
export function SharedLedgerView(p: SharedViewProps) {
  const tr = sharedLedgerTr(p.language ?? 'zh'), d = p.detail;
  const loading = p.busy || (!p.list && !p.error);
  return <main className={`${tokens.tokens} ${s.root}`} aria-busy={loading}>
    <header className={s.header}><div><small>{tr('团队规划')} · {p.identity.team}</small><h1>{tr('全部 feature')}</h1></div>
      <button type="button" disabled={p.busy || !p.list?.capabilities['feature.new']?.enabled}
        onClick={p.onCreate}><Icon name="plus" /> {tr('新建 feature')}</button></header>
    {loading && <div role="status" aria-label={tr('正在读取…')} className={s.loading} />}
    {p.error && <div role="alert" className={s.notice}>{p.error}<button onClick={p.onRetry}>{tr('重试')}</button></div>}
    {p.pendingRequest && <div className={s.notice}>{tr('提交状态未知，请查回执')}
      <button onClick={p.onReceipt}>{tr('查询回执')}</button></div>}
    {p.creating ? <NewFeature project={p.identity.project} home={p.identity.homeInstanceId ?? p.identity.machine} busy={p.busy || !!p.pendingRequest} tr={tr}
      onSubmit={p.onNew} onCancel={p.onCancelCreate} /> : d ? <>
      <div className={s.detailHead}><button onClick={p.onBack}><Icon name="arrowLeft" /> {tr('返回')}</button>
        <div><small>{d.feature.projectId} · {d.feature.id} · v{d.dag.version}</small><h2>{d.feature.title}</h2>
          <p>{d.feature.description}</p></div>
        <button disabled={p.busy || d.feature.authorityMode !== 'planning' ||
          !d.capabilities[d.dag.version ? 'dag.rewrite' : 'dag.init']?.enabled} onClick={p.onEdit}>{tr('编辑规划')}</button></div>
      <div className={s.meta}><span>{tr('主场')} · {d.feature.homeInstanceId}</span>
        <span>{tr('执行机器')} · {d.feature.executorInstanceIds.join(', ') || '—'}</span>
        <span>{tr(d.feature.projection ? stale(d.feature, p.now) ? '主场镜像过期' : '主场镜像最新' : '尚无执行镜像')}</span>
        <span>{tr('主场在线状态未知')}</span><span>{tr('全文仅在主场')}</span></div>
      {d.feature.authorityMode === 'source' && <p className={s.notice}>{tr('来源镜像只读')}</p>}
      <ExecutionActions capabilities={d.capabilities} tr={tr} />
      {p.draft?.latest && <section className={s.conflict}>
        <h2>{tr('规划已被他人更新')}</h2><small>{p.draft.latest.feature.updatedBy} · {new Date(p.draft.latest.feature.updatedAt).toLocaleString()}</small>
        <div className={s.compare}><div><h3>{tr('草稿')}</h3><SharedGraph detail={{ ...p.draft.base,
          dag: { ...p.draft.base.dag, nodes: p.draft.nodes } }} now={p.now} tr={tr} /></div>
          <div><h3>{tr('最新图')}</h3><SharedGraph detail={p.draft.latest} previous={p.draft.base} now={p.now} tr={tr} /></div></div>
        <div className={s.actions}><button disabled={p.busy} onClick={p.onReload}>{tr('重读后编辑')}</button>
          <button onClick={() => p.onDraft(null)}>{tr('放弃草稿')}</button></div></section>}
      {p.draft ? <PlanEditor draft={p.draft} busy={p.busy || !!p.pendingRequest} tr={tr} onChange={p.onDraft} onSubmit={p.onSubmit}
        onCancel={() => p.onDraft(null)} /> : <SharedGraph detail={d} previous={p.previous} now={p.now} tr={tr} />}
      {d.tasks.map(task => <article key={task.taskId} className={s.task}><b>{task.taskId}</b> · {task.stage}
        <p>{task.specSummary}</p><small>{tr('全文仅在主场')}</small></article>)}
    </> : <SharedProduct list={p.list} now={p.now} onOpen={p.onOpen} tr={tr} />}
  </main>;
}
