'use client';
/**
 * N7W：团队视图「团队规划」区里的 feature 提案。新建 feature 不再走 V1 feature.new 直写，改成交本机 bridge 的提案接口
 * （N7B / N7B2，见 web/lib/feature-proposals-api.ts），等项目 owner 批准；project / home 由本机绑定定，表单里没有这些框。
 * 提案人看自己的状态（待批准 / 待同步 / 已发布 / 驳回 / 过期 / 冲突）；项目 owner（N4 snapshot 的 projectRole）在同一区看待审卡并决定。
 * 样式借 X11 审批面板（approve.module.css）与团队视图共用样式，不挂 approve-panel 组件。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { identityKey, type Identity } from '@/lib/api/shared-ledger';
import { featureProposalsApi, type FeatureProposalsPort } from '@/lib/feature-proposals-api';
import { ProposalsController, proposalsController, type ProposalsState } from '@/lib/feature-proposals-controller';
import { PROPOSER_TEXT, proposalInput, splitList, type ProposalEntry, type ProposerStatus } from '@/lib/feature-proposals-model';
import { useLang } from '@/lib/i18n';
import { featureProposalsTr } from '@/lib/i18n-dict-feature-proposals';
import { Icon, type IconName } from '../collab-icons';
import c from '../collab.module.css';
import v from '../v4/v4.module.css';
import s from '../shared/shared.module.css';
import a from '../shared/approve/approve.module.css';
import p from './proposals.module.css';

type Tr = ReturnType<typeof featureProposalsTr>;
type Card = ProposalsState['cards'][number];

function useProposals(identity: Identity, port?: FeatureProposalsPort) {
  const [ctrl] = useState(() => proposalsController(identityKey(identity), () =>
    new ProposalsController(port ?? featureProposalsApi({ fp: identity.machine }, identity.project), identity.project)));
  return { ctrl, state: useSyncExternalStore(ctrl.subscribe, ctrl.get, ctrl.get), tr: featureProposalsTr(useLang()) };
}

const ICONS: Partial<Record<ProposerStatus['kind'], IconName>> = { pending_approval: 'hourglass', approved: 'hourglass', published: 'circleCheck',
  pending_sync: 'circleHelp', unknown: 'circleHelp', rejected: 'circleX', expired: 'clock' };
function Status({ status, tr }: { status: ProposerStatus; tr: Tr }) {
  return <span className={p.status}>
    <span className={status.kind === 'published' ? a.done : a.badge}><Icon name={ICONS[status.kind] ?? 'circleAlert'} />{tr(PROPOSER_TEXT[status.kind])}</span>
    {status.cachedState && <span className={v.muted}>{tr('缓存状态')}：{tr(PROPOSER_TEXT[status.cachedState])}</span>}
    {status.kind === 'published' && <span className={v.muted}>{tr('中心 feature')} {status.featureId}{status.version ? ` · v${status.version}` : ''}</span>}
  </span>;
}

interface NodeDraft { uid: number; key: string; oneLine: string; deps: string; fileGlobs: string; estimate: string }
const blank = (uid: number): NodeDraft => ({ uid, key: `N${uid}`, oneLine: '', deps: '', fileGlobs: '', estimate: '' });
const NODE_FIELDS = [['key', '节点代号'], ['oneLine', '一句话描述'], ['deps', '依赖'], ['fileGlobs', '文件范围'], ['estimate', '估时']] as const;

/** 新建 feature 提案：只有标题 / 描述 / 原话 / 节点；project、home、center、team 都没有可写框 */
export function ProposalForm({ identity, port, onDone }: { identity: Identity; port?: FeatureProposalsPort; onDone: () => void }) {
  const { ctrl, state, tr } = useProposals(identity, port);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [words, setWords] = useState('');
  const [nodes, setNodes] = useState<NodeDraft[]>([blank(1)]), [invalid, setInvalid] = useState(false);
  const patch = (uid: number, field: keyof NodeDraft, value: string) => setNodes(nodes.map(n => n.uid === uid ? { ...n, [field]: value } : n));
  const submit = async () => {
    const input = proposalInput(title, description, words, nodes.map(n => ({ key: n.key, oneLine: n.oneLine, deps: splitList(n.deps),
      fileGlobs: splitList(n.fileGlobs), estimate: n.estimate })));
    setInvalid(!input);
    if (input && await ctrl.submit(input)) onDone();
  };
  return <form className={s.form} aria-label={tr('新建 feature 提案')} onSubmit={e => { e.preventDefault(); void submit(); }}>
    <div className={s.head}>{tr('新建 feature 提案')}</div>
    <div className={v.muted}>{tr('项目、主场由本机绑定决定，不可改')}</div>
    <label>{tr('标题')}<input required value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>{tr('描述')}<textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>{tr('原话（可选）')}<textarea value={words} onChange={e => setWords(e.target.value)} /></label>
    {nodes.map((n, i) => <fieldset key={n.uid} className={s.nodeForm} disabled={state.submitting}>
      <legend>{tr('节点')} {i + 1}</legend>
      {NODE_FIELDS.map(([field, label]) => <label key={field}>{tr(label)}
        <input aria-label={`${tr(label)} ${i + 1}`} required={field === 'key' || field === 'oneLine' || field === 'fileGlobs'}
          value={n[field]} onChange={e => patch(n.uid, field, e.target.value)} /></label>)}
      <div className={s.actions}><button className={c.btn} type="button" disabled={nodes.length === 1}
        onClick={() => setNodes(nodes.filter(x => x.uid !== n.uid))}>{tr('删除节点')}</button></div>
    </fieldset>)}
    <div className={s.actions}><button className={c.btn} type="button" disabled={state.submitting}
      onClick={() => setNodes([...nodes, blank(Math.max(...nodes.map(n => n.uid)) + 1)])}><Icon name="plus" />{tr('添加节点')}</button></div>
    {invalid && <div role="alert" className={`${s.line} ${v.warn}`}>{tr('节点需有唯一代号、描述和文件范围；依赖必须存在')}</div>}
    {state.formError && <div role="alert" className={s.line}><Status status={state.formError} tr={tr} /></div>}
    <div className={s.actions}>
      <button className={c.btn} disabled={state.submitting || !title.trim()}><Icon name="send" />{tr(state.submitting ? '提交中…' : '提交提案')}</button>
      <button className={c.btn} type="button" onClick={onDone}>{tr('取消')}</button></div>
  </form>;
}

