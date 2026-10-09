'use client';
import { useState } from 'react';
import { Icon } from '../../collab-icons';
import shared from '../shared.module.css';
import c from '../../collab.module.css';
import s from './approve.module.css';
import {
  approvalCommands, approvalStatus, beginApproval, bindDigest, canSign, documentView, settleIfCurrent, shortDigest,
  signBlocker, startApproval, stateFor, type ApprovalPanelProps, type ApprovalResult, type ApprovalState, type Decision,
} from './approve-model';
export type { ApprovalPanelProps } from './approve-model';

const statusLabels: Record<string, string> = {
  open: '待审批', drifted: '基础版已变化', expired: '已过期', revoked: '已撤销', answered: '已答复', unbound: '无授权绑定',
  not_owner: '仅 owner 可签',
};
const errorLabels: Record<string, string> = {
  unknown: '提交状态未知，请查回执',
  forbidden: '无权签署', not_member: '无权签署', conflict: '版本已变化', pending_proposal: '提案状态已变化',
  authorization_expired: '授权已过期', authorization_mismatch: '绑定内容不一致', stale_epoch: '版本已过期',
  stale_generation: '数据已更新', unavailable: '暂时无法提交', invalid_field: '请求无效',
};

/** X12 wires submit to the shared command client; the owner role comes from verified identity, not this prop alone. */
export function ApprovalPanel(p: ApprovalPanelProps & { tr?: (key: string) => string }) {
  const tr = p.tr ?? ((key: string) => key);
  const [recorded, setRecorded] = useState<ApprovalState>(beginApproval);
  const state = stateFor(recorded, p.view);
  const { ask, proposal } = p.view, bind = ask.bind;
  const status = approvalStatus(p.view, p.now), blocker = signBlocker(p.view, p.viewer, p.now);
  const material = documentView(p.view.document);
  const sign = async (decision: Decision) => {
    if (!canSign(state, p.view, p.viewer, p.now, decision) || !bind) return;
    const requestIds = { answer: crypto.randomUUID(), decide: crypto.randomUUID() };
    const pending = startApproval(state, decision, requestIds.answer);
    const settle = (result: ApprovalResult | Error) => setRecorded(current => settleIfCurrent(current, pending, result));
    setRecorded(pending);
    try {
      const commands = approvalCommands(state, p.view, p.viewer, p.scope, p.now, decision, await bindDigest(bind), requestIds);
      settle(await p.submit(commands));
    } catch (cause) {
      settle(cause instanceof Error ? cause : new Error('unavailable'));
    }
  };
  const button = (decision: Decision, icon: 'circleCheck' | 'circleX', label: string) =>
    <button className={c.btn} type="button" disabled={!canSign(state, p.view, p.viewer, p.now, decision)}
      title={blocker ? tr(statusLabels[blocker]) : undefined} aria-busy={state.phase === 'submitting' && state.decision === decision}
      onClick={() => void sign(decision)}><Icon name={icon} /> {tr(label)}</button>;
  return <section className={`${c.sec} ${s.panel}`}>
    <div className={c.ph}><div className={c.tt}><small>{ask.featureId}{ask.taskId ? ` · ${ask.taskId}` : ''}</small>
      <h2 className={c.a}>{ask.title}</h2></div>
      <button className={c.btn} type="button" onClick={p.onClose}><Icon name="x" /> {tr('关闭')}</button></div>
    <div className={`${c.s2} ${shared.line}`}>
      <span className={s.badge}><Icon name={status === 'open' ? 'shieldCheck' : 'circleAlert'} /> {tr(statusLabels[status])}</span>
      {bind && <>
        <span>{tr('提案摘要')} · {shortDigest(bind.proposalDigest)}</span>
        <span>{tr('基础版')} · v{bind.baseVersion}</span>
        <span><Icon name="clock" /> {tr('期限')} · {new Date(bind.expiresAt).toLocaleString()}</span>
        <span>{tr('主场')} · {p.instanceNames[bind.homeInstanceId] ?? bind.homeInstanceId}</span>
        <span>{tr('动作')} · {bind.actions.join(', ')}</span>
      </>}
    </div>
    {proposal && <div className={shared.preview}>
      <dl><div><dt>{tr('提案')}</dt><dd>v{proposal.baseVersion} → v{proposal.version} · {proposal.reasonText}</dd></div>
        <div><dt>{tr('节点')}</dt><dd><ul className={s.nodes}>{proposal.nodes.map(n => <li key={n.key}>{n.key} · {n.oneLine}</li>)}</ul></dd></div>
        {proposal.cancels.length > 0 && <div><dt>{tr('取消')}</dt><dd>{proposal.cancels.join(', ')}</dd></div>}</dl>
    </div>}
    {ask.context && <p>{ask.context}</p>}
    <div className={`${c.s2} ${shared.line}`}>
      <span className={s.badge}><Icon name="fileText" /> {tr(material.label)}</span>
      <span>{tr('原文')} · {tr(material.original)}</span>
      <span>{tr('原文哈希')} · {shortDigest(material.originalDigest)}</span>
      {material.sharedDigest && <span>{tr('副本哈希')} · {shortDigest(material.sharedDigest)}</span>}
    </div>
    {material.body && <div className={s.material}>{material.body}</div>}
    {status !== 'open' && <div role="status" className={`${s.feedback} ${s.state}`}>
      <Icon name={status === 'expired' ? 'hourglass' : status === 'drifted' ? 'history' : 'circleAlert'} /> {tr(statusLabels[status])}</div>}
    {state.phase === 'rejected' && <div role="alert" className={`${c.nowbox} ${s.feedback}`}>
      <Icon name="circleAlert" /> {tr(errorLabels[state.error ?? ''] ?? '提交失败')}</div>}
    <div className={`${shared.actions} ${s.feedback}`}>
      {p.viewer.role === 'owner' && button('approved', 'circleCheck', '批准')}
      {p.viewer.role === 'owner' && button('rejected', 'circleX', '驳回')}
      {state.phase === 'saved' && <span role="status" aria-label={tr(state.decision === 'approved' ? '已批准' : '已驳回')} className={s.done}>
        <Icon name="check" /></span>}
    </div>
  </section>;
}
