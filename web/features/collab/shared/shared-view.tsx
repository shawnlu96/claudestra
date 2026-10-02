'use client';
import type { Capabilities, Command, FeatureDetail, FeatureList, Identity } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
import { progress, stale } from './shared-model';
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
  const statuses = { planned: '待规划', active: '进行中', done: '已完成', blocked: '已阻塞' };
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
    </> : <section className={s.list} aria-label={tr('全部 feature')}>
      <div className={s.tableHead}>{['项目', '标题', '状态', '完成 / 总数', '阻塞', '主场', '执行机器', '最近更新', '缺失', '过期'].map(x => <span key={x}>{tr(x)}</span>)}</div>
      {p.list?.features.map(f =>
        <button type="button" className={s.row} key={f.id} onClick={() => p.onOpen(f.id)}>
          <span data-label={tr('项目')}>{f.projectId}</span><strong>{f.title}</strong>
          <span data-label={tr('状态')}>{tr((stale(f, p.now) || f.counts.missing > 0) && f.status === 'done' ? '过期' : statuses[f.status])}</span>
          <span data-label={tr('完成 / 总数')}>{progress(f, p.now)} / {f.counts.total}</span>
          <span data-label={tr('阻塞')}>{f.counts.blocked}</span><span data-label={tr('主场')}>{f.homeInstanceId}</span>
          <span data-label={tr('执行机器')}>{f.executorInstanceIds.join(', ') || '—'}</span>
          <time data-label={tr('最近更新')} dateTime={new Date(f.updatedAt).toISOString()}>{new Date(f.updatedAt).toLocaleString()}</time>
          <span data-label={tr('缺失')}>{f.counts.missing}</span>
          <span className={stale(f, p.now) ? s.warn : ''} data-label={tr('过期')}>{tr(stale(f, p.now) ? '过期' : '最新')}</span>
        </button>)}
      {p.list && !p.list.features.length && <p>{tr('暂无 feature')}</p>}
    </section>}
  </main>;
}
