/**
 * UIWRITE2: the formal TeamSource planning panel after a confirmed save. English copy for the saved-refresh notices,
 * retry follows the error's source (a failed open reopens; only a post-save refresh failure re-reads the save), and
 * a retry in flight is disabled while late refresh results never overwrite a newer open / edit.
 * Synthetic fixture and fake Transport only; detail responses are scripted per call so their order is controlled.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { setAppConfigForTest } from '../web/lib/app-config';
import { sharedLedgerTr } from '../web/lib/i18n-dict-shared-ledger';
import { ApiError } from '../web/lib/api/client';
import type { Command, FeatureDetail, Transport } from '../web/lib/api/shared-ledger';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let React: any, createRoot: any, TeamSource: any, Context: any, setLang: (l: 'zh' | 'en') => void;
/** tests/ has no DOM lib: the few element members used here. */
interface El { textContent: string | null; disabled: boolean; getAttribute(n: string): string | null; click(): void;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; closest(s: string): El | null; remove(): void;
  appendChild(e: El): void; dispatchEvent(e: unknown): boolean }
const SAVED = ['已保存，详情刷新失败', '已保存，总览刷新失败', '已保存，详情和总览刷新失败'];
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react'); ({ createRoot } = webRequire('react-dom/client'));
  ({ TeamSource } = await import('../web/features/collab/shared/team-ops.tsx' as string));
  ({ CollabSourceContext: Context } = await import('../web/features/collab/team-source-context.ts' as string));
  ({ setLang } = await import('../web/lib/i18n.tsx' as string));
  setAppConfigForTest({ mode: 'direct', fp: 'local', machineName: 'synthetic', version: '' });
});
afterAll(async () => {
  setLang('zh'); setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

type Reply = 'ok' | 'fail' | { gate: Promise<void>; fail?: boolean };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 5)); }); };
function deferred() { let open!: () => void; const gate = new Promise<void>(r => { open = r; }); return { gate, open }; }

/** Mounts TeamSource with a slot that loads the overview once (as use-collab would) and renders the feature-level ops. */
async function mount(run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const h = await harness();
  try { await run(h); } finally { await h.unmount(); }
}
async function harness() {
  const fx = generateTeamFixture();
  let detail: FeatureDetail = structuredClone(fx.details.at(-1)!);
  const replies: Reply[] = [], commands: Command[] = [], reads: string[] = [];
  const transport: Transport = {
    list: async () => ({ ...fx.list, features: [detail.feature] }),
    detail: async id => {
      reads.push(id);
      const r = replies.shift() ?? 'ok';
      if (typeof r === 'object') await r.gate;
      if (r === 'fail' || (typeof r === 'object' && r.fail)) throw new ApiError('synthetic detail failure', 500, {});
      return structuredClone(detail);
    },
    command: async c => {
      commands.push(c as Command);
      detail = { ...detail, feature: { ...detail.feature, rev: detail.feature.rev + 1, version: detail.feature.version + 1 } };
      return { schemaVersion: 1, requestId: c.requestId, commandDigest: 'synthetic', serverSeq: fx.list.serverSeq + 1, committedAt: fx.now,
        result: { featureId: detail.feature.id, rev: detail.feature.rev, version: detail.feature.version } };
    },
    receipt: () => Promise.reject(new Error('unused')),
  };
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const identity = { center: 'center', team: fx.team, person: 'person-a', project: fx.project, machine: 'local' };
  function Slot() {
    const source = React.useContext(Context);
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => { void source.overview(new AbortController().signal).then(() => setReady(true)); }, [source]);
    return ready ? source.ops(null, fx.now) : null;
  }
  const doc = (globalThis as unknown as { document: { createElement(t: string): El; body: El } }).document, host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(TeamSource, { identity, transport }, React.createElement(Slot))); });
  await flush();
  const buttons = () => Array.from(host.querySelectorAll('button'));
  const button = (name: RegExp | string) => buttons().find(b => typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  const click = async (name: RegExp | string) => {
    const b = button(name); if (!b) throw new Error(`no button ${name}: ${host.textContent}`);
    await React.act(async () => { b.click(); }); await flush();
  };
  /** Concurrency probe: fires the button's handler even while it is disabled, as a racing second open would. */
  const force = async (name: RegExp | string) => {
    const b = button(name) as unknown as Record<string, { onClick(): void }>;
    await React.act(async () => { b[Object.keys(b).find(k => k.startsWith('__reactProps'))!]!.onClick(); }); await flush();
  };
  const alert = () => host.querySelector('[role="alert"]')?.textContent ?? null;
  const save = async () => {
    await click(/编辑规划|Edit plan/);
    const reason = host.querySelector('textarea[required]')!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reason), 'value')!.set!;
    const { Event } = globalThis as unknown as { Event: new (t: string, o: object) => unknown };
    await React.act(async () => { setter.call(reason, 'UIWRITE2 synthetic'); reason.dispatchEvent(new Event('input', { bubbles: true })); });
    const form = reason.closest('form')!;
    await React.act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
  };
  const editing = () => !!host.querySelector('textarea[required]');
  return { fx, replies, commands, reads, host, button, click, force, alert, save, editing, flush, warn,
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); warn.mockRestore(); } };
}