const FINAL = new Set(['published', 'rejected', 'expired', 'conflict']);
function Mine({ entries, ctrl, tr }: { entries: ProposalEntry[]; ctrl: ProposalsController; tr: Tr }) {
  return <>
    <div className={s.head}>{tr('我的提案')}</div>
    {entries.map((e, i) => <div key={e.operationId ?? i} className={v.row}>
      <div className={v.kv}>{e.title}</div>
      <Status status={e.status} tr={tr} />
      <div className={s.line}>
        {e.expiresAt !== null && <span className={v.muted}>{tr('过期时间')} {new Date(e.expiresAt).toLocaleString()}</span>}
        {e.operationId && !FINAL.has(e.status.kind) && <button type="button" className={c.btn}
          aria-label={`${tr('查询结果')} ${e.title}`} onClick={() => void ctrl.check(e.operationId!)}>{tr('查询结果')}</button>}
      </div>
    </div>)}
  </>;
}

function proposer(card: Card, tr: Tr) {
  if (card.proposer.code === 'self') return tr('我');
  return card.proposer.code ?? tr(card.proposer.type === 'service' ? '服务凭据' : '成员');
}
function ReviewCard({ card, state, ctrl, tr }: { card: Card; state: ProposalsState; ctrl: ProposalsController; tr: Tr }) {
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('');
  const owner = state.role === 'owner', busy = state.deciding !== null, off = !card.decidable || busy;
  return <div className={`${v.row} ${p.card} ${card.drift || card.expired ? p.grey : ''}`} aria-disabled={!card.decidable}>
    <div className={v.kv}>{card.title}</div>
    <div className={v.muted}>{tr('版本')} r{card.proposalRev} · {tr('提案人')} {proposer(card, tr)} · {tr('过期时间')} {new Date(card.expiresAt).toLocaleString()} · {tr('节点数')} {card.nodes.length}</div>
    {card.description && <div className={p.summary}>{card.description}</div>}
    <ul className={p.nodeList}>{card.nodes.map(n => <li key={n.key}><code>{n.key}</code> {n.oneLine}</li>)}</ul>
    {card.drift ? <div className={a.state}><Icon name="circleAlert" />{tr('漂移：中心版本已变，不能决定')}</div>
      : card.expired && <div className={a.state}><Icon name="clock" />{tr('已过期，不能决定')}</div>}
    {owner && card.decidable && card.proposer.code === 'self' && <div className={v.muted}>{tr('自己的提案也要再点一次批准')}</div>}
    {owner && <div className={s.actions}>
      <button type="button" className={c.btn} disabled={off} aria-label={`${tr('批准')} ${card.title}`}
        onClick={() => void ctrl.decide(card.proposalId, 'approve')}><Icon name="check" />{tr('批准')}</button>
      <button type="button" className={c.btn} disabled={off || rejecting} aria-label={`${tr('驳回')} ${card.title}`}
        onClick={() => setRejecting(true)}><Icon name="x" />{tr('驳回')}</button></div>}
    {owner && rejecting && <form className={s.form} onSubmit={e => { e.preventDefault(); void ctrl.decide(card.proposalId, 'reject', reason); }}>
      <label>{tr('驳回理由')}<textarea required value={reason} onChange={e => setReason(e.target.value)} /></label>
      {!reason.trim() && <div className={v.muted}>{tr('请填写驳回理由')}</div>}
      <div className={s.actions}><button className={c.btn} disabled={off || !reason.trim()}>{tr('确认驳回')}</button>
        <button className={c.btn} type="button" onClick={() => setRejecting(false)}>{tr('取消')}</button></div>
    </form>}
  </div>;
}

