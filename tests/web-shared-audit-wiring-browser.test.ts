/**
 * UIEXEC1 opt-in screenshots: the formal team entry (dag/shared-navigation SharedCollabContent → TeamSource → CollabView), not the
 * exec fixture-harness. The bridge context route is an in-memory fake (on / observe / off); the center data is synthetic.
 * AUDIT_WIRING_SHOTS_DIR=<dir> runs it; AUDIT_WIRING_PHASE=before (on a checkout of origin/main) records the baseline, where
 * the same entry shows no execution panel. Every shot passes tests/helpers/ui-shot-checks.ts. AUDIT_WIRING_WIDTHS=1280,390
 * overrides the widths; files are named before-/after-<width>-<theme>-<mode>.png.
 */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
import { shotIssues, type ShotIssue } from './helpers/ui-shot-checks';

const out = process.env.AUDIT_WIRING_SHOTS_DIR, before = process.env.AUDIT_WIRING_PHASE === 'before';
const widths = (process.env.AUDIT_WIRING_WIDTHS ?? '1200,390').split(',').map(Number);
const repo = resolve(import.meta.dir, '..'), web = join(repo, 'web');
const identity = { center: 'center', team: 'team-a', person: 'person-a', project: 'claude-orchestrator', machine: 'local' };
type Mode = 'on' | 'observe' | 'off';

/** Production modules only; the entry lives in a temp dir so no harness file is added to web/. */
function entrySource() {
  return `import React from ${JSON.stringify(join(web, 'node_modules/react/index.js'))};
import { createRoot } from ${JSON.stringify(join(web, 'node_modules/react-dom/client.js'))};
import { ChatStoreProvider } from ${JSON.stringify(join(web, 'features/chat/chat-store.ts'))};
import { CollabView } from ${JSON.stringify(join(web, 'features/collab/collab-view.tsx'))};
import { SharedCollabContent, sharedCollabProject } from ${JSON.stringify(join(web, 'features/collab/dag/shared-navigation.tsx'))};
const project = sharedCollabProject(${JSON.stringify(identity)});
const h = React.createElement;
createRoot(document.getElementById('root')).render(h(ChatStoreProvider, null, h('div', { style: { position: 'absolute', inset: 0, display: 'flex' } },
  h(SharedCollabContent, { project, fallback: h(CollabView, { project }) }))));
`;
}
async function bundle(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'uiexec1-bundle-')), entry = join(dir, 'entry.ts');
  writeFileSync(entry, entrySource());
  const build = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', join(dir, 'out'),
    '--tsconfig-override', 'web/tsconfig.json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return join(dir, 'out');
}

