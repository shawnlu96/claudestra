/** Standalone browser-safe fixture; deliberately contains missing and stale execution observations. */
import { ApiError } from '../../../lib/api/client';
import type { FeatureDetail, FeatureList, Identity, Transport } from '../../../lib/api/shared-ledger';
export const fixtureIdentity: Identity = { center: 'team-center', team: 'team-a', person: 'person-a', project: 'claudestra', machine: 'machine-a' };
export const fixtureNow = 1_790_900_000_000;
export const fixtureDetail: FeatureDetail = {
  schemaVersion: 1, teamId: 'team-a', serverSeq: 40,
  capabilities: {
    'feature.new': { enabled: true }, 'feature.set': { enabled: true }, 'dag.init': { enabled: true }, 'dag.rewrite': { enabled: true },
    'task.new': { enabled: false }, 'dag.bind': { enabled: false }, stage: { enabled: false }, approval: { enabled: false },
  },
  feature: { id: 'feature-shared', projectId: 'claudestra', title: '团队共享台账', description: '同一份规划，三台机器协作；执行仍由主场推进。',
    rev: 7, version: 2, authorityMode: 'planning', homeInstanceId: 'machine-a', executorInstanceIds: ['machine-a', 'machine-b', 'machine-c'],
    status: 'active', counts: { total: 3, completed: 1, blocked: 1, missing: 1 }, updatedBy: 'person-a', updatedAt: fixtureNow,
    projection: { sourceInstanceId: 'machine-a', sourceSeq: 30, observedAt: fixtureNow, receivedAt: fixtureNow } },
  dag: { version: 2, nodes: [
    { key: 'C1', oneLine: '冻结共享契约', deps: [], fileGlobs: ['src/lib/shared-ledger-contract*'], estimate: '30m' },
    { key: 'C4', oneLine: '团队总表与冲突草稿', deps: ['C1'], fileGlobs: ['web/features/collab/shared/**'], estimate: '2h' },
    { key: 'C5', oneLine: '网页入口与代理接入', deps: ['C4'], fileGlobs: ['web/features/collab/collab-entry.tsx'], estimate: '1h' },
  ], bindings: [{ nodeKey: 'C1', taskId: 'task-c1' }, { nodeKey: 'C5', taskId: 'task-c5' }] },
  tasks: [{ taskId: 'task-c1', sourceTaskId: 'i28-C1', sourceRev: 3, sourceSeq: 30, stage: 'done', assigneeCode: 'worker-a',
    executorInstanceId: 'machine-a', pr: 381, head: null, deps: [], specSummary: '共享契约与字段白名单', specDigest: null, fullText: 'home_only',
    steps: [], asks: [] }],
};
export const fixtureList: FeatureList = { schemaVersion: 1, teamId: 'team-a', serverSeq: 40, capabilities: fixtureDetail.capabilities,
  features: [fixtureDetail.feature,
    { ...fixtureDetail.feature, id: 'feature-capacity', title: '跨机闲置 Worker 池', homeInstanceId: 'machine-b', status: 'blocked',
      counts: { total: 8, completed: 3, blocked: 2, missing: 0 } },
    { ...fixtureDetail.feature, id: 'feature-stale', title: '执行镜像与恢复', status: 'done',
      projection: { sourceInstanceId: 'machine-c', sourceSeq: 15, observedAt: fixtureNow - 60_000, receivedAt: fixtureNow } },
  ] };
export function fixtureTransport(conflict = false): Transport {
  let detail = structuredClone(fixtureDetail);
  return {
    list: async () => ({ ...fixtureList, features: [detail.feature, ...fixtureList.features.slice(1)] }),
    detail: async () => structuredClone(detail),
    command: async command => {
      if (conflict) {
        conflict = false;
        detail = { ...detail, serverSeq: 41, feature: { ...detail.feature, rev: 8, version: 3, updatedBy: 'person-b' },
          dag: { ...detail.dag, version: 3, nodes: detail.dag.nodes.map(n => n.key === 'C4' ? { ...n, oneLine: '另一位成员更新的规划' } : n) } };
        throw new ApiError('conflict', 409, { code: 'conflict', latest: structuredClone(detail) });
      }
      if ('nodes' in command) detail = { ...detail, serverSeq: detail.serverSeq + 1,
        feature: { ...detail.feature, rev: detail.feature.rev + 1, version: detail.dag.version + 1 },
        dag: { ...detail.dag, version: detail.dag.version + 1, nodes: command.nodes } };
      return { schemaVersion: 1, requestId: command.requestId, commandDigest: 'fixture', serverSeq: detail.serverSeq,
        committedAt: fixtureNow, result: { featureId: detail.feature.id, rev: detail.feature.rev, version: detail.dag.version } };
    },
    receipt: async requestId => ({ status: 'unknown', requestId }),
  };
}
