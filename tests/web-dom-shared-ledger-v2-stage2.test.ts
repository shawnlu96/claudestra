import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { setAppConfigForTest } from '../web/lib/app-config';
import { sharedExecTransport, type ExecView, type ExecTransport } from '../web/lib/api/shared-ledger-v2';
import { sharedExecTr } from '../web/lib/i18n-dict-shared-ledger-v2';
import type { ExecContext } from '../web/features/collab/shared/exec/exec-model';
import { taskFixtureScope, taskFixtureCard, taskFixtureCapabilities, taskFixtureNames } from '../web/features/collab/shared/task/task-fixture';
import { approveFixtureMergeView, approveFixtureScopeView, approveFixtureMember, approveFixtureScope } from '../web/features/collab/shared/approve/approve-fixture';
import { parseCommand, v2ObjectDigest } from '../src/lib/shared-ledger-contract-v2';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type ReactDomClient = typeof import('../web/node_modules/@types/react-dom/client');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
interface El {
  textContent: string | null; innerHTML: string; value: string; disabled: boolean; title: string;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>;
  click(): void; dispatchEvent(event: unknown): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: { appendChild(c: El): void } }
let React: ReactNS, createRoot: ReactDomClient['createRoot'], doc: Doc;
type Component = (props: object) => ReturnType<ReactNS['createElement']>;
let ExecPanel: Component, ExecEntry: Component, ApprovalPanel: Component;
let useExecCollab: <T extends { source: object }>(state: T, project: string) => T;
let EventCtor: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react'); ({ createRoot } = webRequire('react-dom/client'));
  ({ ExecPanel } = await import('../web/features/collab/shared/exec/exec-panel.tsx' as string));
  ({ ExecEntry, useExecCollab } = await import('../web/features/collab/shared/exec/exec-entry.tsx' as string));
  ({ ApprovalPanel } = await import('../web/features/collab/shared/approve/approve-panel.tsx' as string));
  doc = (globalThis as unknown as { document: Doc }).document;
  EventCtor = (globalThis as unknown as { Event: typeof EventCtor }).Event;
  setAppConfigForTest({ mode: 'direct', fp: 'local', machineName: 'synthetic', version: '' });
});
afterAll(async () => {
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
const context: ExecContext = { mode: 'on', localProjectId: 'project', scope: taskFixtureScope, viewer: { role: 'member', instanceId: 'local' },
  repository: 'team/repository', instanceNames: taskFixtureNames };
function snapshot(): ExecView {
  return { ...taskFixtureScope, serverSeq: 40, feature: { id: 'feature', rev: 7, homeInstanceId: 'local',
    authorityMode: 'execution', epoch: 1, currentVersion: 1 }, tasks: [taskFixtureCard],
    pendingAsks: [], capabilities: taskFixtureCapabilities };
}
async function mount(component: (props: object) => ReturnType<ReactNS['createElement']>, props: object, strict = false) {
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host as never);
  const render = (p: object) => React.act(async () => {
    const child = React.createElement(component, p);
    root.render(strict ? React.createElement(React.StrictMode, null, child) : child);
  });
  await render(props);
  const buttons = () => Array.from(host.querySelectorAll('button'));
  const button = (name: string) => buttons().find(b => b.textContent?.trim() === name)!;
  const click = (b: El) => React.act(async () => { b.click(); await new Promise(resolve => setTimeout(resolve, 15)); });
  return { host, render, buttons, button, click, close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
async function panel(run: (ui: Awaited<ReturnType<typeof mount>>, posts: unknown[]) => Promise<void>, options: {
  disabled?: boolean; approval?: boolean; owner?: boolean; result?: 'conflict' | 'unknown'; language?: 'zh' | 'en';
} = {}) {
  const posts: unknown[] = [], view = snapshot();
  if (options.approval) {
    view.capabilities = { ...view.capabilities, 'ask.answer': { enabled: true, code: null, reason: '' } };
    view.pendingAsks = [{ ...approveFixtureMergeView.ask, expiresAt: 9e12,
      bind: { ...approveFixtureMergeView.ask.bind!, expiresAt: 9e12, originalDigest: taskFixtureCard.spec.originalDigest } }];
  }
  if (options.disabled) view.capabilities = { ...view.capabilities, 'task.new': { enabled: false, code: 'forbidden', reason: 'center reason' } };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).includes('/shared-exec/features/')) return Response.json(view);
    if (String(url) === '/api/v1/shared-exec/commands') {
      expect(init?.method).toBe('POST'); const c = parseCommand(JSON.parse(String(init?.body))); posts.push(c);
      if (options.result === 'conflict') return Response.json({ code: 'conflict', latest: { ...view.feature, rev: 8 } }, { status: 409 });
      if (options.result === 'unknown') return Response.json({ status: 'unknown', requestId: c.requestId });
      return Response.json({ schemaVersion: 2, teamId: c.teamId, projectId: c.projectId, requestId: c.requestId,
        commandDigest: v2ObjectDigest(c), command: c.type, serviceGeneration: c.serviceGeneration, serverSeq: 41,
        result: { epoch: c.epoch, operationId: null } });
    }
    if (String(url).includes('/shared-exec/asks/')) return Response.json(view.pendingAsks[0]);
    if (String(url).includes('/shared-exec/receipts/')) return Response.json({ status: 'unknown' });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch);
  let ui: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    ui = await mount(ExecPanel, { featureId: 'feature', taskId: null, context: options.owner ? { ...context, viewer: { role: 'owner', instanceId: 'local' } } : context,
      transport: sharedExecTransport('project'), port: { context: () => context }, now: Date.now(), language: options.language ?? 'zh' });
    await run(ui, posts);
  } finally { if (ui) await ui.close(); fetchSpy.mockRestore(); }
}
async function create(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.click(ui.buttons().find(b => ['开卡', 'Create task'].includes(b.textContent?.trim() ?? ''))!);
  const input = ui.host.querySelector('input')!;
  await React.act(async () => {
    // React tracks controlled input values, so native setter + input exercises the real onChange path.
    const proto = Object.getPrototypeOf(input);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Synthetic create');
    input.dispatchEvent(new EventCtor('input', { bubbles: true }));
  });
  const form = ui.host.querySelector('form')!;
  await React.act(async () => { form.dispatchEvent(new EventCtor('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 20)); });
}
test('stage2 DOM center capability disables create with its exact reason; home, executor and serverSeq are visible', async () => {
  await panel(async ui => {
    expect(ui.button('开卡').disabled).toBe(true); expect(ui.button('开卡').title).toBe('center reason');
    expect(ui.host.textContent).toContain('主场 · 本机'); expect(ui.host.textContent).toContain('执行地 · peer A');
    expect(ui.host.textContent).toContain('中心 serverSeq · 40');
  }, { disabled: true });
});
test('stage2 DOM create performs exactly one POST whose body passes frozen parseCommand', async () => {
  await panel(async (ui, posts) => { await create(ui); expect(posts.length).toBe(1); expect(ui.host.textContent).toContain('已保存'); });
});
test('stage2 DOM 409 enters X10 conflict state and retains the title', async () => {
  await panel(async (ui, posts) => {
    await create(ui); expect(posts.length).toBe(1); expect(ui.host.textContent).toContain('当前版本已更新；草稿仍在。');
    expect(ui.host.querySelector('input')!.value).toBe('Synthetic create');
    expect(ui.buttons().filter(b => b.textContent?.trim() === '开卡').every(b => b.disabled)).toBe(true);
  }, { result: 'conflict' });
});
test('stage2 DOM unknown only offers receipt lookup and never resubmits', async () => {
  await panel(async (ui, posts) => {
    await create(ui); expect(posts.length).toBe(1); expect(ui.host.textContent).toContain('提交状态未知，请查回执');
    expect(ui.host.textContent).not.toContain('提交失败');
    expect(ui.buttons().filter(b => b.textContent?.trim() === '开卡').every(b => b.disabled)).toBe(true);
    await ui.click(ui.button('查询回执')); expect(posts.length).toBe(1); expect(ui.host.textContent).toContain('未查到回执');
  }, { result: 'unknown' });
});
test('stage2 DOM stale data and English labels; member has no signing buttons', async () => {
  await panel(async ui => {
    await ui.render({ featureId: 'feature', taskId: null, context, transport: sharedExecTransport('project'),
      port: { context: () => context }, now: Date.now() + 31000, language: 'en' });
    expect(ui.host.textContent).toContain('Data is stale; refresh'); expect(ui.host.textContent).toContain('Center serverSeq');
  });
  const ui = await mount(ApprovalPanel, { view: approveFixtureMergeView, viewer: approveFixtureMember, scope: approveFixtureScope,
    now: 50000, instanceNames: {}, submit: async () => ({ ok: true }), onClose: () => {} });
  try { expect(ui.buttons().some(b => ['批准', '驳回'].includes(b.textContent?.trim() ?? ''))).toBe(false); } finally { await ui.close(); }
});
test('stage2 DOM off, absent port and planning feature add no DOM or requests', async () => {
  const noFetch = (async () => { throw new Error('no requests allowed'); }) as unknown as typeof fetch;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(noFetch);
  try {
    const project = 'shared-ledger:' + JSON.stringify({ center: 'center', team: 'team', person: 'person', project: 'project', machine: 'local' });
    for (const mode of ['off', 'on'] as const) for (const authorityMode of ['planning', 'execution']) {
      const source = { sharedExec: { context: () => ({ ...context, mode }) },
        last: () => ({ list: { features: [{ id: 'feature', authorityMode }] }, team: { index: new Map() } }) };
      if (mode === 'on' && authorityMode === 'execution') continue;
      const ui = await mount(ExecEntry, { source, project, taskId: null, now: Date.now() });
      try { expect(ui.host.innerHTML).toBe(''); } finally { await ui.close(); }
    }
    const ui = await mount(ExecEntry, { source: {}, project, taskId: null, now: Date.now() });
    try { expect(ui.host.innerHTML).toBe(''); } finally { await ui.close(); }
    expect(fetchSpy.mock.calls.length).toBe(0);
  } finally { fetchSpy.mockRestore(); }
});

test('stage2 DOM business approval uses X11 and a single actor-free POST; member only sees the material', async () => {
  await panel(async (ui, posts) => {
    await ui.click(ui.button('审批'));
    await ui.click(ui.button('批准'));
    expect(posts.length).toBe(1);
    expect((posts[0] as { type: string }).type).toBe('ask.answer');
  }, { approval: true, owner: true });
  await panel(async ui => {
    await ui.click(ui.button('审批'));
    expect(ui.buttons().some(b => ['批准', '驳回'].includes(b.textContent?.trim() ?? ''))).toBe(false);
  }, { approval: true });
});

test('stage2 TV1 entry uses injected local project for reads and retains central scope for commands', async () => {
  const urls: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: Parameters<typeof fetch>[0]) => {
    urls.push(String(url)); return Response.json(snapshot());
  }) as typeof fetch);
  const project = 'shared-ledger:' + JSON.stringify({ center: 'center', team: 'team', person: 'person', project: 'project', machine: 'local' });
  const source = { sharedExec: { context: () => ({ ...context, localProjectId: 'local-project' }) },
    last: () => ({ list: { features: [{ id: 'feature', authorityMode: 'execution' }] }, team: { index: new Map() } }) };
  const ui = await mount(ExecEntry, { source, project, taskId: null, now: Date.now() });
  try {
    expect(urls).toEqual(['/api/v1/shared-exec/features/feature?project=local-project']);
    expect(ui.host.textContent).toContain('中心 serverSeq · 40');
  } finally { await ui.close(); fetchSpy.mockRestore(); }
});


test('stage2 DOM preserves the original local empty state and source when execution is inactive', async () => {
  const project = 'shared-ledger:' + JSON.stringify({ center: 'center', team: 'team', person: 'person', project: 'project', machine: 'local' });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('no requests allowed'); }) as unknown as typeof fetch);
  try {
    for (const source of [{}, ...(['off', 'on'] as const).map(mode => ({
      sharedExec: { context: () => ({ ...context, mode }) },
      last: () => ({ list: { features: [{ id: 'feature', authorityMode: mode === 'off' ? 'execution' : 'planning' }] }, team: { index: new Map() } }),
    }))]) {
      const state = { source };
      const Probe = () => {
        const result = useExecCollab(state, project);
        expect(result).toBe(state); expect(result.source).toBe(source);
        expect('ops' in result.source).toBe(false);
        return React.createElement('div', null, '这个项目还没有台账');
      };
      const ui = await mount(Probe, {});
      try { expect(ui.host.innerHTML).toBe('<div>这个项目还没有台账</div>'); } finally { await ui.close(); }
    }
    expect(fetchSpy.mock.calls.length).toBe(0);
  } finally { fetchSpy.mockRestore(); }
});

