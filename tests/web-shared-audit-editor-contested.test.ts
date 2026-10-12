/**
 * UIEDIT2: English copy for the conflict area, both-sides-changed editable fields stay visible, and the explicit
 * refresh no longer leaves a standing alert. Synthetic task cards and an in-memory submit only.
 * Old red: en showed 保留修改 / 我的修改 / 最新 in Chinese; a colleague's plan vanished after refresh; the retained
 * area kept role=alert「当前版本已更新；草稿仍在。」even after saving.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { sharedExecTr } from '../web/lib/i18n-dict-shared-ledger-v2';
import { sharedLedgerTr } from '../web/lib/i18n-dict-shared-ledger';
import { parseCommand } from '../src/lib/shared-ledger-contract-v2';
import {
  beginEditor, canSubmit, changeDraft, editDraft, markConflict, refreshConflict, taskCommand,
  type TaskCard, type TaskEditorState,
} from '../web/features/collab/shared/task/task-model';
import { taskFixtureCard as base, taskFixtureCapabilities as caps, taskFixtureScope as scope, taskFixtureNames } from
  '../web/features/collab/shared/task/task-fixture';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type ReactDomClient = typeof import('../web/node_modules/@types/react-dom/client');
type Component = (props: Record<string, unknown>) => ReturnType<ReactNS['createElement']>;
interface El {
  textContent: string | null; value: string; disabled: boolean; getAttribute(name: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>;
  click(): void; dispatchEvent(event: unknown): void; remove(): void;
}
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
let React: ReactNS, createRoot: ReactDomClient['createRoot'], TaskEditor: Component;
let EventCtor: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react'); ({ createRoot } = webRequire('react-dom/client'));
  ({ TaskEditor } = await import('../web/features/collab/shared/task/task-forms.tsx' as string));
  EventCtor = (globalThis as unknown as { Event: typeof EventCtor }).Event;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const digest = 'a'.repeat(64), mineTitle = '我的标题', minePlan = '我的规划';
/** The colleague changed the plan; the task may or may not have left spec. */
const colleague = (stage: string): TaskCard => ({ ...base, stage, rev: 3, specRev: stage === 'spec' ? 1 : 2,
  plan: '同事规划', spec: { ...base.spec, summary: '同事规格' } });
const command = (state: TaskEditorState) => parseCommand(taskCommand(state, caps, scope, digest, 'request-uiedit2'));
const conflicted = (latest: TaskCard) =>
  markConflict(beginEditor({ ...editDraft(base), title: mineTitle, plan: minePlan }), { currentRev: latest.rev, latest });

