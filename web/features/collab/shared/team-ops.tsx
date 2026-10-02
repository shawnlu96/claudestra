'use client';
/**
 * 团队视图（i28-TV1）= 本地 CollabView + 中心数据源。这里是那层注入：TeamSource 把 team-source-shared.ts 的数据源交给
 * use-collab.ts，并把团队特有的操作放进本地视图已有的位置——feature 级（新建 / 编辑规划 / 409 冲突重放 / 查回执）在「团队」
 * 标签（手机是「团队」整屏）顶上，任务级（开卡 / 绑卡 / 阶段 / 审批）在任务详情里。样式用本地视图的 Sec / 按钮 / 行。
 * CAS 提交与冲突重放的规则照旧（use-shared-submission.ts、shared-model.ts、shared-rebase.ts，见 README）。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { identityKey, SharedLedgerSession, sharedLedgerTransport } from '@/lib/api/shared-ledger';
import type { Capabilities, FeatureDetail, Identity, Transport } from '@/lib/api/shared-ledger';
import { useLang } from '@/lib/i18n';
import { sharedLedgerTr } from '@/lib/i18n-dict-shared-ledger';
import { CollabSourceContext } from '../team-source-context';
import { sharedCollabSource } from '../team-source-shared';
import { looksLikeId } from '../team-source-adapter';
import { Sec } from '../v4/v4-props';
import type { Tr } from '../collab-model';
import { makeDraft, rebaseDraft, rewrite, stale, type Draft } from './shared-model';
import { useSharedSubmission } from './use-shared-submission';
import { NewFeature, PlanEditor } from './shared-forms';
import c from '../collab.module.css';
import v from '../v4/v4.module.css';
import s from './shared.module.css';

export const EXECUTION_ACTIONS = ['task.new', 'dag.bind', 'stage', 'approval'] as const;
const LABELS = ['开卡', '绑卡', '阶段', '审批'];

type Ops = ReturnType<typeof useTeamOps>;
const OpsContext = createContext<Ops | null>(null);

function useTeamOps(identity: Identity, session: SharedLedgerSession, source: ReturnType<typeof sharedCollabSource>, tr: Tr) {
  const [detail, setDetail] = useState<FeatureDetail | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pendingRequest, setPending] = useState<string | null>(null);
  const selected = useRef<string | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = async () => { source.poke(); };
  const open = async (id: string) => {
    selected.current = id; setCreating(false); setBusy(true); setError(null);
    try {
      const next = await session.detail(id);
      if (alive.current && next && selected.current === id) { setDetail(next); setDraft(makeDraft(next)); }
    } catch (e) {
      if (alive.current) { console.warn('Shared feature read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await session.detail(draft.base.feature.id);
      if (alive.current && next) { setDraft(rebaseDraft(draft, next)); setDetail(next); setError(null); }
    } catch (e) {
      if (alive.current) { console.warn('Conflict re-read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  const { submit, receipt } = useSharedSubmission({ session, alive, identity, detail, pendingRequest, tr, setBusy, setError, setDraft,
    setCreating, setPending, setPrevious: () => undefined, selected, setDetail, refresh, open: async () => { selected.current = null; await refresh(); } });
  const submitDraft = () => {
    if (!draft || pendingRequest) return;
    try { void submit(rewrite(draft)); } catch (e) {
      setError(tr(e instanceof Error && e.message === 'reason_required' ? '请填写改图原因' : '节点需有唯一代号、标题和文件范围；依赖必须存在且无环'));
    }
  };
  const cancel = () => { selected.current = null; setDraft(null); setDetail(null); setError(null); };
  return { identity, source, tr, detail, draft, creating, busy, error, pendingRequest, open, reload, submit, receipt, submitDraft, cancel,
    setDraft, setCreating, retry: refresh };
}

/** 包在 CollabView 外面：同一个视图、换成中心的数据；身份变了整个重挂（key），旧身份的请求和草稿一起丢掉 */
export function TeamSource({ identity, transport, children }: { identity: Identity; transport?: Transport; children: ReactNode }) {
  return <Session key={identityKey(identity)} identity={identity} transport={transport}>{children}</Session>;
}
function Session({ identity, transport, children }: { identity: Identity; transport?: Transport; children: ReactNode }) {
  const tr = sharedLedgerTr(useLang());
  const [session] = useState(() => new SharedLedgerSession(identity, transport ?? sharedLedgerTransport({ fp: identity.machine }, identity.project)));
  const [source] = useState(() => sharedCollabSource(session, `shared-ledger:${identityKey(identity)}`, `${identity.project} · ${identity.team}`));
  useEffect(() => { session.activate(); return () => session.close(); }, [session]);
  const ops = useTeamOps(identity, session, source, tr);
  const injected = useMemo(() => ({ ...source, ops: (taskId: string | null) => <TeamOps taskId={taskId} /> }), [source]);
  return <OpsContext.Provider value={ops}><CollabSourceContext.Provider value={injected}>{children}</CollabSourceContext.Provider></OpsContext.Provider>;
}

