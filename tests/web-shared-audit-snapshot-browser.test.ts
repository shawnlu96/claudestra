/** UISNAP1: S2W production TV1 harness, synthetic HTTP only. Set UISNAP_SHOTS_DIR to opt in. */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
import { shotIssues } from './helpers/ui-shot-checks';
const output = process.env.UISNAP_SHOTS_DIR;
const before = process.env.UISNAP_BEFORE === '1';
function syntheticServer(bundle: string) {
  const raw = generateTeamFixture({ features: 1, now: Date.now() });
  // Execution forms show their feature key; use the same readable synthetic key in both screenshot phases.
  const fixture: typeof raw = JSON.parse(JSON.stringify(raw).replaceAll(raw.details[0]!.feature.id, 'Synthetic feature'));
  const detail = fixture.details[0]!;
  const view = execFixtureView(detail.feature.id, detail.tasks[0]?.taskId);
  const state = { fail: true, reads: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path.includes('/shared-exec/features/')) {
      state.reads++;
      return state.fail ? Response.json({ error: 'synthetic outage' }, { status: 500 }) : Response.json(view);
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
async function capture(page: Page, name: string) {
  const issues = await shotIssues(page);
  await page.screenshot({ path: resolve(output!, name + '.png'), fullPage: true });
  expect(issues).toEqual([]);
  return { file: name + '.png', shotIssues: issues };
}
// UXHOME1：团队源下「团队」标签改名「规划与提案」；改前基线上仍叫「团队」，两种都认
async function scenario(page: Page, f: ReturnType<typeof syntheticServer>, width: number, theme: string) {
  f.state.fail = true;
  const start = f.state.reads;
  await page.goto(`${f.server.url}?mode=on&theme=${theme}`);
  await page.getByText(f.title, { exact: true }).first().waitFor();
  await page.getByRole(width < 700 ? 'button' : 'tab', { name: /^(规划与提案|团队)$/ }).first().click();
  await page.getByRole('status').filter({ hasText: '执行数据暂不可用' }).waitFor();
  const prefix = `${width}-${theme}`, shots = [await capture(page, `${prefix}-failed`)];
  expect(f.state.reads - start).toBe(1);
  const retry = page.getByRole('button', { name: '重试', exact: true });
  expect(await retry.count()).toBe(before ? 0 : 1);
  f.state.fail = false;
  if (before) {
    // Baseline has no retry; re-enter the same S2W fixture to capture the normal structural reference.
    await page.reload();
    await page.getByText(f.title, { exact: true }).first().waitFor();
    await page.getByRole(width < 700 ? 'button' : 'tab', { name: /^(规划与提案|团队)$/ }).first().click();
  } else await retry.click();
  await page.getByText('共享执行', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开卡', exact: true }).last().click();
  await page.getByRole('button', { name: '审批', exact: true }).last().click();
  await page.getByRole('button', { name: '批准', exact: true }).waitFor();
  shots.push(await capture(page, `${prefix}-recovered`));
  expect(f.state.reads - start).toBe(2);
  return shots;
}
test.skipIf(!output)('UISNAP1 first-read outage/retry in S2W 390/1200 light/dark, shotIssues empty', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 'uisnap-browser-'));
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
      shots.push(...await scenario(page, f, width, theme));
      expect(errors).toEqual([]); await page.close();
    }
    await Bun.write(resolve(output!, 'evidence.json'), JSON.stringify({ phase: before ? 'before' : 'after', shots }, null, 2));
  } finally { await browser.close(); f.server.stop(true); }
}, 120000);
