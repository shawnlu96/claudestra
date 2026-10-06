import { expect, test } from 'bun:test';
import { parseCommand } from '../src/lib/shared-ledger-contract-v2';
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from '../src/lib/shared-ledger-contract-v2-fixtures';
import {
  beginEditor, canSubmit, changeDraft, createDraft, dataExpiry, editDraft, instanceLabel, isDataStale,
  markConflict, refreshConflict, sha256, taskCommand, type FeatureAnchor, type TaskCapabilities, type TaskCard,
} from '../web/features/collab/shared/task/task-model';

const feature: FeatureAnchor = { id: 'feature', rev: 7, homeInstanceId: 'local', authorityMode: 'execution' };
const task = V2_DTO_FIXTURES.task.valid as TaskCard;
const scope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE };
const digest = 'a'.repeat(64);
const capability = (enabled: boolean) => ({ enabled, code: enabled ? null : 'execution_not_shared', reason: enabled ? '' : '尚未开放' });
const caps: TaskCapabilities = { 'task.new': capability(true), 'task.set': capability(true), 'task.spec': capability(true) };

test('member creates a spec task in its feature with feature CAS and only planning inputs', () => {
  const draft = { ...createDraft(feature, 'team/repository'), title: '新任务', plan: '规划说明' };
  const command = parseCommand(taskCommand(beginEditor(draft), caps, scope, digest, 'request-new'));
  expect(command.type).toBe('task.new');
  if (command.type !== 'task.new') throw Error('wrong command');
  expect(command.payload).toEqual({ featureId: 'feature', expectedRev: 7, itemId: null, title: '新任务',
    plan: '规划说明', kind: 'code', repository: 'team/repository', spec: {
      summary: '规划说明', originalDigest: digest, sharedDigest: null, artifactId: null,
      visibility: 'home_only', repositoryPath: null, commit: null,
    } });
  expect(Object.keys(command.payload)).not.toContain('homeInstanceId');
});

test('editing another member’s spec card sends a whitelisted patch with both CAS versions', () => {
  const draft = { ...editDraft(task), title: '新标题', plan: '新规划' };
  const command = parseCommand(taskCommand(beginEditor(draft), caps, scope, digest, 'request-set'));
  expect(command.type).toBe('task.set');
  if (command.type !== 'task.set') throw Error('wrong command');
  expect(command.payload).toEqual({ taskId: task.id, expectedRev: task.rev, expectedSpecRev: task.specRev,
    patch: { title: '新标题', plan: '新规划' } });
});

test('an in-flight specification change produces the next specRev and keeps execution fields out', () => {
  const active = { ...task, stage: 'build', rev: 9, specRev: 3 };
  const draft = { ...editDraft(active), specSummary: '新规格', reason: '需求变化' };
  const command = parseCommand(taskCommand(beginEditor(draft), caps, scope, digest, 'request-spec'));
  expect(command.type).toBe('task.spec');
  if (command.type !== 'task.spec') throw Error('wrong command');
  expect(command.payload.expectedRev).toBe(9);
  expect(command.payload.expectedSpecRev).toBe(3);
  expect(command.payload.nextSpecRev).toBe(4);
  expect(command.payload.spec.summary).toBe('新规格');
  expect(command.payload.spec.visibility).toBe('home_only');
  expect(Object.keys(command.payload)).not.toContain('stage');
});

test('form logic rejects execution fields even when a caller constructs its draft directly', () => {
  for (const field of ['stage', 'head', 'homeInstanceId', 'executorInstanceId', 'authorizationAskId', 'mode', 'workflow']) {
    const injected = { ...editDraft(task), title: 'Changed', [field]: 'forged' };
    expect(() => taskCommand(beginEditor(injected), caps, scope, digest, 'request-forged')).toThrow('forbidden_field');
    const legal = taskCommand(beginEditor({ ...editDraft(task), title: 'Changed' }), caps, scope, digest, 'request-legal');
    if (legal.type !== 'task.set') throw Error('wrong command');
    expect(() => parseCommand({ ...legal, payload: { ...legal.payload, patch: { ...legal.payload.patch, [field]: 'forged' } } }))
      .toThrow('invalid_field');
  }
  const inFlight = { ...task, stage: 'build' };
  expect(() => taskCommand(beginEditor({ ...editDraft(inFlight), title: 'forged', specSummary: 'new', reason: 'change' }),
    caps, scope, digest, 'request-title')).toThrow('task_action_disabled');
});

test('disabled and conflict states retain the draft without resubmission', () => {
  const draft = { ...editDraft(task), plan: '未保存的内容' };
  const disabled = { ...caps, 'task.set': capability(false) };
  expect(canSubmit(beginEditor(draft), disabled)).toBe(false);
  expect(() => taskCommand(beginEditor(draft), disabled, scope, digest, 'request-disabled')).toThrow('task_action_disabled');
  const conflicted = markConflict(beginEditor(draft), { currentRev: 2, latest: { ...task, rev: 2, plan: '别人更新' } });
  expect(conflicted.draft).toEqual(draft);
  expect(canSubmit(conflicted, caps)).toBe(false);
  const refreshed = refreshConflict(conflicted);
  expect(refreshed.draft.kind).toBe('edit');
  if (refreshed.draft.kind !== 'edit') throw Error('wrong draft');
  expect(refreshed.draft.plan).toBe('未保存的内容');
  expect(refreshed.draft.base.rev).toBe(2);
  expect(canSubmit(refreshed, caps)).toBe(true);
  expect(changeDraft({ ...refreshed, phase: 'rejected' }, { ...refreshed.draft, plan: '修订' }).phase).toBe('idle');
});

test('create conflict preserves title and plan while updating feature CAS explicitly', () => {
  const draft = { ...createDraft(feature, 'team/repository'), title: '未保存', plan: '原草稿' };
  const conflicted = markConflict(beginEditor(draft), { currentRev: 8, latest: { ...feature, rev: 8 } });
  const refreshed = refreshConflict(conflicted);
  expect(refreshed.draft).toMatchObject({ title: '未保存', plan: '原草稿', feature: { rev: 8 } });
  const command = parseCommand(taskCommand(refreshed, caps, scope, digest, 'request-newer'));
  expect(command.type).toBe('task.new');
  if (command.type === 'task.new') expect(command.payload.expectedRev).toBe(8);
});

test('freshness, instance labels and browser digest have stable values', async () => {
  expect(instanceLabel('local', { local: '本机', 'peer-a': 'peer A' })).toBe('本机');
  expect(instanceLabel('peer-a', { local: '本机', 'peer-a': 'peer A' })).toBe('peer A');
  expect(dataExpiry(1000)).toBe(31_000);
  expect(isDataStale(1000, 30_999)).toBe(false);
  expect(isDataStale(1000, 31_000)).toBe(true);
  expect(await sha256('规划说明')).toMatch(/^[a-f0-9]{64}$/);
});
