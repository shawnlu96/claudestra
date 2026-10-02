'use client';
import { useState } from 'react';
import { Icon } from '../../collab-icons';
import shared from '../shared.module.css';
import s from './approve.module.css';
import {
  approvalCommands, approvalStatus, beginApproval, bindDigest, canSign, documentView, settleApproval, shortDigest,
  signBlocker, startApproval, type ApprovalResult, type ApprovalScope, type ApprovalState, type ApprovalSubmission,
  type ApprovalView, type ApprovalViewer, type Decision,
} from './approve-model';

const statusLabels: Record<string, string> = {
  open: '待审批', drifted: '基础版已变化', expired: '已过期', revoked: '已撤销', answered: '已答复', unbound: '无授权绑定',
  not_owner: '仅 owner 可签',
};
const errorLabels: Record<string, string> = {
  forbidden: '无权签署', not_member: '无权签署', conflict: '版本已变化', pending_proposal: '提案状态已变化',
  authorization_expired: '授权已过期', authorization_mismatch: '绑定内容不一致', stale_epoch: '版本已过期',
  stale_generation: '数据已更新', unavailable: '暂时无法提交', invalid_field: '请求无效',
};
export interface ApprovalPanelProps {
  view: ApprovalView; viewer: ApprovalViewer; scope: ApprovalScope; now: number;
  instanceNames: Readonly<Record<string, string>>;
  submit: (submission: ApprovalSubmission) => Promise<ApprovalResult>; onClose: () => void;
}

/** X12 wires submit to the shared command client; the owner role comes from verified identity, not this prop alone. */
export function ApprovalPanel(p: ApprovalPanelProps) {
  const [state, setState] = useState<ApprovalState>(beginApproval);
  const { ask, proposal } = p.view, bind = ask.bind;
  const status = approvalStatus(p.view, p.now), blocker = signBlocker(p.view, p.viewer, p.now);
  const material = documentView(p.view.document);
  const sign = async (decision: Decision) => {
    if (!canSign(state, p.view, p.viewer, p.now, decision) || !bind) return;
    const pending = startApproval(state, decision);
    setState(pending);
    try {
      const commands = approvalCommands(state, p.view, p.viewer, p.scope, p.now, decision, await bindDigest(bind),
        { answer: crypto.randomUUID(), decide: crypto.randomUUID() });
      setState(settleApproval(pending, await p.submit(commands)));
    } catch (cause) {
      setState(settleApproval(pending, cause instanceof Error ? cause : new Error('unavailable')));
    }
  };
  const button = (decision: Decision, icon: 'circleCheck' | 'circleX', label: string) =>
    <button type="button" disabled={!canSign(state, p.view, p.viewer, p.now, decision)}
      title={blocker ? statusLabels[blocker] : undefined} aria-busy={state.phase === 'submitting' && state.decision === decision}
      onClick={() => void sign(decision)}><Icon name={icon} /> {label}</button>;
  return <section className={`${shared.root} ${s.panel}`}>
    <div className={shared.detailHead}><div><small>{ask.featureId}{ask.taskId ? ` · ${ask.taskId}` : ''}</small>
      <h2>{ask.title}</h2></div>
      <button type="button" onClick={p.onClose}><Icon name="x" /> 关闭</button></div>
    <div className={shared.meta}>
      <span className={s.badge}><Icon name={status === 'open' ? 'shieldCheck' : 'circleAlert'} /> {statusLabels[status]}</span>
      {bind && <>
        <span>提案摘要 · {shortDigest(bind.proposalDigest)}</span>
        <span>基础版 · v{bind.baseVersion}</span>
        <span><Icon name="clock" /> 期限 · {new Date(bind.expiresAt).toLocaleString()}</span>
        <span>主场 · {p.instanceNames[bind.homeInstanceId] ?? bind.homeInstanceId}</span>
        <span>动作 · {bind.actions.join(', ')}</span>
      </>}
    </div>
    {proposal && <div className={shared.preview}>
      <dl><div><dt>提案</dt><dd>v{proposal.baseVersion} → v{proposal.version} · {proposal.reasonText}</dd></div>
        <div><dt>节点</dt><dd><ul className={s.nodes}>{proposal.nodes.map(n => <li key={n.key}>{n.key} · {n.oneLine}</li>)}</ul></dd></div>
        {proposal.cancels.length > 0 && <div><dt>取消</dt><dd>{proposal.cancels.join(', ')}</dd></div>}</dl>
    </div>}
    {ask.context && <p>{ask.context}</p>}
    <div className={shared.meta}>
      <span className={s.badge}><Icon name="fileText" /> {material.label}</span>
      <span>原文 · {material.original}</span>
      <span>原文哈希 · {shortDigest(material.originalDigest)}</span>
      {material.sharedDigest && <span>副本哈希 · {shortDigest(material.sharedDigest)}</span>}
    </div>
    {material.body && <div className={s.material}>{material.body}</div>}
    {status !== 'open' && <div role="status" className={`${s.feedback} ${s.state}`}>
      <Icon name={status === 'expired' ? 'hourglass' : status === 'drifted' ? 'history' : 'circleAlert'} /> {statusLabels[status]}</div>}
    {state.phase === 'rejected' && <div role="alert" className={`${shared.notice} ${s.feedback}`}>
      <Icon name="circleAlert" /> {errorLabels[state.error ?? ''] ?? '提交失败'}</div>}
    <div className={`${shared.actions} ${s.feedback}`}>
      {button('approved', 'circleCheck', '批准')}
      {button('rejected', 'circleX', '驳回')}
      {state.phase === 'saved' && <span role="status" aria-label={state.decision === 'approved' ? '已批准' : '已驳回'} className={s.done}>
        <Icon name="check" /></span>}
    </div>
  </section>;
}
