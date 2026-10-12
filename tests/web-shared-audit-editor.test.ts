import { expect, test } from 'bun:test';
import { parseCommand } from '../src/lib/shared-ledger-contract-v2';
import {
  beginEditor, canSubmit, changeDraft, editDraft, markConflict, refreshConflict, taskCommand,
  type TaskCard, type TaskEditorState,
} from '../web/features/collab/shared/task/task-model';
import { taskFixtureCard as base, taskFixtureCapabilities as caps, taskFixtureScope as scope } from
  '../web/features/collab/shared/task/task-fixture';

const digest = 'a'.repeat(64);
const latestBuild: TaskCard = { ...base, stage: 'build', rev: 3, specRev: 2,
  title: '最新标题', plan: '最新规划', spec: { ...base.spec, summary: '最新规格' } };
const command = (state: TaskEditorState) => parseCommand(taskCommand(state, caps, scope, digest, 'request-audit'));
function edited(state: TaskEditorState, patch: Partial<ReturnType<typeof editDraft>>) {
  if (state.draft.kind !== 'edit') throw Error('wrong draft');
  return changeDraft(state, { ...state.draft, ...patch });
}

test('[验收线 1] spec edits become retained copies when build locks title and plan', () => {
  const original = beginEditor({ ...editDraft(base), title: '我的标题', plan: '我的规划' });
  const conflict = markConflict(original, { currentRev: 3, latest: latestBuild });
  expect(conflict.draft).toEqual(original.draft);
  expect(canSubmit(conflict, caps)).toBe(false);
  const refreshed = refreshConflict(conflict);
  expect(refreshed.draft).toMatchObject({ base: latestBuild, title: latestBuild.title,
    plan: latestBuild.plan, specSummary: latestBuild.spec.summary });
  expect(refreshed).toMatchObject({ retained: [
    { field: 'title', value: '我的标题' }, { field: 'plan', value: '我的规划' },
  ] });
  const ready = edited(refreshed, { specSummary: '新的可编辑规格', reason: '需求更新' });
  expect(canSubmit(ready, caps)).toBe(true);
  const body = command(ready);
  expect(body.type).toBe('task.spec');
  expect(body.payload).not.toHaveProperty('title');
  expect(body.payload).not.toHaveProperty('plan');
  expect(body.payload).toMatchObject({ expectedRev: 3, expectedSpecRev: 2, nextSpecRev: 3,
    spec: { summary: '新的可编辑规格' }, reason: '需求更新' });
});

test('[验收线 2] spec conflict follows latest hidden summary and enables a legal task.set', () => {
  const original = beginEditor({ ...editDraft(base), title: '我的标题' });
  const latest = { ...base, rev: 4, specRev: 3, plan: '同事规划', spec: { ...base.spec, summary: '同事摘要' } };
  const conflict = markConflict(original, { currentRev: 4, latest });
  expect(conflict.draft).toEqual(original.draft);
  expect(conflict.draft).toMatchObject({ base, specSummary: base.spec.summary });
  expect(() => command(conflict)).toThrow('task_action_disabled');
  const refreshed = edited(refreshConflict(conflict), { title: '刷新后标题' });
  expect(canSubmit(refreshed, caps)).toBe(true);
  const body = command(refreshed);
  expect(body.type).toBe('task.set');
  expect(body.payload).toEqual({ taskId: base.id, expectedRev: 4, expectedSpecRev: 3, patch: { title: '刷新后标题' } });
  expect(refreshed.draft).toMatchObject({ plan: latest.plan, specSummary: latest.spec.summary });
  expect(original.draft).toMatchObject({ base, title: '我的标题', plan: base.plan });
});

test('[验收线 1] untouched locked fields follow latest without generating retained edits', () => {
  const refreshed = refreshConflict(markConflict(beginEditor(editDraft(base)), { currentRev: 3, latest: latestBuild }));
  expect(refreshed).toMatchObject({ draft: editDraft(latestBuild), retained: [] });
});

test('[验收线 2] canSubmit rejects hidden edits and extra keys just as taskCommand does', () => {
  for (const patch of [{ specSummary: '隐藏修改' }, { reason: '隐藏原因' }, { stage: 'forged' }]) {
    const state = beginEditor({ ...editDraft(base), title: '我的标题', ...patch });
    expect(canSubmit(state, caps)).toBe(false);
    expect(() => command(state)).toThrow();
  }
});

test('[验收线 1] repeated conflicts keep retained copies and ongoing editable spec changes', () => {
  const first = refreshConflict(markConflict(beginEditor({ ...editDraft(base), title: '我的标题', plan: '我的规划' }),
    { currentRev: 3, latest: latestBuild }));
  const ongoing = edited(first, { specSummary: '未保存规格', reason: '未保存原因' });
  const next = { ...latestBuild, rev: 4, specRev: 3, title: '更新标题', spec: { ...latestBuild.spec, summary: '更新规格' } };
  const conflict = markConflict(ongoing, { currentRev: 4, latest: next });
  expect(conflict.draft).toEqual(ongoing.draft);
  const refreshed = refreshConflict(conflict);
  expect(refreshed).toMatchObject({ retained: [{ field: 'title', value: '我的标题' }, { field: 'plan', value: '我的规划' }] });
  expect(refreshed.draft).toMatchObject({ title: next.title, plan: next.plan, specSummary: '未保存规格', reason: '未保存原因' });
  expect(canSubmit(refreshed, caps)).toBe(true);
  expect(command(refreshed).payload).toMatchObject({ expectedRev: 4, expectedSpecRev: 3 });
});

test('[验收线 2] returning to spec retains hidden user edits without putting them in task.set', () => {
  const original = beginEditor({ ...editDraft(latestBuild), specSummary: '我的规格', reason: '我的原因' });
  const latest = { ...latestBuild, stage: 'spec', rev: 4 };
  const refreshed = refreshConflict(markConflict(original, { currentRev: 4, latest }));
  expect(refreshed).toMatchObject({ retained: [
    { field: 'specSummary', value: '我的规格' }, { field: 'reason', value: '我的原因' },
  ] });
  expect(command(edited(refreshed, { title: '新标题' })).type).toBe('task.set');
});
