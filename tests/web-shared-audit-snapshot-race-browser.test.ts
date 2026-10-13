/** UISNAP2: stale-read race in the S2W production TV1 harness, synthetic HTTP only. Set UISNAP_SHOTS_DIR to opt in. */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
import { v2ObjectDigest } from '../src/lib/shared-ledger-contract-v2';
import { shotIssues } from './helpers/ui-shot-checks';
const output = process.env.UISNAP_SHOTS_DIR;
const before = process.env.UISNAP_BEFORE === '1';
const OUTAGE = '执行数据暂不可用', CARD = 'i28-A4';
function syntheticServer(bundle: string) {
  const raw = generateTeamFixture({ features: 1, now: Date.now() });
  // Execution forms show their feature key; use the same readable synthetic key in both screenshot phases.
  const fixture: typeof raw = JSON.parse(JSON.stringify(raw).replaceAll(raw.details[0]!.feature.id, 'Synthetic feature'));
  const detail = fixture.details[0]!;
  // Bind the execution task to a card the default outline shows, so team slot and detail slot hold the same feature.
  const view = execFixtureView(detail.feature.id, detail.tasks.find(t => t.sourceTaskId === CARD)!.taskId);
  const state = { seq: 40, reads: 0, posts: 0, hold: false, cancelled: 0, held: [] as (() => void)[] };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path.includes('/shared-exec/features/')) {
      state.reads++;
      if (!state.hold) return Response.json({ ...view, serverSeq: state.seq });
      // The fake port parks this read and later answers with the serverSeq it saw when the request arrived.
      const seen = { ...view, serverSeq: state.seq };
      state.hold = false;
      request.signal.addEventListener('abort', () => { state.cancelled++; });
      return new Promise<Response>(done => state.held.push(() => done(Response.json(seen))));
    }
    if (path.endsWith('/shared-exec/commands') && request.method === 'POST') {
      const c = await request.json() as { teamId: string; projectId: string; requestId: string; type: string; serviceGeneration: number; epoch: number };
      state.posts++; state.seq++;
      return Response.json({ schemaVersion: 2, teamId: c.teamId, projectId: c.projectId, requestId: c.requestId,
        commandDigest: v2ObjectDigest(c), command: c.type, serviceGeneration: c.serviceGeneration,
        serverSeq: state.seq, result: { epoch: c.epoch, operationId: null } });
    }
    if (path.includes('/shared-exec/asks/')) return Response.json(view.pendingAsks[0]);
    if (path.endsWith('/shared-ledger/features')) return Response.json({ ...fixture.list, features: fixture.list.features.map(f => ({ ...f, authorityMode: 'execution' })) });
    if (path.includes('/shared-ledger/features/')) return Response.json({ ...detail, feature: { ...detail.feature, authorityMode: 'execution' } });
    if (path.endsWith('/shared-projects/snapshot')) return Response.json({ v: 1,
      identity: { subject: 'owner:self', kind: 'person', centerId: 'center', teamId: 'team-a', personId: 'person-a', instanceId: 'local' },
      teamRole: { available: true, value: 'owner' }, peers: [],
      capabilities: { leave: { available: true }, invite: { available: true } },
      localProjects: [{ name: 'Synthetic project', id: 'fixture-local', dirs: [], eligible: false, personal: false }],
      projects: [{ projectId: 'claude-orchestrator', centerId: 'center', teamId: 'team-a', name: 'Synthetic project', rev: 1,
        status: 'active', localProjectIds: ['fixture-local'], projectRole: { available: true, value: 'owner' } }] });
    if (path.includes('/shared-feature-proposals/projects/')) return Response.json({ ok: true, proposals: [{
      proposalId: 'proposal-n7w', proposalRev: 2, proposalDigest: 'sha256:n7w', state: 'pending_approval', drift: false,
      title: '网页提案表单与审批卡', description: 'N7W 合成审批卡，用作同屏视觉基准', version: null,
      expiresAt: view.pendingAsks[0]!.expiresAt, proposer: { type: 'person', code: 'self' },
      nodes: [{ key: 'N1', oneLine: '复用现有协作组件', deps: [], fileGlobs: ['web/**'], estimate: '2h' }],
    }] });
    if (path.includes('/shared-feature-proposals')) return Response.json({ ok: true, operations: [], proposals: [] });
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path.startsWith('/api/')) return Response.json({ error: 'outside synthetic fixture' }, { status: 404 });
    if (path.endsWith('.js') || path.endsWith('.css')) {
      const file = path.slice(1);
      return ['fixture-harness.js', 'fixture-harness.css'].includes(file) ? new Response(Bun.file(join(bundle, file))) : new Response(null, { status: 404 });
    }
    return new Response(`<!doctype html><html data-theme="${url.searchParams.get('theme')}"><head>
      <link rel="stylesheet" href="/fixture-harness.css"><style>
      html,body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h2,h5{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div>
      <script type="module" src="/fixture-harness.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { state, server, title: detail.feature.title };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('condition not reached');
}
async function capture(page: Page, name: string) {
  const issues = await shotIssues(page);
  await page.screenshot({ path: resolve(output!, name + '.png'), fullPage: true });
  expect(issues).toEqual([]);
  return { file: name + '.png', shotIssues: issues };
}
async function scenario(page: Page, f: ReturnType<typeof syntheticServer>, width: number, theme: string) {
  const narrow = width < 700;
  Object.assign(f.state, { seq: 40, reads: 0, posts: 0, hold: false, cancelled: 0, held: [] });
  await page.goto(`${f.server.url}?mode=on&theme=${theme}`);
  await page.getByText(f.title, { exact: true }).first().waitFor();
  await page.getByRole(narrow ? 'button' : 'tab', { name: '团队', exact: true }).first().click();
  const panels = page.getByLabel('共享执行');
  await panels.first().waitFor();
  // Wide S2W keeps the team slot beside the task detail slot. The narrow layout mounts one slot at a time,
  // so there the same slot both refreshes and saves (the base race between manual refresh and its own post-save read).
  if (!narrow) await page.getByText(CARD, { exact: true }).first().click();
  const slots = narrow ? 1 : 2;
  await until(async () => await panels.count() === slots);
  const a = panels.first(), b = panels.last();
  await a.getByText('中心 serverSeq · 40').waitFor(); await b.getByText('中心 serverSeq · 40').waitFor();
  expect(f.state.reads).toBe(slots);
  // A: manual refresh, parked by the fake port while the center is still at 40.
  f.state.hold = true;
  await a.getByRole('button', { name: '刷新' }).click();
  await until(() => f.state.held.length === 1);
  // B: a confirmed save moves the center to 41; every live slot re-reads on that confirmation.
  await b.getByRole('button', { name: '审批', exact: true }).click();
  await b.getByRole('button', { name: '批准', exact: true }).click();
  await b.getByText('已保存', { exact: true }).waitFor();
  await a.getByText('中心 serverSeq · 41').waitFor(); await b.getByText('中心 serverSeq · 41').waitFor();
  expect(f.state.posts).toBe(1); expect(f.state.reads).toBe(slots * 2 + 1);
  // Now the slow read answers 40.
  f.state.held[0]!();
  const alert = a.getByRole('alert').filter({ hasText: OUTAGE });
  if (before) await alert.waitFor(); else await page.waitForTimeout(400);
  await a.getByText('中心 serverSeq · 41').waitFor();
  expect(await alert.count()).toBe(before ? 1 : 0);
  expect(await page.getByText(OUTAGE).count()).toBe(before ? 1 : 0);
  expect(f.state.reads).toBe(slots * 2 + 1); expect(f.state.posts).toBe(1);
  return { ...await capture(page, `race-${width}-${theme}`), slots, serverSeq: 41, outageAlert: before, cancelledReads: f.state.cancelled };
}
test.skipIf(!output)('UISNAP2 slow refresh behind a confirmed save in S2W 390/1200 light/dark, shotIssues empty', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 'uisnap2-browser-'));
  const build = Bun.spawn([process.execPath, 'build', 'web/features/collab/shared/exec/fixture-harness.tsx',
    '--outdir', bundle, '--target', 'browser', '--tsconfig-override', 'web/tsconfig.json'], { cwd: process.env.UISNAP_SOURCE_ROOT ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const result = await build.exited;
  if (result !== 0) throw new Error(await new Response(build.stderr).text());
  mkdirSync(output!, { recursive: true });
  const f = syntheticServer(bundle), browser = await chromium.launch({ channel: 'chrome', headless: true });
  const shots = [];
  try {
    for (const width of [390, 1200]) for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      page.setDefaultTimeout(5000);
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      shots.push(await scenario(page, f, width, theme));
      expect(errors).toEqual([]); await page.close();
    }
    await Bun.write(resolve(output!, 'evidence-race.json'), JSON.stringify({ phase: before ? 'before' : 'after', shots }, null, 2));
  } finally { await browser.close(); f.server.stop(true); }
}, 120000);