const NOTICE = { conflict: '提案已变化，已重读，请重新决定', unconfirmed: '决定结果未确认，未自动重发；请重读后再看',
  forbidden: '本机设备无权操作团队提案（403）', unsupported: '中心不支持提案协议（502）', failed: '读取失败' } as const;
function Review({ state, ctrl, tr }: { state: ProposalsState; ctrl: ProposalsController; tr: Tr }) {
  const n = state.notice;
  const load = state.access === 'forbidden' || state.review === 'forbidden' ? tr('待审列表需要本机 owner 设备（403）')
    : state.review === 'unsupported' ? tr('中心不支持提案协议（502）') : state.access === 'failed' || state.review === 'failed' ? tr('读取失败')
    : state.access === 'ready' && !state.localProjectId ? tr('本机未绑定该团队项目') : null;
  return <>
    <div className={s.head}>{tr('待审提案')}</div>
    {load && <div className={`${s.line} ${v.warn}`}>{load}
      {(state.access === 'failed' || state.review === 'failed') && <button type="button" className={c.btn} onClick={() => void ctrl.reread()}>{tr('重读列表')}</button>}</div>}
    {(state.access === 'loading' || state.review === 'loading') && <div className={v.muted}>{tr('正在读取…')}</div>}
    {n && <div role="status" className={`${s.line} ${a.feedback}`}>
      {n.kind === 'done' ? <><span className={a.done}><Icon name="circleCheck" /></span>{tr('决定已记录')}
        {n.state in PROPOSER_TEXT && ` · ${tr(PROPOSER_TEXT[n.state as ProposerStatus['kind']])}`}</>
        : <span className={n.kind === 'unconfirmed' ? a.state : v.warn}>{tr(NOTICE[n.kind])}</span>}
      {n.kind === 'unconfirmed' && <button type="button" className={c.btn} onClick={() => void ctrl.reread()}>{tr('重读列表')}</button>}
    </div>}
    {state.review === 'ready' && !state.cards.length && <div className={v.muted}>{tr('暂无待审提案')}</div>}
    {state.review === 'ready' && state.cards.length > 0 && state.role !== 'owner' && <div className={v.muted}>{tr('仅项目 owner 可批准或驳回')}</div>}
    {state.cards.map(card => <ReviewCard key={`${card.proposalId}:${card.proposalRev}`} card={card} state={state} ctrl={ctrl} tr={tr} />)}
  </>;
}

/** 团队规划区顶上：提案人状态 + owner 待审卡；挂载期间轮询（过期在轮询里按时钟重算） */
export function ProposalsPanel({ identity, port }: { identity: Identity; port?: FeatureProposalsPort }) {
  const { ctrl, state, tr } = useProposals(identity, port);
  useEffect(() => ctrl.start(), [ctrl]);
  return <div className={p.panel}>
    {state.mine.length > 0 && <Mine entries={state.mine} ctrl={ctrl} tr={tr} />}
    <Review state={state} ctrl={ctrl} tr={tr} />
  </div>;
}
