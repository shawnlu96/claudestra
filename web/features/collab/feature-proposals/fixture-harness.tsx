/**
 * N7W 截图入口（只给 tests/web-feature-proposals-browser.test.ts 打包用，生产导航不 import）：?scene=<名字> 用合成数据的假 port
 * 渲染「团队规划」区里的提案表单 / 提案人状态 / owner 待审卡，不连 bridge、中心或设备。port 收到的请求记在 window.__proposalCalls。
 */
import { createRoot } from 'react-dom/client';
import type { FeatureProposalsPort, ProposalAccess, Reply } from '@/lib/feature-proposals-api';
import { Sec } from '../v4/v4-props';
import { ProposalForm, ProposalsPanel } from './proposals-view';
import c from '../collab.module.css';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'form';
const now = Date.now(), H = 3_600_000;
const calls: unknown[] = [];
(window as unknown as { __proposalCalls: unknown[] }).__proposalCalls = calls;

const node = (key: string, oneLine: string, deps: string[] = []) => ({ key, oneLine, deps, fileGlobs: ['web/features/**'], estimate: '2h' });
const card = (id: string, over: Record<string, unknown> = {}) => ({ proposalId: id, proposalRev: 2, proposalDigest: `sha256:${id}`, state: 'pending_approval',
  drift: false, title: '网页提案表单与审批卡', description: '团队视图新建 feature 改走提案接口，owner 在团队规划区审批。',
  nodes: [node('N1', '提案表单'), node('N2', 'owner 审批卡', ['N1'])], version: null, expiresAt: now + 48 * H,
  proposer: { type: 'person', code: 'self' }, ...over });
const op = (id: string, title: string, state: string, issue: string | null = null, over: Record<string, unknown> = {}) => ({
  operationId: id, projectId: 'project-demo', title, state, issue, featureId: null, version: null, expiresAt: now + 72 * H, createdAt: now, ...over });

const CARDS: Record<string, unknown[]> = {
  owner: [card('proposal-ok'), card('proposal-drift', { title: '已漂移的提案', state: 'conflict', drift: true, proposer: { type: 'service' } }),
    card('proposal-old', { title: '已过期的提案', expiresAt: now - H, proposer: { type: 'person' } })],
};
const OPS: Record<string, unknown[]> = {
  pending: [op('op-pending', '网页提案表单与审批卡', 'pending_approval')],
  sync: [op('op-sync', '中心不可达时提交的提案', 'unsynced', 'unavailable'), op('op-cached', '已到中心、这次没查到的提案', 'pending_approval', 'unavailable')],
  published: [op('op-pub', '网页提案表单与审批卡', 'published', null, { featureId: 'feature-7f3a', version: 1 })],
  terminal: [op('op-rej', '被驳回的提案', 'rejected'), op('op-exp', '过期的提案', 'expired'), op('op-con', '冲突的提案', 'conflict')],
  unsupported: [op('op-502', '中心协议不支持时提交的提案', 'unsynced', 'unsupported')],
};
const role = scene === 'member' ? 'member' : 'owner';
const cards = CARDS[['owner', 'member', 'reject', 'd409', 'd503'].includes(scene) ? 'owner' : scene] ?? [];
const decideReply: Reply = scene === 'd409' ? { status: 409, body: { ok: false, code: 'stale_rev' } }
  : scene === 'd503' ? { status: 503, body: { ok: false, code: 'center_unavailable' } } : { status: 200, body: { ok: true, state: 'rejected' } };
const port: FeatureProposalsPort = {
  submit: async input => {
    calls.push({ kind: 'submit', input });
    if (scene === 'guest') return { status: 403, body: { ok: false, code: 'owner_required' } };
    const operation = op(`op-new-${calls.length}`, input.title, 'pending_approval');
    (OPS[scene] ??= []).unshift(operation);
    return { status: 200, body: { ok: true, state: 'pending_approval', operation } };
  },
  operations: async () => ({ status: 200, body: { ok: true, operations: OPS[scene] ?? [] } }),
  operation: async id => ({ status: 202, body: { ok: false, code: 'pending_sync', operation: op(id, '', 'unsynced') } }),
  access: async (): Promise<ProposalAccess> => scene === 'guest' ? { status: 403, role: null, localProjectId: null } : { status: 200, role, localProjectId: 'proj-bound' },
  review: async () => scene === 'unsupported' ? { status: 502, body: { ok: false, code: 'unsupported' } } : { status: 200, body: { ok: true, proposals: cards } },
  decide: async (local, d) => { calls.push({ kind: 'decide', local, ...d }); return decideReply; },
};
const identity = { center: 'center', team: 'team-a', person: 'person-a', project: 'project-demo', machine: `fixture-${scene}` };

function Harness() {
  return <div className={c.tokens} style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 16 }}>
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <Sec title="团队规划">
        <ProposalsPanel identity={identity} port={port} />
        {(scene === 'form' || scene === 'guest') && <ProposalForm identity={identity} port={port} onDone={() => undefined} />}
      </Sec>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