test('stage2 DOM unknown approval only asks for a receipt in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    const ui = await mount(ApprovalPanel, { view: approveFixtureMergeView, viewer: { role: 'owner', instanceId: 'local' },
      scope: approveFixtureScope, now: 50000, instanceNames: {}, tr: sharedExecTr(language),
      submit: async () => ({ ok: false, code: 'unknown' }), onClose: () => {} });
    try {
      await ui.click(ui.button(language === 'zh' ? '批准' : 'Approve'));
      expect(ui.host.textContent).toContain(sharedExecTr(language)('提交状态未知，请查回执'));
      expect(ui.host.textContent).not.toContain(sharedExecTr(language)('提交失败'));
    } finally { await ui.close(); }
  }
});

test('stage2 DOM StrictMode reloads with a live signal and refresh remains usable', async () => {
  const signals: AbortSignal[] = [];
  const transport: ExecTransport = {
    snapshot: async (_id, signal) => {
      signals.push(signal);
      if (signal.aborted) throw new Error('aborted snapshot');
      return { ...snapshot(), serverSeq: 40 + signals.length };
    },
    command: async () => { throw new Error('unused'); },
    receipt: async () => { throw new Error('unused'); }, ask: async () => { throw new Error('unused'); },
  };
  const ui = await mount(ExecPanel, { featureId: 'feature', taskId: null, context, transport,
    port: { context: () => context }, now: Date.now(), language: 'zh' }, true);
  try {
    expect(signals.length).toBe(2); expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(false);
    expect(ui.host.textContent).toContain('中心 serverSeq · 42');
    await ui.click(ui.button('刷新'));
    expect(signals[2]!.aborted).toBe(false); expect(ui.host.textContent).toContain('中心 serverSeq · 43');
  } finally { await ui.close(); }
  expect(signals[1]!.aborted).toBe(true);
});


