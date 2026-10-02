import { createDraft, editDraft, type TaskCapabilities, type TaskCard, type TaskScope } from './task-model';

/** Browser-safe examples for X12's shared-view adapter and screenshots. */
export const taskFixtureNames = { local: '本机', 'peer-a': 'peer A', 'peer-b': 'peer B' };
export const taskFixtureScope: TaskScope = {
  teamId: 'team', projectId: 'project', serviceGeneration: 1, epoch: 1, bootId: 'boot-local',
};
export const taskFixtureCapabilities: TaskCapabilities = {
  'task.new': { enabled: true, code: null, reason: '' },
  'task.set': { enabled: true, code: null, reason: '' },
  'task.spec': { enabled: true, code: null, reason: '' },
};
export const taskFixtureCard: TaskCard = {
  id: 'task', featureId: 'feature', title: '合成任务', plan: '规划说明', kind: 'code', stage: 'spec', rev: 2, specRev: 1,
  homeInstanceId: 'local', executorInstanceId: 'peer-a', updatedAt: 1000,
  spec: { summary: '规划说明', originalDigest: 'a'.repeat(64), sharedDigest: null, artifactId: null,
    visibility: 'home_only', repositoryPath: null, commit: null },
};
export const taskFixtureCreate = createDraft({ id: 'feature', rev: 7, homeInstanceId: 'local', authorityMode: 'execution' }, 'team/repository');
export const taskFixtureEdit = editDraft(taskFixtureCard);
export const taskFixtureInFlight = editDraft({ ...taskFixtureCard, stage: 'build', executorInstanceId: 'peer-b' });
