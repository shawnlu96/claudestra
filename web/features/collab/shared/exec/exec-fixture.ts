/** Synthetic browser/DOM fixture. No registry, state directory or production data is read. */
import type { ExecView } from '../../../../lib/api/shared-ledger-v2';
import type { ExecContext } from './exec-model';
import { approveFixtureMergeView } from '../approve/approve-fixture';
import { taskFixtureCapabilities, taskFixtureCard } from '../task/task-fixture';
export const execFixtureContext: ExecContext = {
  mode: 'on', localProjectId: 'claude-orchestrator', scope: { teamId: 'team-a', projectId: 'claude-orchestrator', serviceGeneration: 1, epoch: 1, bootId: 'synthetic-boot' },
  viewer: { role: 'owner', instanceId: 'local' }, repository: 'team/repository', instanceNames: { local: '本机', 'peer-a': 'peer A' },
};
export function execFixtureView(featureId: string, taskId = 'task'): ExecView {
  const expiresAt = Date.now() + 600000;
  return { teamId: 'team-a', projectId: 'claude-orchestrator', serviceGeneration: 1, serverSeq: 40,
    feature: { id: featureId, rev: 7, homeInstanceId: 'local', authorityMode: 'execution', epoch: 1, currentVersion: 1 },
    tasks: [{ ...taskFixtureCard, id: taskId, featureId }], capabilities: { ...taskFixtureCapabilities,
      'ask.answer': { enabled: true, code: null, reason: '' } },
    pendingAsks: [{ ...approveFixtureMergeView.ask, featureId, taskId,
      expiresAt, bind: { ...approveFixtureMergeView.ask.bind!, featureId, taskId, expiresAt, originalDigest: taskFixtureCard.spec.originalDigest } }],
  };
}