function countingTransport(view: (signal: AbortSignal) => ExecView) {
  const signals: AbortSignal[] = [];
  const transport: ExecTransport = {
    snapshot: async (_id, signal) => { signals.push(signal); return view(signal); },
    command: async () => { throw new Error('unused'); },
    receipt: async () => { throw new Error('unused'); }, ask: async () => { throw new Error('unused'); },
  };
  return { signals, transport };
}
test('stage2 DOM fresh scope objects with identical fields read the snapshot once', async () => {
  const { signals, transport } = countingTransport(() => snapshot());
  const props = (n: number) => ({ featureId: 'feature', taskId: null, context: { ...context, scope: { ...taskFixtureScope } },
    transport, port: { context: () => context }, now: Date.now() + n, language: 'zh' });
  const ui = await mount(ExecPanel, props(0));
  try {
    for (let n = 1; n <= 5; n++) await ui.render(props(n));
    expect(signals.length).toBe(1); expect(signals[0]!.aborted).toBe(false);
  } finally { await ui.close(); }
});
test('stage2 DOM any scope identity field change refetches once and aborts the previous read', async () => {
  for (const change of [{ epoch: 2 }, { bootId: 'synthetic-boot-2' }, { serviceGeneration: 2 }] as Partial<typeof taskFixtureScope>[]) {
    let scope = taskFixtureScope;
    const { signals, transport } = countingTransport(() => ({ ...snapshot(), ...scope,
      feature: { ...snapshot().feature, epoch: scope.epoch } }));
    const props = () => ({ featureId: 'feature', taskId: null, context: { ...context, scope: { ...scope } },
      transport, port: { context: () => context }, now: Date.now(), language: 'zh' });
    const ui = await mount(ExecPanel, props());
    try {
      expect(signals.length).toBe(1);
      scope = { ...taskFixtureScope, ...change };
      await ui.render(props()); await ui.render(props());
      expect(signals.length).toBe(2); expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(false);
      expect(ui.host.textContent).toContain('中心 serverSeq · 40');
    } finally { await ui.close(); }
  }
});

