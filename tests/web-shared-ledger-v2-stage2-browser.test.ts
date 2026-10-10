/** Opt-in synthetic full TV1 screenshots; baseline and new panel use the same CollabView and CSS tokens. */
import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
const out = process.env.S2W_SHOTS_DIR;
test.skipIf(!out)('stage2 full TV1 desktop/mobile light/dark screenshots and non-execution DOM parity', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 's2w-bundle-'));
  const build = Bun.spawn([process.execPath, 'build', 'web/features/collab/shared/exec/fixture-harness.tsx', '--target', 'browser',
    '--outdir', bundle, '--tsconfig-override', 'web/tsconfig.json'], { stdout: 'pipe', stderr: 'pipe' });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  mkdirSync(out!, { recursive: true });
  const fx = generateTeamFixture({ features: 1, now: Date.now() });
  const f = fx.details[0]!, taskId = f.tasks[0]?.taskId ?? 'task';
  const view = execFixtureView(f.feature.id, taskId);
  let posts = 0, snapshotReads = 0, authorityMode = 'execution';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/__planning') { authorityMode = 'planning'; return Response.json({ ok: true }); }
    if (path === '/__execution') { authorityMode = 'execution'; return Response.json({ ok: true }); }
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return Response.json({ ...fx.list,
      features: fx.list.features.map(feature => ({ ...feature, authorityMode })) });
    if (path.startsWith('/api/v1/shared-ledger/features/')) return Response.json({ ...f, feature: { ...f.feature, authorityMode } });
    if (path === '/api/v1/shared-projects/snapshot') return Response.json({ v: 1,
      identity: { subject: 'owner:self', kind: 'person', centerId: 'center', teamId: 'team-a', personId: 'person-a', instanceId: 'local' },
      teamRole: { available: true, value: 'owner' }, capabilities: { invite: { available: true }, leave: { available: true } }, peers: [],
      localProjects: [{ id: 'fixture-local', name: 'Synthetic project', dirs: [], personal: false, eligible: false }],
      projects: [{ centerId: 'center', teamId: 'team-a', projectId: 'claude-orchestrator', name: 'Synthetic project', rev: 1,
        status: 'active', projectRole: { available: true, value: 'owner' }, localProjectIds: ['fixture-local'] }] });
    if (path === '/api/v1/shared-feature-proposals') return Response.json({ ok: true, operations: [] });
    if (path.startsWith('/api/v1/shared-feature-proposals/projects/')) return Response.json({ ok: true, proposals: [{
      proposalId: 'proposal-n7w', proposalRev: 2, proposalDigest: 'sha256:n7w', state: 'pending_approval', drift: false,
      title: '网页提案表单与审批卡', description: 'N7W 合成审批卡，用作同屏视觉基准', version: null, expiresAt: view.pendingAsks[0]!.expiresAt,
      proposer: { type: 'person', code: 'self' }, nodes: [{ key: 'N1', oneLine: '复用现有协作组件', deps: [], fileGlobs: ['web/**'], estimate: '2h' }],
    }] });
    if (path.startsWith('/api/v1/shared-exec/features/')) { snapshotReads++; return Response.json(view); }
    if (path.startsWith('/api/v1/shared-exec/asks/')) return Response.json(view.pendingAsks[0]);
    if (path === '/api/v1/shared-exec/commands') { posts++; return Response.json({ status: 'unknown' }); }
    if (path.startsWith('/api/')) return Response.json({ error: 'outside synthetic fixture' }, { status: 404 });
    if (path !== '/') return ['/fixture-harness.js', '/fixture-harness.css'].includes(path)
      ? new Response(Bun.file(join(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="${new URL(req.url).searchParams.get('theme') ?? 'light'}"><head><link rel="stylesheet" href="/fixture-harness.css">
      <style>html,body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}h2,h5{margin:0}*{box-sizing:border-box}</style></head>
      <body><div id="root"></div><script type="module" src="/fixture-harness.js"></script></body></html>`,
      { headers: { 'Content-Type': 'text/html' } });
  } });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [1200, 390]) for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      page.setDefaultTimeout(5000);
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.request.get(`${server.url}__execution`);
      const dom: string[] = [];
      for (const mode of ['absent', 'off', 'on']) {
        await page.goto(`${server.url}?mode=${mode}&theme=${theme}`);
        await page.getByText(f.feature.title, { exact: true }).first().waitFor().catch(async error => {
          console.error('S2W page errors', errors, await page.locator('body').innerText()); throw error;
        });
        // The team tab and its execution panel are production TV1 rendering, including the narrow sheet.
        const team = page.getByRole(width < 700 ? 'button' : 'tab', { name: '团队', exact: true }).first();
        await team.click();
        if (mode !== 'on') {
          await page.waitForTimeout(150);
          dom.push(await page.locator('body').innerHTML());
          expect(await page.getByRole('region', { name: '共享执行' }).count()).toBe(0);
        } else {
          await page.getByText('共享执行', { exact: true }).waitFor();
          await page.getByRole('button', { name: '开卡', exact: true }).last().click();
          await page.getByRole('button', { name: '审批', exact: true }).last().click();
          await page.getByRole('button', { name: '批准', exact: true }).waitFor();
          expect(await page.getByRole('button', { name: '批准', exact: true }).isEnabled()).toBe(true);
          const buttonStyle = await page.getByRole('button', { name: '批准', exact: true }).evaluate('el => { const s = getComputedStyle(el); return [s.height, s.fontSize]; }');
          const baselineStyle = await page.getByRole('button', { name: '新建 feature', exact: true }).evaluate('el => { const s = getComputedStyle(el); return [s.height, s.fontSize]; }');
          expect(JSON.stringify(buttonStyle)).toBe(JSON.stringify(baselineStyle));
          expect(Boolean(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'))).toBe(true);
        }
        await page.screenshot({ path: resolve(out!, `${width}-${theme}-${mode}.png`), fullPage: true });
        if (mode === 'on') {
          await page.getByRole('button', { name: '批准', exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(out!, `${width}-${theme}-on-signature.png`), fullPage: true });
        }
      }
      // Scripts differ only in the URL; normalize dynamic clock strings via DOM text/structure checks in the DOM suite.
      expect(dom[0]!.replace(/mode=absent/g, 'mode=off')).toBe(dom[1]);
      await page.request.get(`${server.url}__planning`);
      const before = snapshotReads, planning: string[] = [];
      for (const mode of ['absent', 'on']) {
        await page.goto(`${server.url}?mode=${mode}&theme=${theme}`);
        await page.getByText(f.feature.title, { exact: true }).first().waitFor();
        await page.getByRole(width < 700 ? 'button' : 'tab', { name: '团队', exact: true }).first().click();
        await page.waitForTimeout(150);
        planning.push(await page.locator('body').innerHTML());
        await page.screenshot({ path: resolve(out!, `${width}-${theme}-planning-${mode}.png`), fullPage: true });
      }
      expect(planning[0]).toBe(planning[1]); expect(snapshotReads).toBe(before);
      expect(errors).toEqual([]); await page.close();
    }
    expect(posts).toBe(0);
    await Bun.write(resolve(out!, 'evidence.json'), JSON.stringify({ widths: [1200, 390], themes: ['light', 'dark'], posts,
      baseline: 'Same production TV1 CollabView, port absent/off; DOM equality checked',
      css: 'Existing local CollabView tokens and X10/X11 modules; no new CSS' }, null, 2));
  } finally { await browser.close(); server.stop(true); }
}, 120000);
