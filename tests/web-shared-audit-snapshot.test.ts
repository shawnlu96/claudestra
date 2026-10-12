import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ExecSession, ExecSessions } from '../web/features/collab/shared/exec/exec-session';
import { execFixtureContext, execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
import type { ExecPort } from '../web/features/collab/shared/exec/exec-model';
import type { ExecCommand, ExecTransport, ExecView } from '../web/lib/api/shared-ledger-v2';
import { v2ObjectDigest } from '../src/lib/shared-ledger-contract-v2';
import { ApiError } from '../web/lib/api/client';
import { approvalCommands, beginApproval, bindDigest } from '../web/features/collab/shared/approve/approve-model';
import { approveFixtureScopeView } from '../web/features/collab/shared/approve/approve-fixture';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type Root = import('../web/node_modules/@types/react-dom/client').Root;
interface Element {
  textContent: string | null; value: string; disabled: boolean;
  querySelector(s: string): Element | null; querySelectorAll(s: string): ArrayLike<Element>;
  click(): void; dispatchEvent(e: unknown): void; remove(): void;
}
let react: ReactNS, createRoot: (e: never) => Root;
let Panel: (p: object) => ReturnType<ReactNS['createElement']>;
let doc: { createElement(s: string): Element; body: { appendChild(e: Element): void } };
let EventType: new (type: string, init: object) => unknown;
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
  react = requireWeb('react'); createRoot = requireWeb('react-dom/client').createRoot;
  Panel = (await import('../web/features/collab/shared/exec/exec-panel.tsx' as string)).ExecPanel;
  const globals = globalThis as unknown as { document: typeof doc; Event: typeof EventType; IS_REACT_ACT_ENVIRONMENT: boolean };
  doc = globals.document; EventType = globals.Event; globals.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
function receipt(c: ExecCommand) {
  return { schemaVersion: 2, teamId: c.teamId, projectId: c.projectId, requestId: c.requestId,
    commandDigest: v2ObjectDigest(c), command: c.type, serviceGeneration: c.serviceGeneration,
    serverSeq: 41, result: { epoch: c.epoch, operationId: null } };
}
function fixture() {
  const state = { reads: 0, posts: 0, seq: 40, fail: false, unknown: false, reject: false, known: false,
    sent: null as ExecCommand | null, signal: null as AbortSignal | null };
  const transport: ExecTransport = {
    snapshot: async feature => { state.reads++; if (state.fail) throw new Error('offline');
      return { ...execFixtureView(feature), serverSeq: state.seq }; },
    command: async (c, signal) => {
      state.posts++; state.sent = c; state.signal = signal;
      if (state.reject) throw new ApiError('forbidden', 403);
      if (state.unknown) return { status: 'unknown' };
      state.seq++; return receipt(c);
    },
    receipt: async () => { if (!state.known) return { status: 'unknown' }; state.seq = 41; return receipt(state.sent!); },
    ask: async () => execFixtureView('feature').pendingAsks[0]!,
  };
  return { state, transport, session: new ExecSession(transport) };
}
async function mount(f: ReturnType<typeof fixture>, overrides: object = {}) {
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host as never);
  const props = { featureId: 'feature', taskId: null, context: execFixtureContext, transport: f.transport,
    port: { context: () => execFixtureContext }, session: f.session, language: 'zh', now: Date.now(), ...overrides };
  const render = (patch: object = {}) => react.act(async () => root.render(react.createElement(Panel, { ...props, ...patch })));
  await render();
  return { host, render, button: (name: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === name)!,
    close: async () => { await react.act(async () => root.unmount()); host.remove(); } };
}
type UI = Awaited<ReturnType<typeof mount>>;
const click = async (ui: UI, name: string) => react.act(async () => {
  ui.button(name).click(); await new Promise(resolve => setTimeout(resolve, 20));
});
async function draft(ui: UI) {
  await click(ui, '开卡');
  await react.act(async () => {
    const input = ui.host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, 'Unsaved title');
    input.dispatchEvent(new EventType('input', { bubbles: true }));
  });
}
async function save(ui: UI) {
  await react.act(async () => {
    ui.host.querySelector('form')!.dispatchEvent(new EventType('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}
function seq(ui: UI, value: number) { expect(ui.host.textContent).toContain(`中心 serverSeq · ${value}`); }

test('confirmed task write refreshes both live ExecPanels once, preserving sibling draft', async () => {
  const f = fixture(), team = await mount(f), detail = await mount(f, { taskId: 'task' });
  try {
    await draft(team); await draft(detail); await save(detail);
    console.log('task confirmation:', { reads: f.state.reads, team: team.host.textContent?.match(/serverSeq · \d+/)?.[0],
      detail: detail.host.textContent?.match(/serverSeq · \d+/)?.[0] });
    seq(team, 41); seq(detail, 41); expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
    expect(team.host.querySelector('input')!.value).toBe('Unsaved title');
    await team.render({ now: Date.now() + 10 }); expect(f.state.reads).toBe(4);
  } finally { await team.close(); await detail.close(); }
});
test('first snapshot failure offers manual retry, never polls on clock renders', async () => {
  const f = fixture(); f.state.fail = true;
  const ui = await mount(f);
  try {
    for (let i = 0; i < 5; i++) await ui.render({ now: Date.now() + i });
    console.log('first failure:', { reads: f.state.reads, buttons: ui.host.querySelectorAll('button').length });
    expect(f.state.reads).toBe(1); expect(ui.button('重试')).toBeDefined();
    f.state.fail = false; await click(ui, '重试'); seq(ui, 40); expect(f.state.reads).toBe(2);
  } finally { await ui.close(); }
});
test('definite refusal, unknown write and negative receipt never trigger refresh or resubmit', async () => {
  for (const mode of ['reject', 'unknown'] as const) {
    const f = fixture(); f.state[mode] = true;
    const a = await mount(f), b = await mount(f);
    try {
      await draft(b); await save(b);
      for (let i = 0; i < 5; i++) await a.render({ now: Date.now() + i });
      if (mode === 'unknown') await click(a, '查询回执');
      expect(f.state.reads).toBe(2); expect(f.state.posts).toBe(1); seq(a, 40); seq(b, 40);
      expect(b.host.querySelector('input')!.value).toBe('Unsaved title');
    } finally { await a.close(); await b.close(); }
  }
});
test('receipt confirmation refreshes both panels without resending pending command', async () => {
  const f = fixture(); f.state.unknown = true;
  const a = await mount(f), b = await mount(f);
  try {
    await draft(b); await save(b); f.state.known = true;
    await click(b, '查询回执'); seq(a, 41); seq(b, 41);
    expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
    expect(!!b.host.querySelector('form')).toBe(false); expect(b.host.textContent).toContain('已保存');
    expect(f.session.pending).toBe(false);
  } finally { await a.close(); await b.close(); }
});
test('business approval refreshes both panels', async () => {
  const f = fixture(), a = await mount(f), b = await mount(f);
  try {
    await click(b, '审批'); await click(b, '批准');
    seq(a, 41); seq(b, 41); expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
  } finally { await a.close(); await b.close(); }
});
test('atomic approval and its receipt confirmation refresh both panels', async () => {
  for (const unknown of [false, true]) {
    const f = fixture();
    const view = { ...execFixtureView('feature'), pendingAsks: [approveFixtureScopeView.ask],
      capabilities: { ...execFixtureView('feature').capabilities, 'dag.decide': { enabled: true, code: null, reason: '' } } };
    f.transport.snapshot = async () => { f.state.reads++; return { ...view, serverSeq: f.state.seq }; };
    const port: ExecPort = { context: () => execFixtureContext, approvalView: async () => approveFixtureScopeView,
      submitApproval: async () => { f.state.posts++; if (unknown) return { ok: false, code: 'unknown' }; f.state.seq++; return { ok: true }; },
      receiptApproval: async () => { f.state.seq++; return { ok: true }; } };
    const a = await mount(f, { port, now: 50000 }), b = await mount(f, { port, now: 50000 });
    try {
      await click(b, '审批'); await click(b, '批准');
      if (unknown) { expect(f.state.reads).toBe(2); await click(b, '查询回执'); }
      seq(a, 41); seq(b, 41); expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
      expect(b.host.textContent).toContain('已保存');
      if (unknown) { expect(!!b.button('批准')).toBe(false); expect(f.session.pending).toBe(false); }
    } finally { await a.close(); await b.close(); }
  }
});
test('failed refresh retains old snapshot and draft; lower serverSeq cannot overwrite it', async () => {
  const f = fixture(), ui = await mount(f);
  try {
    await draft(ui); f.state.fail = true; await click(ui, '刷新');
    seq(ui, 40); expect(ui.host.textContent).toContain('执行数据暂不可用');
    expect(ui.host.querySelector('input')!.value).toBe('Unsaved title');
    f.state.fail = false; f.state.seq = 39; await click(ui, '刷新'); seq(ui, 40);
    f.state.seq = 41; await click(ui, '刷新'); seq(ui, 41);
    expect(ui.host.querySelector('input')!.value).toBe('Unsaved title');
  } finally { await ui.close(); }
});
test('closing writer does not cancel sent write; remaining slot receives confirmation', async () => {
  const f = fixture(); let finish!: () => void;
  f.transport.command = async (c, signal) => {
    f.state.posts++; f.state.signal = signal;
    await new Promise<void>(resolve => { finish = resolve; }); f.state.seq++; return receipt(c);
  };
  const a = await mount(f), b = await mount(f);
  try {
    await draft(b); await save(b); await b.close(); expect(f.state.signal?.aborted).toBe(false);
    await react.act(async () => finish()); seq(a, 41); expect(f.state.reads).toBe(3);
  } finally { await a.close(); }
});
test('scope change aborts old snapshot and late response cannot overwrite new scope', async () => {
  const f = fixture(); let finish!: (v: ExecView) => void, oldSignal: AbortSignal | undefined;
  f.transport.snapshot = async (_id, signal) => { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); };
  const ui = await mount(f);
  try {
    const newScope = { ...execFixtureContext.scope, epoch: 2 };
    const view = execFixtureView('feature'); view.feature.epoch = 2;
    const tx = { ...f.transport, snapshot: async () => view };
    await ui.render({ context: { ...execFixtureContext, scope: newScope }, transport: tx });
    expect(oldSignal?.aborted).toBe(true);
    await react.act(async () => finish({ ...execFixtureView('feature'), serverSeq: 99 })); seq(ui, 40);
  } finally { await ui.close(); }
});
test('sessions isolate feature, local project, machine and principal invalidations', async () => {
  const f = fixture();
  const owners = ['machine-a/person-a', 'machine-b/person-a', 'machine-a/person-b'].map(id => new ExecSessions(id));
  const a = await mount({ ...f, session: owners[0]!.get('feature', 'local', f.transport) });
  const other: UI[] = [];
  const mounts = [
    () => mount({ ...f, session: owners[0]!.get('other', 'local', f.transport) }, { featureId: 'other' }),
    () => mount({ ...f, session: owners[0]!.get('feature', 'other-local', f.transport) }),
    ...owners.slice(1).map(s => () => mount({ ...f, session: s.get('feature', 'local', f.transport) })),
  ];
  for (const make of mounts) other.push(await make());
  try {
    await draft(a); await save(a); seq(a, 41);
    other.forEach(ui => seq(ui, 40)); expect(f.state.reads).toBe(6);
  } finally { await a.close(); for (const ui of other) await ui.close(); }
});

test('late write confirmation only refreshes its original scope, not the switched slot', async () => {
  const f = fixture(); let finish!: () => void;
  f.transport.command = async (c, signal) => {
    f.state.posts++; f.state.signal = signal;
    await new Promise<void>(resolve => { finish = resolve; }); f.state.seq++; return receipt(c);
  };
  const a = await mount(f), b = await mount(f);
  try {
    await draft(b); await save(b);
    const scope = { ...execFixtureContext.scope, bootId: 'another-boot' };
    await b.render({ context: { ...execFixtureContext, scope } });
    expect(f.state.signal?.aborted).toBe(false); expect(f.state.reads).toBe(3);
    await react.act(async () => finish());
    seq(a, 41); seq(b, 40); expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
  } finally { await a.close(); await b.close(); }
});
test('broadcast refresh failure preserves sibling editor and does not poll', async () => {
  const f = fixture(), a = await mount(f), b = await mount(f);
  try {
    await draft(a); await draft(b); f.state.fail = true;
    await save(b); seq(a, 40); seq(b, 40); expect(f.state.reads).toBe(4);
    expect(a.host.textContent).toContain('执行数据暂不可用');
    expect(a.host.querySelector('input')!.value).toBe('Unsaved title');
    await a.render({ now: Date.now() + 5000 }); expect(f.state.reads).toBe(4);
    f.state.fail = false; await click(a, '刷新'); seq(a, 41); expect(f.state.posts).toBe(1);
  } finally { await a.close(); await b.close(); }
});

test('concurrent atomic receipt confirmations acknowledge both callers but invalidate only once', async () => {
  const f = fixture();
  const commands = approvalCommands(beginApproval(), approveFixtureScopeView, execFixtureContext.viewer,
    execFixtureContext.scope, 50000, 'approved', await bindDigest(approveFixtureScopeView.ask.bind!),
    { answer: 'answer-request', decide: 'decide-request' });
  await f.session.approve(commands, async () => ({ ok: false, code: 'unknown' }));
  let finish!: (value: { ok: true }) => void;
  const result = new Promise<{ ok: true }>(resolve => { finish = resolve; });
  const port = { context: () => execFixtureContext, receiptApproval: async () => result };
  const a = f.session.receipt(port, new AbortController().signal), b = f.session.receipt(port, new AbortController().signal);
  finish({ ok: true });
  expect(await Promise.all([a, b])).toEqual([true, true]);
  expect(f.session.confirmed(execFixtureContext.scope)).toBe(1); expect(f.session.pending).toBe(false);
});


test('English first-read failure offers a translated Retry button', async () => {
  const f = fixture(); f.state.fail = true;
  const ui = await mount(f, { language: 'en' });
  try {
    expect(ui.host.textContent).toContain('Execution data unavailable');
    expect(ui.button('Retry')).toBeDefined(); expect(ui.button('重试')).toBeUndefined();
    f.state.fail = false; await click(ui, 'Retry'); expect(f.state.reads).toBe(2);
    expect(ui.host.textContent).toContain('Shared execution');
  } finally { await ui.close(); }
});
test('sibling confirmation preserves an in-flight approval read through either port', async () => {
  for (const full of [false, true]) {
    const f = fixture(); let finish!: () => void, signal: AbortSignal | undefined;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    f.transport.ask = async (_id, s) => { signal = s; await waiting; return execFixtureView('feature').pendingAsks[0]!; };
    const port: ExecPort = { context: () => execFixtureContext };
    if (full) port.approvalView = async (_id, s) => {
      signal = s; await waiting; return { ...approveFixtureScopeView, ask: execFixtureView('feature').pendingAsks[0]! };
    };
    const a = await mount(f, { port }), b = await mount(f);
    try {
      await click(a, '审批'); expect(signal?.aborted).toBe(false);
      await draft(b); await save(b); seq(a, 41); seq(b, 41);
      expect(signal?.aborted).toBe(false);
      await react.act(async () => finish());
      expect(a.button('批准')).toBeDefined(); expect(a.host.querySelector('[role="alert"]')).toBeNull();
      expect(f.state.reads).toBe(4); expect(f.state.posts).toBe(1);
    } finally { finish(); await a.close(); await b.close(); }
  }
});
test('scope change cancels approval reads and ignores their late response', async () => {
  const f = fixture(); let finish!: () => void, signal: AbortSignal | undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.transport.ask = async (_id, s) => { signal = s; await waiting; return execFixtureView('feature').pendingAsks[0]!; };
  const ui = await mount(f);
  try {
    await click(ui, '审批');
    await ui.render({ context: { ...execFixtureContext, scope: { ...execFixtureContext.scope, bootId: 'new-boot' } } });
    expect(signal?.aborted).toBe(true);
    await react.act(async () => finish()); expect(ui.button('批准')).toBeUndefined();
  } finally { finish(); await ui.close(); }
});