test('stage2 DOM English unknown task retains only receipt guidance', async () => {
  await panel(async (ui, posts) => {
    await create(ui); expect(posts.length).toBe(1);
    expect(ui.host.textContent).toContain('Submission unknown; check receipt');
    expect(ui.host.textContent).not.toContain('Submission failed');
    await ui.click(ui.button('Check receipt')); expect(posts.length).toBe(1);
  }, { result: 'unknown', language: 'en' });
});

test('stage2 DOM ambiguous business approval holds the write until receipt lookup', async () => {
  await panel(async (ui, posts) => {
    await ui.click(ui.button('审批')); await ui.click(ui.button('批准'));
    expect(posts.length).toBe(1); expect(ui.host.textContent).toContain('提交状态未知，请查回执');
    expect(ui.host.textContent).not.toContain('提交失败');
    expect(ui.buttons().some(b => ['批准', '驳回'].includes(b.textContent?.trim() ?? ''))).toBe(false);
    await ui.click(ui.button('查询回执')); expect(posts.length).toBe(1);
  }, { approval: true, owner: true, result: 'unknown' });
});

test('stage2 DOM ambiguous atomic approval normalizes unavailable to receipt guidance without split writes', async () => {
  let writes = 0, reads = 0;
  const view = snapshot();
  view.pendingAsks = [approveFixtureScopeView.ask];
  view.capabilities = { ...view.capabilities, 'ask.answer': { enabled: true, code: null, reason: '' },
    'dag.decide': { enabled: true, code: null, reason: '' } };
  const ownerContext = { ...context, viewer: { role: 'owner' as const, instanceId: 'local' } };
  const transport: ExecTransport = { snapshot: async () => view,
    command: async () => { throw new Error('atomic approval must never split writes'); },
    receipt: async () => { throw new Error('must query atomic receipt'); }, ask: async () => approveFixtureScopeView.ask };
  const port = { context: () => ownerContext, approvalView: async () => approveFixtureScopeView,
    submitApproval: async () => { writes++; return { ok: false as const, code: 'unavailable' }; },
    receiptApproval: async () => { reads++; return { ok: false as const, code: 'unknown' }; } };
  const ui = await mount(ExecPanel, { featureId: 'feature', taskId: null, context: ownerContext, transport, port, now: 50000, language: 'zh' });
  try {
    await ui.click(ui.button('审批')); await ui.click(ui.button('批准'));
    expect(writes).toBe(1); expect(reads).toBe(0); expect(ui.host.textContent).toContain('提交状态未知，请查回执');
    expect(ui.host.textContent).not.toContain('暂时无法提交'); expect(ui.host.textContent).not.toContain('提交失败');
    await ui.click(ui.button('查询回执')); expect(writes).toBe(1); expect(reads).toBe(1);
  } finally { await ui.close(); }
});

