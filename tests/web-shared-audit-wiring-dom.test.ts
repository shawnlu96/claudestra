/**
 * UIEXEC1 [验收线 1] DOM: the formal TeamSource wrapper (not fixture-harness) injects sharedExec; the same ExecEntry/ExecPanel
 * mounts from the bridge context. on = home/serverSeq and writes, observe = read-only, off = no execution DOM and no execution read.
 * Old red: TeamSource injected no sharedExec, so the slot stayed empty in every mode.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { setAppConfigForTest } from '../web/lib/app-config';
import type { Transport } from '../web/lib/api/shared-ledger';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type ReactDomClient = typeof import('../web/node_modules/@types/react-dom/client');
type Component = (props: Record<string, unknown>) => ReturnType<ReactNS['createElement']>;
interface El { textContent: string | null; innerHTML: string; disabled: boolean; querySelectorAll(s: string): ArrayLike<El>; remove(): void }
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
let React: ReactNS, createRoot: ReactDomClient['createRoot'], TeamSource: Component, ExecEntry: Component;
let Context: Parameters<ReactNS['useContext']>[0];
let collabProject: (i: object) => string;
const identity = { center: 'center', team: 'team-a', person: 'person-a', project: 'claude-orchestrator', machine: 'local' };
const FEATURE = 'feature-exec';
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react'); ({ createRoot } = webRequire('react-dom/client'));
  ({ TeamSource } = await import('../web/features/collab/shared/team-ops.tsx' as string));
  ({ ExecEntry } = await import('../web/features/collab/shared/exec/exec-entry.tsx' as string));
  ({ CollabSourceContext: Context } = await import('../web/features/collab/team-source-context.ts' as string));
  ({ sharedCollabProject: collabProject } = await import('../web/features/collab/team-source-key.ts' as string));
  setAppConfigForTest({ mode: 'direct', fp: 'local', machineName: 'synthetic', version: '' });
});
afterAll(async () => {
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
/** V1 planning reads are out of scope here; the TV1 list is supplied to the slot as use-collab would. */
const planning: Transport = { list: () => new Promise(() => {}), detail: () => new Promise(() => {}),
  command: () => Promise.reject(new Error('unused')), receipt: () => Promise.reject(new Error('unused')) };
function Slot() {
  const source = React.useContext(Context) as Record<string, unknown>;
  const last = () => ({ list: { features: [{ id: FEATURE, authorityMode: 'execution' }] }, team: { index: new Map() } });
  return React.createElement(ExecEntry, { source: { ...source, last }, project: collabProject(identity), taskId: null, now: Date.now() });
}
async function render(mode: 'on' | 'observe' | 'off') {
  const urls: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input); urls.push(url);
    if (url.startsWith('/api/v1/shared-exec/context?')) return mode === 'off' ? Response.json({ ok: false, code: 'unavailable' }, { status: 503 })
      : Response.json({ mode, localProjectId: 'local-project', scope: { teamId: 'team-a', projectId: 'claude-orchestrator', serviceGeneration: 1,
        epoch: 1, bootId: 'bridge-boot' }, viewer: { role: 'owner', instanceId: 'local' }, repository: 'team/repository', instanceNames: { local: '本机' } });
    if (url.startsWith(`/api/v1/shared-exec/features/${FEATURE}?`)) return Response.json(execFixtureView(FEATURE));
    return Response.json({ ok: false, code: 'not_found' }, { status: 404 });
  }) as typeof fetch);
  const host = (globalThis as unknown as { document: { createElement(t: string): El; body: { appendChild(e: El): void } } }).document.createElement('div');
  (globalThis as unknown as { document: { body: { appendChild(e: El): void } } }).document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await React.act(async () => { root.render(React.createElement(TeamSource, { identity, transport: planning }, React.createElement(Slot))); });
    for (let i = 0; i < 10; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 10)); });
    const buttons = Array.from(host.querySelectorAll('button'));
    return { text: host.textContent ?? '', urls, button: (name: string) => buttons.find(b => b.textContent?.trim() === name) };
  } finally { await React.act(async () => root.unmount()); host.remove(); fetchSpy.mockRestore(); }
}

test('[验收线 1] on: formal TeamSource mounts the execution panel with home, serverSeq and enabled create', async () => {
  const r = await render('on');
  expect(r.text).toContain('共享执行'); expect(r.text).toContain('serverSeq · 40'); expect(r.text).toContain('主场 · 本机');
  expect(r.button('开卡')?.disabled).toBe(false);
  expect(r.urls).toContain(`/api/v1/shared-exec/context?teamId=team-a&projectId=claude-orchestrator&featureId=${FEATURE}`);
  // Reads go to this machine's project; the center coordinates were only the context lookup key.
  expect(r.urls).toContain(`/api/v1/shared-exec/features/${FEATURE}?project=local-project`);
});

test('[验收线 1] observe: the same panel is read-only, every write control disabled', async () => {
  const r = await render('observe');
  expect(r.text).toContain('共享执行');
  expect(r.button('开卡')?.disabled).toBe(true); expect(r.button('编辑')?.disabled).toBe(true);
});

test('[验收线 1] off: no execution DOM and no execution read beyond the local context lookup', async () => {
  const r = await render('off');
  expect(r.text).not.toContain('共享执行');
  expect(r.urls.filter(u => !u.startsWith('/api/v1/shared-exec/context?'))).toEqual([]);
});
