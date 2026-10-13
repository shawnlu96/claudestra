/** Opt-in: AUDIT_SUBMIT_SHOTS_DIR=<outside repo> bun test tests/web-shared-audit-submit-browser.test.ts.
 * AUDIT_SUBMIT_BASELINE=1 records the old failure on the unchanged baseline before applying the fix.
 * Real fixture-harness/TeamSource/hook; only the loopback synthetic HTTP service is substituted.
 */
import { expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import type { Command } from '../web/lib/api/shared-ledger';
import { shotIssues, type ShotIssue } from './helpers/ui-shot-checks';
import { budgetedTest } from './browser-test-budget';

const out = process.env.AUDIT_SUBMIT_SHOTS_DIR, baseline = process.env.AUDIT_SUBMIT_BASELINE === '1';
const browsers = new Set<Browser>();
const browserTest = budgetedTest(() => [...browsers].flatMap(b => b.contexts()));

function serve(bundle: string) {
  const fx = generateTeamFixture();
  let detail = structuredClone(fx.details.at(-1)!), committed = false, failDetail = false, seq = fx.list.serverSeq;
  const commands: Command[] = [], calls: string[] = [];
  const files = readdirSync(bundle), json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/')) calls.push(`${req.method} ${path}`);
    if (path === '/__reset') {
      detail = structuredClone(fx.details.at(-1)!); committed = failDetail = false; seq = fx.list.serverSeq;
      commands.length = calls.length = 0; return json({ ok: true });
    }
    if (path === '/__recover') { failDetail = false; return json({ ok: true }); }
    if (path === '/app-config.json') return json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return json({ ...fx.list, serverSeq: seq, features: [detail.feature] });
    if (path === `/api/v1/shared-ledger/features/${detail.feature.id}`) {
      return failDetail ? json({ error: 'synthetic detail failure' }, 500) : json(detail);
    }
    if (path === '/api/v1/shared-ledger/commands' && req.method === 'POST') {
      const c = await req.json() as Command; commands.push(c);
      if (c.type !== 'dag.rewrite') return json({ error: 'unexpected write' }, 400);
      seq++; detail = { ...detail, serverSeq: seq, feature: { ...detail.feature, rev: detail.feature.rev + 1, version: detail.feature.version + 1 },
        dag: { ...detail.dag, version: detail.dag.version + 1, nodes: c.nodes } };
      committed = failDetail = true;
      return json({ schemaVersion: 1, requestId: c.requestId, commandDigest: 'synthetic', serverSeq: seq, committedAt: fx.now,
        result: { featureId: detail.feature.id, rev: detail.feature.rev, version: detail.feature.version } });
    }
    if (path.startsWith('/api/')) return json({ error: 'fixture route absent' }, 404);
    if (files.includes(path.slice(1))) return new Response(Bun.file(join(bundle, path.slice(1))));
    return new Response(`<!doctype html><html lang="zh" data-theme="${new URL(req.url).searchParams.get('theme') ?? 'light'}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/fixture-harness.css">
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head><body><div id="root"></div>
      <script type="module" src="/fixture-harness.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { server, fx, calls, commands, committed: () => committed };
}

async function capture(page: Page, name: string, issues: Record<string, ShotIssue[]>) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  issues[name] = await shotIssues(page);
  await page.screenshot({ path: resolve(out!, `${name}.png`) });
}

async function scenario(browser: Browser, fixture: ReturnType<typeof serve>, width: number, theme: 'light' | 'dark', issues: Record<string, ShotIssue[]>) {
  const { server, fx, calls, commands } = fixture, url = String(server.url);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, serviceWorkers: 'block' });
  const external: string[] = [], errors: string[] = [];
  await ctx.route('**/*', r => {
    if (new URL(r.request().url()).origin === new URL(url).origin) return r.continue();
    external.push(r.request().url()); return r.abort();
  });
  await ctx.routeWebSocket(() => true, ws => { external.push(ws.url()); ws.close(); });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  try {
    await page.request.get(`${url}__reset`);
    await page.goto(`${url}?side=team&project=${fx.project}&team=${fx.team}&theme=${theme}`);
    await page.getByText(fx.details.at(-1)!.feature.title, { exact: true }).first().waitFor();
    await (width < 700 ? page.getByRole('button', { name: '团队', exact: true }).first()
      : page.getByRole('tab', { name: '团队', exact: true }).or(page.getByRole('button', { name: '团队', exact: true })).first()).click();
    await page.getByRole('button', { name: /^编辑规划 / }).click();
    const free = page.locator('fieldset').filter({ hasNot: page.getByText('已绑卡，节点锁定') }).first();
    await free.getByRole('textbox').nth(1).fill('写入成功后的新规划');
    await page.getByRole('textbox', { name: '改图原因' }).fill('UIWRITE1 synthetic read failure');
    await page.getByRole('button', { name: '提交新版本', exact: true }).click();
    const message = baseline ? '提交失败，草稿已保留' : '已保存，详情刷新失败';
    await page.getByRole('alert').filter({ hasText: message }).waitFor();
    expect(fixture.committed()).toBe(true); expect(commands).toHaveLength(1);
    expect(await page.getByRole('button', { name: '提交新版本', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: '查询回执', exact: true }).count()).toBe(baseline ? 1 : 0);
    const name = `${baseline ? 'before' : 'after'}-${width}-${theme}`;
    await capture(page, name, issues);
    if (!baseline) {
      const detailReads = calls.filter(c => c.includes('/features/')).length;
      await page.request.get(`${url}__recover`);
      await page.getByRole('alert').filter({ hasText: message }).getByRole('button', { name: '重试', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: message }).waitFor({ state: 'hidden' });
      expect(calls.filter(c => c.includes('/features/')).length).toBeGreaterThan(detailReads);
      expect(commands).toHaveLength(1);
      expect(await page.getByRole('button', { name: '查询回执', exact: true }).count()).toBe(0);
      await capture(page, `recovered-${width}-${theme}`, issues);
    }
    expect(external).toEqual([]); expect(errors).toEqual([]);
    await Bun.write(resolve(out!, `${name}-requests.json`), JSON.stringify({ calls, commands, external, errors }, null, 2));
  } finally { await ctx.close(); }
}

(out ? browserTest : test.skip)('confirmed planning write and read-only retry: 390/1400 × light/dark', async () => {
  mkdirSync(out!, { recursive: true });
  const bundle = mkdtempSync(join(tmpdir(), 'audit-submit-browser-')), issues: Record<string, ShotIssue[]> = {};
  let browser: Browser | undefined, fixture: ReturnType<typeof serve> | undefined;
  try {
    const build = Bun.spawn([process.execPath, 'build', 'web/features/collab/shared/fixture-harness.tsx', '--target', 'browser',
      '--outdir', bundle, '--tsconfig-override', 'web/tsconfig.json'], { stdout: 'ignore', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]); if (code) throw new Error(stderr);
    fixture = serve(bundle); Bun.gc(true);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
    browsers.add(browser);
    for (const width of [390, 1400]) for (const theme of ['light', 'dark'] as const) await scenario(browser, fixture, width, theme, issues);
    for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  } finally {
    await Bun.write(resolve(out!, 'shot-issues.json'), JSON.stringify(issues, null, 2));
    try { await browser?.close(); } finally {
      if (browser) browsers.delete(browser); fixture?.server.stop(true); rmSync(bundle, { recursive: true, force: true });
    }
  }
}, 120_000);
