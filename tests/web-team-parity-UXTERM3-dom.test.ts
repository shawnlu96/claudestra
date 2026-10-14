/** Real components in an isolated DOM child: wording checks run in ordinary CI, without Chrome or screenshot flags. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SHARED_LEDGER_CAPABILITIES } from "../src/lib/shared-ledger-contract";
import { MACHINE_WORDS } from "../web/lib/owner-words";
import { testChildEnv } from "./test-env";

const STATUS: Record<string, [string, string]> = {
  loading: ["正在向任务所在的机器读取会话…", "Reading the session from the machine running this task…"],
  home_offline: ["任务所在的机器离线，暂时看不了会话", "The machine running this task is offline, sessions cannot be viewed right now"],
  not_open: ["任务所在的机器未开放会话", "The machine running this task has not opened sessions"],
  gate_refused: ["任务所在的机器拒绝提供这张卡的会话", "The machine running this task declined to send this card's sessions"],
};

const SCRIPT = `
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/', width: 1280, height: 900 });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { TeamSource } = await import('./features/collab/shared/team-ops.tsx');
const { useCollabSource, CollabSourceContext } = await import('./features/collab/team-source-context.ts');
const { sharedCollabProject } = await import('./features/collab/team-source-key.ts');
const { generateTeamFixture } = await import('./features/collab/shared/team-fixture-gen.ts');
const { generateHomeFixture } = await import('./features/collab/shared/home-fixture-gen.ts');
const { CollabDetail } = await import('./features/collab/collab-detail.tsx');
const { ChatStoreProvider } = await import('./features/chat/chat-store.ts');
const { TeamSessionSec } = await import('./features/collab/team-session/team-session-view.tsx');
const { useCollabT } = await import('./features/collab/collab-i18n.ts');
const { setLang } = await import('./lib/i18n.tsx');
const { setTeamSessionTimingForTest } = await import('./features/collab/team-session/team-session-source.ts');
const h = React.createElement, contract = ${JSON.stringify(SHARED_LEDGER_CAPABILITIES)};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let mode = 'not_open', sequence = 0;
globalThis.fetch = async (input) => {
  const path = new URL(typeof input === 'string' ? input : input.url, 'http://localhost/').pathname;
  if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture' });
  if (path === '/api/v1/shared-ledger/features/session-feature') return Response.json({ tasks: [{ sourceTaskId: 'CARD', taskId: 'session-task' }] });
  if (path.endsWith('/session-pages')) {
    if (mode === 'loading') return new Promise(() => {});
    return Response.json({ code: mode }, { status: mode === 'home_offline' ? 503 : mode === 'not_open' ? 409 : 403 });
  }
  return Response.json({ code: 'unsupported' }, { status: 404 });
};
setTeamSessionTimingForTest({ waitMs: 2000 });
function OpsProbe({ project }) {
  const source = useCollabSource(project), [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const ctrl = new AbortController();
    source.overview(ctrl.signal).then(() => { if (!ctrl.signal.aborted) setReady(true); });
    return () => ctrl.abort();
  }, [source]);
  return ready ? source.ops('i28-A5') : null;
}
function SessionProbe({ project }) {
  return h(TeamSessionSec, { project, featureId: 'session-feature', cardId: 'CARD', tr: useCollabT() });
}
async function mount(node) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(h(ChatStoreProvider, null, node)));
  return { host, close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const tick = () => React.act(() => new Promise(r => setTimeout(r, 5)));
async function waitFor(find) {
  for (let i = 0; i < 100 && !find(); i++) await tick();
  if (!find()) throw new Error('fixture did not render');
}
const results = [];
for (const lang of ['zh', 'en']) {
  await React.act(async () => setLang(lang));
  const identity = () => ({ center: 'center', team: 'team-a', person: 'person-' + ++sequence, project: 'claude-orchestrator', machine: 'local' });
  for (const variant of ['contract', 'legacy', 'unrelated', 'empty']) {
    const fx = generateTeamFixture({ features: 1, nodes: 6 });
    const caps = variant === 'contract' ? contract : variant === 'empty' ? {} : Object.fromEntries(
      ['task.new', 'dag.bind', 'stage', 'approval'].map((a, i) => [a, { enabled: i === 0,
        code: 'forbidden', reason: variant === 'legacy' ? '请回主场处理' : 'Waiting for a grant' }]));
    fx.details[0].capabilities = caps; fx.list.capabilities = caps;
    const transport = { list: async () => fx.list, detail: async () => fx.details[0],
      command: async () => { throw new Error('unexpected write'); }, receipt: async () => { throw new Error('unexpected receipt'); } };
    const id = identity(), project = sharedCollabProject(id);
    const view = await mount(h(TeamSource, { identity: id, transport }, h(OpsProbe, { project })));
    await waitFor(() => view.host.querySelector('h5'));
    results.push({ kind: 'ops', lang, variant, text: view.host.textContent,
      buttons: [...view.host.querySelectorAll('button')].map(b => ({ title: b.title, disabled: b.disabled })) });
    await view.close();
  }
  for (const variant of ['empty', 'summary', 'review']) {
    const home = generateHomeFixture(), d = home.details['i28-A5'];
    d.task = { ...d.task, agent: null, pm: null, pr: null, extra: {} }; d.team = undefined;
    d.sessions = variant === 'empty' ? {} : { author: { agent: 'agent-dev' } };
    d.events = variant === 'empty' ? [] : [{ seq: 1, ts: d.now, actor: 'agent-dev', target: d.task.id, kind: 'note', text: 'Ready', data: {} }];
    if (variant === 'review') d.events.push({ ...d.events[0], seq: 2, kind: 'review', text: 'Review ready', data: { verdict: 'changes', round: 1 } });
    const source = { homeOnly: new Set(['events.text', 'review.text', 'sessions']), task: async () => d,
      overview: async () => home.overview, follow: async () => {} };
    const view = await mount(h(CollabSourceContext.Provider, { value: source }, h(CollabDetail, {
      project: 'fixture', id: d.task.id, rev: 1, now: d.now, ov: home.overview, reviewers: [], actions: new Map(),
      action: () => ({ kind: 'idle', text: '' }), onClose: () => {} })));
    await waitFor(() => view.host.querySelector('[data-home-only="events.text"]'));
    results.push({ kind: 'detail', lang, variant, notes: ['events.text', 'review.text', 'sessions'].map(k =>
      view.host.querySelector('[data-home-only="' + k + '"]').textContent) });
    await view.close();
  }
  for (mode of ['loading', 'home_offline', 'not_open', 'gate_refused']) {
    const project = sharedCollabProject(identity()), view = await mount(h(SessionProbe, { project }));
    await React.act(async () => view.host.querySelector('[data-session-toggle]').click());
    await waitFor(() => view.host.querySelector('[data-session-status="' + mode + '"]'));
    results.push({ kind: 'session', lang, mode, text: view.host.textContent });
    await view.close();
  }
}
setTeamSessionTimingForTest(null);
await GlobalRegistrator.unregister();
console.log(JSON.stringify(results));
`;

test("复现测试:UXTERM3 TaskOps 真契约原因去重，详情与会话中英文案在普通 CI 覆盖", () => {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", SCRIPT], {
    cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  expect({ code: child.exitCode, error: child.exitCode ? child.stderr.toString() : "" }).toEqual({ code: 0, error: "" });
  const rows = JSON.parse(child.stdout.toString()) as {
    kind: string; lang: string; variant?: string; mode?: string; text?: string; notes?: string[];
    buttons?: { title: string; disabled: boolean }[];
  }[];
  for (const row of rows) {
    const plan = row.lang === "zh" ? MACHINE_WORDS.planOnly : "View and plan only here; start and merge on the machine running the task";
    if (row.kind === "ops") {
      expect(row.text).not.toMatch(/主场|\bhome\b|\bV1\b/i);
      const phrase = row.variant === "unrelated" ? "Waiting for a grant" : plan;
      expect(row.text!.split(phrase)).toHaveLength(2);
      expect(row.buttons).toHaveLength(4);
      expect(row.buttons!.map(b => b.title)).toEqual(Array(4).fill(phrase));
      expect(row.buttons!.map(b => b.disabled)).toEqual(row.variant === "contract" || row.variant === "empty" ? [true, true, true, true] : [false, true, true, true]);
    } else if (row.kind === "detail") {
      const words = row.lang === "zh" ? [MACHINE_WORDS.visibleThere, MACHINE_WORDS.originalThere, MACHINE_WORDS.openSessionThere]
        : ["Only visible on the machine running this task", "Original text is only visible on the machine running this task", "Open sessions on the machine running this task"];
      expect(row.notes).toEqual([words[row.variant === "empty" ? 0 : 1], words[row.variant === "review" ? 1 : 0], words[row.variant === "empty" ? 0 : 2]]);
    } else {
      expect(row.text).not.toMatch(/主场|\bhome\b/i);
      expect(row.text).toContain(row.lang === "zh" ? "按页向任务所在的机器读取，只读" : "Read page by page from the machine running this task, read-only");
      expect(row.text).toContain(STATUS[row.mode!]![row.lang === "zh" ? 0 : 1]);
    }
  }
}, 35_000);