test('[验收线 1] English dictionary covers all three saved-refresh notices', () => {
  const en = sharedLedgerTr('en');
  expect(SAVED.map(k => en(k))).toEqual(['Saved; detail refresh failed', 'Saved; overview refresh failed',
    'Saved; detail and overview refresh failed']);
  for (const k of SAVED) expect(en(k)).not.toMatch(/[一-鿿]/);
});

test('[验收线 1] English UI shows the saved detail-refresh notice in English', async () => {
  setLang('en');
  try {
    await mount(async h => {
      h.replies.push('ok', 'fail'); await h.save();
      expect(h.commands).toHaveLength(1);
      expect(h.alert()).toContain('Saved; detail refresh failed');
      expect(h.alert()).not.toMatch(/[一-鿿]/);
    });
  } finally { setLang('zh'); }
});

test('[验收线 2] after a save, a failed reopen retries the open and enters the editor without the old saved notice', async () => {
  await mount(async h => {
    h.replies.push('ok', 'fail'); await h.save();
    expect(h.alert()).toContain('已保存，详情刷新失败'); expect(h.editing()).toBe(false);
    h.replies.push('fail'); await h.click(/编辑规划/);
    expect(h.alert()).toContain('读取失败，保留缓存与草稿'); expect(h.editing()).toBe(false);
    const reads = h.reads.length, warned = h.warn.mock.calls.length;
    h.replies.push('ok'); await h.click('重试');
    expect(h.editing()).toBe(true); expect(h.alert()).toBeNull();
    // Exactly one detail read (the reopen); refreshSaved would warn about / re-read the old save.
    expect(h.reads.length).toBe(reads + 1);
    expect(h.warn.mock.calls.slice(warned).some(c => String(c[0]).includes('saved'))).toBe(false);
    expect(h.commands).toHaveLength(1);
  });
});

test('[验收线 3] a retry in flight disables the button; a late refresh result is discarded after a newer open', async () => {
  await mount(async h => {
    h.replies.push('ok', 'fail'); await h.save();
    const late = deferred();
    h.replies.push({ gate: late.gate, fail: true }); await h.click('重试');
    expect(h.button('重试')?.disabled).toBe(true);
    // Simulate a concurrent second open: the in-flight saved refresh must not land on it.
    expect(h.button(/编辑规划/)?.disabled).toBe(true);
    h.replies.push('ok'); await h.force(/编辑规划/);
    expect(h.editing()).toBe(true); expect(h.alert()).toBeNull();
    const reason = h.host.querySelector('textarea[required]');
    late.open(); await h.flush();
    expect(h.alert()).toBeNull(); expect(h.editing()).toBe(true);
    expect(h.host.querySelector('textarea[required]')).toBe(reason);
    expect(h.commands).toHaveLength(1);
  });
});

test('[验收线 3] a late saved refresh with a fresh detail does not overwrite the newer open', async () => {
  await mount(async h => {
    h.replies.push('ok', 'fail'); await h.save();
    const late = deferred();
    h.replies.push({ gate: late.gate }); await h.click('重试');
    expect(h.button('重试')?.disabled).toBe(true);
    expect(h.button(/编辑规划/)?.disabled).toBe(true);
    h.replies.push('fail'); await h.force(/编辑规划/);
    expect(h.alert()).toContain('读取失败，保留缓存与草稿');
    late.open(); await h.flush();
    // Neither the error nor the editor state is replaced by the old save's refresh.
    expect(h.alert()).toContain('读取失败，保留缓存与草稿'); expect(h.editing()).toBe(false);
  });
});