test('stage2 DOM loading is distinct from unavailable in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    let reject!: (reason: Error) => void;
    const transport: ExecTransport = { snapshot: () => new Promise((_resolve, fail) => { reject = fail; }),
      command: async () => ({}), receipt: async () => ({}), ask: async () => approveFixtureMergeView.ask };
    const ui = await mount(ExecPanel, { featureId: 'feature', taskId: null, context, transport,
      port: { context: () => context }, now: Date.now(), language });
    try {
      expect(ui.host.textContent).toContain(language === 'zh' ? '加载中' : 'Loading');
      expect(ui.host.textContent).not.toContain(sharedExecTr(language)('执行数据暂不可用'));
      await React.act(async () => reject(new Error('offline')));
      expect(ui.host.textContent).toContain(sharedExecTr(language)('执行数据暂不可用'));
    } finally { await ui.close(); }
  }
});

test('stage2 DOM approval explains disabled execution and missing wiring in both languages', async () => {
  for (const language of ['zh', 'en'] as const) for (const [code, label] of [
    ['execution_not_shared', '共享执行尚未开放'], ['v2_unmapped', '尚未接线'],
  ]) {
    const ui = await mount(ApprovalPanel, { view: approveFixtureMergeView, viewer: { role: 'owner', instanceId: 'local' },
      scope: approveFixtureScope, now: 50000, instanceNames: {}, tr: sharedExecTr(language),
      submit: async () => ({ ok: false, code }), onClose: () => {} });
    try {
      await ui.click(ui.button(sharedExecTr(language)('批准')));
      expect(ui.host.textContent).toContain(sharedExecTr(language)(label!));
      expect(ui.host.textContent).not.toContain(sharedExecTr(language)('提交失败'));
    } finally { await ui.close(); }
  }
});