function TeamOps({ taskId }: { taskId: string | null }) {
  const ops = useContext(OpsContext);
  if (!ops) return null;
  return taskId === null ? <FeatureOps ops={ops} /> : <TaskOps ops={ops} taskId={taskId} />;
}

function Notices({ ops }: { ops: Ops }) {
  const { tr } = ops;
  return <>
    {ops.error && <div role="alert" className={`${s.line} ${v.warn}`}>{ops.error}
      <button type="button" className={c.btn} onClick={() => void ops.retry()}>{tr('重试')}</button></div>}
    {ops.pendingRequest && <div className={`${s.line} ${v.warn}`}>{tr('提交状态未知，请查回执')}
      <button type="button" className={c.btn} onClick={() => void ops.receipt()}>{tr('查询回执')}</button></div>}
  </>;
}

function FeatureOps({ ops }: { ops: Ops }) {
  const { tr } = ops, last = ops.source.last(), now = Date.now();
  const features = last?.list.features ?? [];
  const caps = last?.list.capabilities ?? {};
  const latest = ops.draft?.latest;
  let body: ReactNode;
  if (ops.creating) body = <NewFeature project={ops.identity.project} home={ops.identity.homeInstanceId ?? ops.identity.machine}
    busy={ops.busy || !!ops.pendingRequest} tr={tr} onSubmit={(cmd) => void ops.submit(cmd)} onCancel={() => ops.setCreating(false)} />;
  else if (ops.draft) body = <>
    {latest && <div className={s.conflict}>
      <div className={v.kv}>{tr('规划已被他人更新')}</div>
      <div className={v.muted}>{latest.feature.updatedBy} · {new Date(latest.feature.updatedAt).toLocaleString()}</div>
      <div className={s.line}><button type="button" className={c.btn} disabled={ops.busy} onClick={() => void ops.reload()}>{tr('重读后编辑')}</button>
        <button type="button" className={c.btn} onClick={ops.cancel}>{tr('放弃草稿')}</button></div></div>}
    <div className={v.kv}>{ops.draft.base.feature.title}</div>
    <PlanEditor draft={ops.draft} busy={ops.busy || !!ops.pendingRequest} tr={tr} onChange={ops.setDraft} onSubmit={ops.submitDraft} onCancel={ops.cancel} />
  </>;
  else body = <>
    {features.map((f) => {
      const d = last?.details.get(f.id);
      const editable = f.authorityMode === 'planning' && !!d?.capabilities[f.version ? 'dag.rewrite' : 'dag.init']?.enabled;
      const mirror = f.projection ? stale(f, now) ? '主场镜像过期' : '主场镜像最新' : '尚无执行镜像';
      return <div key={f.id} className={v.row}>
        <div className={v.kv}>{f.title}</div>
        <div className={v.muted}>v{f.version} · {[looksLikeId(f.homeInstanceId) ? null : `${tr('主场')} ${f.homeInstanceId}`, tr(mirror),
          f.authorityMode === 'source' ? tr('来源镜像只读') : null].filter(Boolean).join(' · ')}</div>
        <div className={s.line}><button type="button" className={c.btn} disabled={ops.busy || !editable}
          aria-label={`${tr('编辑规划')} ${f.title}`} onClick={() => void ops.open(f.id)}>{tr('编辑规划')}</button></div>
      </div>;
    })}
    {!features.length && <div className={v.muted}>{tr('暂无 feature')}</div>}
    <div className={s.line}><button type="button" className={c.btn} disabled={ops.busy || !caps['feature.new']?.enabled}
      onClick={() => ops.setCreating(true)}>{tr('新建 feature')}</button></div>
  </>;
  return <Sec title={tr('团队规划')}><Notices ops={ops} />{body}</Sec>;
}

function TaskOps({ ops, taskId }: { ops: Ops; taskId: string }) {
  const { tr } = ops, last = ops.source.last();
  const at = last?.team.index.get(taskId);
  const d = at ? last?.details.get(at.featureId) : undefined;
  const capabilities: Capabilities = d?.capabilities ?? {};
  const reasons = [...new Set(EXECUTION_ACTIONS.map((a) => capabilities[a]?.reason).filter(Boolean))];
  return <Sec title={tr('团队操作')}>
    <div className={s.line}>{EXECUTION_ACTIONS.map((a, i) => <button key={a} type="button" className={c.btn} disabled={!capabilities[a]?.enabled}
      title={capabilities[a]?.reason ?? tr('V1 仅共享规划，执行操作仍在主场')}>{tr(LABELS[i]!)}</button>)}</div>
    <div className={v.muted}>{reasons.length ? reasons.join(' · ') : tr('V1 仅共享规划，执行操作仍在主场')} · {tr('全文仅在主场')}</div>
  </Sec>;
}