function serve(dir: string) {
  const fx = generateTeamFixture({ features: 1, now: Date.now() }), f = fx.details[0]!, taskId = f.tasks[0]?.taskId ?? 'task';
  // A readable synthetic id: the unchanged editors print the feature id, and ui-shot-checks flags a raw UUID as a title.
  const feature = { ...f.feature, id: 'feature-exec', authorityMode: 'execution' as const }, view = execFixtureView(feature.id, taskId);
  const state = { mode: 'on' as Mode, contexts: [] as string[], snapshots: [] as string[], posts: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return Response.json({ ...fx.list, features: fx.list.features.map(x => ({ ...x, id: feature.id, authorityMode: 'execution' })) });
    if (path.startsWith('/api/v1/shared-ledger/features/')) return Response.json({ ...f, feature });
    if (path === '/api/v1/shared-projects/snapshot') return Response.json({ v: 1,
      identity: { subject: 'owner:self', kind: 'person', centerId: 'center', teamId: 'team-a', personId: 'person-a', instanceId: 'local' },
      teamRole: { available: true, value: 'owner' }, capabilities: { invite: { available: true }, leave: { available: true } }, peers: [],
      localProjects: [{ id: 'fixture-local', name: 'Synthetic project', dirs: [], personal: false, eligible: false }],
      projects: [{ centerId: 'center', teamId: 'team-a', projectId: 'claude-orchestrator', name: 'Synthetic project', rev: 1,
        status: 'active', projectRole: { available: true, value: 'owner' }, localProjectIds: ['fixture-local'] }] });
    if (path === '/api/v1/shared-feature-proposals') return Response.json({ ok: true, operations: [] });
    if (path.startsWith('/api/v1/shared-feature-proposals/projects/')) return Response.json({ ok: true, proposals: [] });
    // In-memory fake of the bridge context route: off answers as the real route does (503, before any center read).
    if (path === '/api/v1/shared-exec/context') {
      state.contexts.push(url.search);
      if (state.mode === 'off') return Response.json({ ok: false, code: 'unavailable' }, { status: 503 });
      return Response.json({ mode: state.mode, localProjectId: 'fixture-local', scope: { teamId: 'team-a', projectId: 'claude-orchestrator',
        serviceGeneration: 1, epoch: 1, bootId: 'bridge-boot' }, viewer: { role: 'owner', instanceId: 'local' },
        repository: 'team/repository', instanceNames: { local: '本机', 'peer-a': 'peer A' } });
    }
    if (path.startsWith('/api/v1/shared-exec/features/')) { state.snapshots.push(url.search); return Response.json(view); }
    if (path.startsWith('/api/v1/shared-exec/asks/')) return Response.json(view.pendingAsks[0]);
    if (path === '/api/v1/shared-exec/commands') { state.posts++; return Response.json({ status: 'unknown' }); }
    if (path.startsWith('/api/')) return Response.json({ error: 'outside synthetic fixture' }, { status: 404 });
    if (path !== '/') return ['/entry.js', '/entry.css'].includes(path) ? new Response(Bun.file(join(dir, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="${url.searchParams.get('theme') ?? 'light'}"><head><link rel="stylesheet" href="/entry.css">
      <style>html,body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}h2,h5{margin:0}*{box-sizing:border-box}</style></head>
      <body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { server, state, title: f.feature.title };
}

const region = (page: Page) => page.getByRole('region', { name: '共享执行' });
async function assertMode(page: Page, mode: Mode | 'before') {
  if (mode === 'off' || mode === 'before') {
    await page.waitForTimeout(400);
    expect(await region(page).count()).toBe(0);
    return;
  }
  await region(page).getByText('中心 serverSeq · 40').waitFor();
  const create = region(page).getByRole('button', { name: '开卡', exact: true }).last();
  if (mode === 'on') {
    expect(await create.isEnabled()).toBe(true);
    await create.click();
    await region(page).getByRole('button', { name: '审批', exact: true }).last().click();
    await page.getByRole('button', { name: '批准', exact: true }).waitFor();
    return;
  }
  // observe: the panel reads, every write control is disabled, and the approval opens as material only.
  expect(await create.isDisabled()).toBe(true);
  for (const b of await region(page).getByRole('button', { name: '编辑', exact: true }).all()) expect(await b.isDisabled()).toBe(true);
  await region(page).getByRole('button', { name: '审批', exact: true }).last().click();
  await page.waitForTimeout(200);
  expect(await page.getByRole('button', { name: '批准', exact: true }).count()).toBe(0);
}

test.skipIf(!out)('UIEXEC1 formal team entry: execution panel on / observe / off at 390 and 1200, light and dark', async () => {
  const { server, state, title } = serve(await bundle());
  mkdirSync(out!, { recursive: true });
  const evidence: Record<string, ShotIssue[]> = {};
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of widths) for (const theme of ['light', 'dark'] as const) for (const mode of (before ? ['before'] : ['on', 'observe', 'off']) as (Mode | 'before')[]) {
      state.mode = mode === 'before' ? 'on' : mode;
      const reads = state.snapshots.length, page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      page.setDefaultTimeout(8000);
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${server.url}?theme=${theme}`);
      await page.getByText(title, { exact: true }).first().waitFor();
      await page.getByRole(width < 700 ? 'button' : 'tab', { name: '团队', exact: true }).first().click();
      await assertMode(page, mode);
      if (mode === 'off') expect(state.snapshots.length).toBe(reads);
      expect(Boolean(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'))).toBe(true);
      const name = `${before ? 'before' : 'after'}-${width}-${theme}-${mode}`, issues = await shotIssues(page);
      evidence[name] = issues;
      await page.screenshot({ path: resolve(out!, `${name}.png`), fullPage: true });
      expect(issues).toEqual([]); expect(errors).toEqual([]);
      await page.close();
    }
    expect(state.posts).toBe(0);
    if (!before) {
      expect(state.contexts.every(s => s.startsWith('?teamId=team-a&projectId=claude-orchestrator&featureId='))).toBe(true);
      expect(state.snapshots.length > 0 && state.snapshots.every(s => s === '?project=fixture-local')).toBe(true);
    }
    await Bun.write(resolve(out!, `evidence-${before ? 'before' : 'after'}.json`), JSON.stringify({ widths, themes: ['light', 'dark'],
      entry: 'dag/shared-navigation SharedCollabContent → TeamSource → CollabView', contextRoute: 'in-memory fake', posts: state.posts, shotIssues: evidence }, null, 2));
  } finally { await browser.close(); server.stop(true); }
}, 180000);