async function mount(language: 'zh' | 'en', latest: TaskCard) {
  const doc = (globalThis as unknown as { document: { createElement(t: string): El; body: { appendChild(c: El): void } } }).document;
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host as never), posts: unknown[] = [];
  const submit = async (body: unknown) => {
    posts.push(parseCommand(body));
    return posts.length === 1 ? { ok: false, code: 'conflict', currentRev: latest.rev, latest } : { ok: true };
  };
  await React.act(async () => root.render(React.createElement(TaskEditor, { tr: sharedExecTr(language),
    initialDraft: editDraft(base), capabilities: caps, scope, instanceNames: taskFixtureNames, observedAt: null, now: 0,
    submit, onClose: () => {} })));
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const button = (name: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === name);
  const click = (name: string) => React.act(async () => { button(name)!.click(); await settle(); });
  const fill = (el: El, value: string) => React.act(async () => {
    // React tracks controlled values, so the native setter + input event exercises the real onChange path.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new EventCtor('input', { bubbles: true }));
  });
  const send = () => React.act(async () => {
    host.querySelector('form')!.dispatchEvent(new EventCtor('submit', { bubbles: true, cancelable: true })); await settle();
  });
  const region = (label: string) => Array.from(host.querySelectorAll('[role="region"]'))
    .find(r => r.getAttribute('aria-label') === label);
  const alerts = () => Array.from(host.querySelectorAll('[role="alert"]')).map(a => a.textContent ?? '');
  await fill(host.querySelector('input')!, mineTitle); await fill(host.querySelector('textarea')!, minePlan);
  return { host, posts, button, click, fill, send, region, alerts,
    close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test('[验收线 1] en dictionary covers the conflict copy; the comparison column is Latest and Fresh stays Fresh', () => {
  const en = sharedExecTr('en');
  const expected: Record<string, string> = { '保留修改': 'Retained edits', '我的修改': 'My edit', '最新版本': 'Latest',
    '用最新': 'Use latest', '复制': 'Copy', '放弃': 'Discard', '已复制': 'Copied',
    '复制失败，请选择文字复制': 'Copy failed; select the text to copy', '（空）': '(empty)',
    '规格摘要': 'Specification summary', '规划': 'Plan' };
  for (const [zh, text] of Object.entries(expected)) expect(en(zh)).toBe(text);
  expect(sharedLedgerTr('en')('最新')).toBe('Fresh');
  expect(sharedLedgerTr('en')('用最新')).toBe(en('用最新'));
  expect(sharedExecTr('zh')('最新版本')).toBe('最新版本');
});

test('[验收线 1] en editor after refresh shows no Chinese in the conflict area and labels the column Latest', async () => {
  const ui = await mount('en', colleague('build'));
  try {
    await ui.send(); await ui.click('Refresh version and retain draft');
    const area = ui.region('Retained edits：Plan')!;
    expect(area.textContent).toContain('My edit'); expect(area.textContent).toContain('Latest');
    expect(area.textContent).not.toContain('Fresh');
    expect(ui.button('Copy')).toBeDefined(); expect(ui.button('Discard')).toBeDefined();
    const conflict = area.textContent!.replace(minePlan, '').replace('同事规划', '');
    expect(conflict).not.toMatch(/[一-鿿（）]/);
    expect(ui.host.textContent).toContain('Retained edits');
  } finally { await ui.close(); }
});

test('[验收线 2] model: both sides changed an editable field → input keeps mine and the field is contested', () => {
  const refreshed = refreshConflict(conflicted(colleague('spec')));
  expect(refreshed.draft).toMatchObject({ title: mineTitle, plan: minePlan });
  expect(refreshed).toMatchObject({ contested: ['plan'], retained: [] });
  // Submission is not blocked and carries the input's current value.
  expect(command(refreshed).payload).toMatchObject({ expectedRev: 3, patch: { title: mineTitle, plan: minePlan } });
  // A field only I changed, or one the colleague changed to the same value, is not contested.
  const same = refreshConflict(markConflict(beginEditor({ ...editDraft(base), plan: '同事规划' }),
    { currentRev: 3, latest: colleague('spec') }));
  expect(same.contested).toEqual([]);
  expect(refreshConflict(markConflict(beginEditor({ ...editDraft(base), title: mineTitle }),
    { currentRev: 3, latest: { ...base, rev: 3 } })).contested).toEqual([]);
  // A second conflict where the plan did not move again keeps the unresolved comparison.
  const again = refreshConflict(markConflict(refreshed, { currentRev: 4, latest: { ...colleague('spec'), rev: 4, title: '别人标题' } }));
  expect(again.contested).toEqual(['title', 'plan']);
  // Locked fields keep UIEDIT1 behavior: retained copies, never contested.
  expect(refreshConflict(conflicted(colleague('build')))).toMatchObject({ contested: [],
    retained: [{ field: 'title', value: mineTitle }, { field: 'plan', value: minePlan }] });
});

test('[验收线 2] DOM: the colleague plan is visible after refresh; 用最新 swaps the input and submit sends the input', async () => {
  const ui = await mount('zh', colleague('spec'));
  try {
    await ui.send(); await ui.click('刷新版本并保留草稿');
    const plan = () => ui.host.querySelector('textarea')!;
    expect(plan().value).toBe(minePlan);
    const area = ui.region('最新版本：规划')!;
    expect(area.textContent).toContain(minePlan); expect(area.textContent).toContain('同事规划');
    expect(area.textContent).toContain('我的修改'); expect(area.textContent).toContain('最新版本');
    expect(ui.region('最新版本：标题')).toBeUndefined();
    // Still visible while mine differs, even after typing more.
    await ui.fill(plan(), '我的规划 v2');
    expect(ui.region('最新版本：规划')!.textContent).toContain('我的规划 v2');
    await ui.click('用最新');
    expect(plan().value).toBe('同事规划');
    expect(ui.region('最新版本：规划')).toBeUndefined();
    await ui.send();
    expect(ui.posts[1]).toMatchObject({ type: 'task.set', payload: { expectedRev: 3, patch: { title: mineTitle } } });
    expect((ui.posts[1] as { payload: { patch: object } }).payload.patch).not.toHaveProperty('plan');
  } finally { await ui.close(); }
});

test('[验收线 2] DOM: keeping mine submits mine and the comparison stays visible after save', async () => {
  const ui = await mount('zh', colleague('spec'));
  try {
    await ui.send(); await ui.click('刷新版本并保留草稿'); await ui.send();
    expect(ui.posts[1]).toMatchObject({ type: 'task.set', payload: { patch: { title: mineTitle, plan: minePlan } } });
    expect(ui.host.textContent).toContain('已保存');
    expect(ui.region('最新版本：规划')!.textContent).toContain('同事规划');
  } finally { await ui.close(); }
});

test('[验收线 3] before refresh the alert is unchanged; after refresh and after save there is no alert', async () => {
  const ui = await mount('zh', colleague('build'));
  try {
    await ui.send();
    expect(ui.alerts()).toEqual([expect.stringContaining('当前版本已更新；草稿仍在。')]);
    expect(ui.alerts()[0]).toContain('刷新版本并保留草稿');
    await ui.click('刷新版本并保留草稿');
    expect(ui.alerts()).toEqual([]);
    expect(ui.host.textContent).not.toContain('当前版本已更新；草稿仍在。');
    expect(ui.host.textContent).toContain('保留修改');
    const reason = Array.from(ui.host.querySelectorAll('textarea'));
    await ui.fill(reason[1]!, '新规格'); await ui.fill(reason[2]!, '需求更新');
    await ui.send();
    expect(ui.posts[1]).toMatchObject({ type: 'task.spec' });
    expect(ui.host.textContent).toContain('已保存');
    expect(ui.alerts()).toEqual([]);
    expect(ui.host.textContent).not.toContain('当前版本已更新；草稿仍在。');
    const title = ui.region('保留修改：标题')!;
    expect(Array.from(title.querySelectorAll('button')).map(b => b.textContent?.trim())).toEqual(['复制', '放弃']);
    await ui.click('放弃');
    expect(ui.region('保留修改：标题')).toBeUndefined();
    expect(ui.region('保留修改：规划')).toBeDefined();
  } finally { await ui.close(); }
});

test('[验收线 2] canSubmit for a contested field is unchanged by the comparison', () => {
  const refreshed = refreshConflict(conflicted(colleague('spec')));
  expect(canSubmit(refreshed, caps)).toBe(true);
  const latestPlan = changeDraft(refreshed, { ...refreshed.draft, plan: '同事规划' } as never);
  expect(canSubmit(latestPlan, caps)).toBe(true);
});