test('stage2 TV1 two operation slots share unknown writes across detail unmount and remount', async () => {
  let posts = 0, writeSignal: AbortSignal | undefined, finish!: () => void, receiptKnown = false;
  const project = 'shared-ledger:' + JSON.stringify({ center: 'center', team: 'team', person: 'person', project: 'project', machine: 'local' });
  const source = { sharedExec: { context: () => context }, last: () => ({
    list: { features: [{ id: 'feature', authorityMode: 'execution' }] },
    team: { index: new Map([['local-task', { featureId: 'feature', taskId: taskFixtureCard.id }]]) },
  }) };
  let command: ReturnType<typeof parseCommand>;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).includes('/shared-exec/features/')) return Response.json(snapshot());
    if (String(url).includes('/shared-exec/receipts/')) return Response.json(receiptKnown ? {
      status: 'committed', receipt: { schemaVersion: 2, teamId: command.teamId, projectId: command.projectId,
        requestId: command.requestId, commandDigest: v2ObjectDigest(command), command: command.type,
        serviceGeneration: command.serviceGeneration, serverSeq: 41, result: { epoch: command.epoch, operationId: null } },
    } : { status: 'unknown' });
    posts++; command = parseCommand(JSON.parse(String(init?.body))); writeSignal = init?.signal as AbortSignal;
    await new Promise<void>(resolve => { finish = resolve; });
    return Response.json({ status: 'unknown' });
  }) as typeof fetch);
  const Probe = (props: object) => {
    const { detail } = props as { detail: boolean };
    const wired = useExecCollab({ source }, project) as unknown as { source: { ops: (id: string | null) => ReturnType<ReactNS['createElement']> } };
    return React.createElement('div', null, React.createElement('div', { 'data-slot': 'team' }, wired.source.ops(null)),
      detail && React.createElement('div', { 'data-slot': 'detail' }, wired.source.ops('local-task')));
  };
  const ui = await mount(Probe, { detail: true });
  try {
    const detailHost = ui.host.querySelector('[data-slot="detail"]')!;
    await create({ ...ui, host: detailHost, buttons: () => Array.from(detailHost.querySelectorAll('button')) });
    expect(posts).toBe(1);
    expect(ui.buttons().filter(b => b.textContent?.trim() === '编辑').every(b => b.disabled)).toBe(true);
    await ui.render({ detail: false }); expect(writeSignal?.aborted).toBe(false);
    await React.act(async () => finish());
    expect(ui.host.textContent).toContain('提交状态未知，请查回执');
    await ui.render({ detail: true });
    expect(Array.from(ui.host.querySelectorAll('[role="status"]')).filter(e => e.textContent?.includes('提交状态未知')).length).toBe(2);
    expect(ui.buttons().filter(b => ['编辑', '开卡'].includes(b.textContent?.trim() ?? '')).every(b => b.disabled)).toBe(true);
    await ui.click(ui.buttons().filter(b => b.textContent?.trim() === '查询回执')[1]!); expect(posts).toBe(1);
    receiptKnown = true;
    await ui.click(ui.buttons().filter(b => b.textContent?.trim() === '查询回执')[1]!);
    expect(ui.buttons().filter(b => b.textContent?.trim() === '编辑').every(b => !b.disabled)).toBe(true);
    expect(posts).toBe(1);
  } finally { finish?.(); await ui.close(); fetchSpy.mockRestore(); }
});
