import type { ApprovalBind, ApprovalScope, ApprovalView, ApprovalViewer } from './approve-model';

/** Browser-safe synthetic examples for X12's shared-view adapter and screenshots: 本机 / peer A / peer B only. */
export const approveFixtureNames = { local: '本机', 'peer-a': 'peer A', 'peer-b': 'peer B' };
export const approveFixtureScope: ApprovalScope = {
  teamId: 'team', projectId: 'project', serviceGeneration: 1, epoch: 1, bootId: 'boot-local',
};
export const approveFixtureOwner: ApprovalViewer = { role: 'owner', instanceId: 'local' };
export const approveFixtureMember: ApprovalViewer = { role: 'member', instanceId: 'peer-a' };
export const approveFixtureNow = 50_000;

const digest = (c: string) => c.repeat(64);
const scopeBind: ApprovalBind = {
  taskId: null, featureId: 'feature', taskRev: null, specRev: null, workflowRev: null,
  baseVersion: 1, proposalDigest: digest('a'), head: null, originalDigest: digest('b'), sharedDigest: digest('c'),
  actionDigest: digest('d'), redactionVersion: 1, actions: ['scope.change'], homeInstanceId: 'local', expiresAt: 100_000,
};
export const approveFixtureScopeView: ApprovalView = {
  feature: { id: 'feature', rev: 3, currentVersion: 1 }, task: null,
  ask: { id: 'ask', featureId: 'feature', taskId: null, kind: 'authorize', title: '合成范围变更', context: '新增一个节点',
    options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }], allowText: false, bind: scopeBind,
    state: 'open', rev: 1, createdBy: 'person', expiresAt: 100_000 },
  proposal: { id: 'proposal', featureId: 'feature', baseVersion: 1, version: 2, reasonText: '合成原因',
    nodes: [{ key: 'write', oneLine: '合成任务' }, { key: 'check', oneLine: '合成核对' }], cancels: [], scopeChange: true,
    proposalDigest: digest('a'), expiresAt: 100_000, askId: 'ask', state: 'pending' },
  document: { summary: '规格摘要（已脱敏）', originalDigest: digest('b'), copy: null },
};
const mergeBind: ApprovalBind = {
  ...scopeBind, taskId: 'task', taskRev: 2, specRev: 1, workflowRev: 1, proposalDigest: null, head: 'e'.repeat(40),
  actions: ['merge'],
};
export const approveFixtureMergeView: ApprovalView = {
  feature: { id: 'feature', rev: 3, currentVersion: 1 }, task: { rev: 2, specRev: 1 }, proposal: null,
  ask: { ...approveFixtureScopeView.ask, id: 'ask-merge', taskId: 'task', title: '合成合并授权', bind: mergeBind },
  document: { summary: '规格摘要（已脱敏）', originalDigest: digest('b'),
    copy: { artifactId: 'artifact', sharedDigest: digest('c'), redactionVersion: 1, content: '批准共享的规格副本', visibility: 'approved_copy' } },
};
export const approveFixtureDrifted: ApprovalView = { ...approveFixtureScopeView, feature: { id: 'feature', rev: 4, currentVersion: 2 } };
export const approveFixtureExpired: ApprovalView = { ...approveFixtureScopeView,
  ask: { ...approveFixtureScopeView.ask, state: 'expired' } };
export const approveFixtureRevoked: ApprovalView = { ...approveFixtureScopeView,
  ask: { ...approveFixtureScopeView.ask, state: 'cancelled' } };
