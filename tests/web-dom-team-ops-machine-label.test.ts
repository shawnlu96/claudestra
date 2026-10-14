/**
 * team-parity-UXTERM5：团队操作区（审批 / 开卡 / 执行）的机器标签不再说「主场」，三处共用 MACHINE_WORDS.machine，
 * 中英文都等于词表里的句子、不含「主场」/ home；审批面板的「原文」一行也换成词表句。happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ExecTransport, ExecView } from '../web/lib/api/shared-ledger-v2';
import { sharedExecTr } from '../web/lib/i18n-dict-shared-ledger-v2';
import { MACHINE_WORDS, ownerWordEn } from '../web/lib/owner-words';
import { approveFixtureNames, approveFixtureNow, approveFixtureOwner, approveFixtureScope, approveFixtureScopeView } from '../web/features/collab/shared/approve/approve-fixture';
import { taskFixtureCapabilities, taskFixtureCard, taskFixtureCreate, taskFixtureNames, taskFixtureScope } from '../web/features/collab/shared/task/task-fixture';
import type { ExecContext } from '../web/features/collab/shared/exec/exec-model';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type ReactDomClient = typeof import('../web/node_modules/@types/react-dom/client');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
interface El { textContent: string | null; querySelectorAll(s: string): ArrayLike<El>; remove(): void }
interface Doc { createElement(tag: string): El; body: { appendChild(c: El): void } }
type Component = (props: object) => ReturnType<ReactNS['createElement']>;
let React: ReactNS, createRoot: ReactDomClient['createRoot'], doc: Doc;
let ApprovalPanel: Component, TaskEditor: Component, ExecPanel: Component;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react'); ({ createRoot } = webRequire('react-dom/client'));
  ({ ApprovalPanel } = await import('../web/features/collab/shared/approve/approve-panel.tsx' as string));
  ({ TaskEditor } = await import('../web/features/collab/shared/task/task-forms.tsx' as string));
  ({ ExecPanel } = await import('../web/features/collab/shared/exec/exec-panel.tsx' as string));
  doc = (globalThis as unknown as { document: Doc }).document;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const LABEL = { zh: '任务所在的机器', en: 'The machine running the task' } as const;
const OLD = /主场|\bhome\b/i;

async function spans(component: Component, props: object) {
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => { root.render(React.createElement(component, props)); await new Promise(r => setTimeout(r, 15)); });
  const out = { text: host.textContent ?? '', spans: Array.from(host.querySelectorAll('span')).map(s => s.textContent ?? '') };
  await React.act(async () => root.unmount()); host.remove();
  return out;
}

const execContext: ExecContext = { mode: 'on', localProjectId: 'project', scope: taskFixtureScope, viewer: { role: 'member', instanceId: 'local' },
  repository: 'team/repository', instanceNames: taskFixtureNames };
const execView = (): ExecView => ({ ...taskFixtureScope, serverSeq: 40, feature: { id: 'feature', rev: 7, homeInstanceId: 'local',
  authorityMode: 'execution', epoch: 1, currentVersion: 1 }, tasks: [taskFixtureCard], pendingAsks: [], capabilities: taskFixtureCapabilities });
const transport: ExecTransport = { snapshot: async () => execView(), command: async () => ({}), receipt: async () => ({}),
  ask: async () => approveFixtureScopeView.ask };

test('词表：机器标签复用 MACHINE_WORDS.machine，英文由 ownerWordEn 给、执行字典能翻', () => {
  expect(MACHINE_WORDS.machine).toBe(LABEL.zh);
  expect(ownerWordEn(MACHINE_WORDS.machine)).toBe(LABEL.en);
  expect(sharedExecTr('en')(MACHINE_WORDS.machine)).toBe(LABEL.en);
  expect(sharedExecTr('en')(MACHINE_WORDS.originalThere)).toBe(ownerWordEn(MACHINE_WORDS.originalThere)!);
  expect(sharedExecTr('en')('主场')).toBe('主场'); // 旧键已删，不再有 Home
});

for (const lang of ['zh', 'en'] as const) {
  const tr = sharedExecTr(lang);
  test(`审批面板（${lang}）：机器标签 = 新句 · 机器名；原文一行是词表句；全文不含主场 / home`, async () => {
    const ui = await spans(ApprovalPanel, { view: approveFixtureScopeView, viewer: approveFixtureOwner, scope: approveFixtureScope,
      now: approveFixtureNow, instanceNames: approveFixtureNames, submit: async () => ({ ok: true }), onClose: () => {}, tr });
    expect(ui.spans).toContain(`${LABEL[lang]} · 本机`);
    expect(ui.spans).toContain(`${tr('原文')} · ${tr(MACHINE_WORDS.originalThere)}`);
    expect(ui.text).not.toMatch(OLD);
  });
  test(`开卡表单（${lang}）：机器标签 = 新句 · 机器名；全文不含主场 / home`, async () => {
    const ui = await spans(TaskEditor, { tr, initialDraft: taskFixtureCreate, capabilities: taskFixtureCapabilities, scope: taskFixtureScope,
      instanceNames: taskFixtureNames, observedAt: null, now: 1000, submit: async () => ({ ok: true }), onClose: () => {} });
    expect(ui.spans).toContain(`${LABEL[lang]} · 本机`);
    expect(ui.text).not.toMatch(OLD);
  });
  test(`执行面板（${lang}）：机器标签 = 新句 · 机器名；全文不含主场 / home`, async () => {
    const ui = await spans(ExecPanel, { featureId: 'feature', taskId: null, context: execContext, transport, port: { context: () => execContext },
      now: 1000, language: lang });
    expect(ui.spans).toContain(`${LABEL[lang]} · 本机`);
    expect(ui.text).not.toMatch(OLD);
  });
}
