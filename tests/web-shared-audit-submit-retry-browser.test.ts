/** Opt-in: RETRY_SHOTS_DIR=<outside repo> bun test tests/web-shared-audit-submit-retry-browser.test.ts.
 * RETRY_BASELINE=1 records the old behaviour on an unchanged baseline copy (copy this file in, run there).
 * Real fixture-harness/TeamSource/hook; only the loopback synthetic HTTP service is substituted, and the entry sets the language.
 * A: save → detail read 500 → 编辑规划 read 500 → 重试 (read ok). B: English UI, save → detail read 500. Plus a retry-in-flight shot.
 */
import { expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import type { Command } from '../web/lib/api/shared-ledger';
import { shotIssues, type ShotIssue } from './helpers/ui-shot-checks';
import { budgetedTest } from './browser-test-budget';

const out = process.env.RETRY_SHOTS_DIR, baseline = process.env.RETRY_BASELINE === '1';
const browsers = new Set<Browser>();
const browserTest = budgetedTest(() => [...browsers].flatMap(b => b.contexts()));

function serve(bundle: string) {
  const fx = generateTeamFixture();
  let detail = structuredClone(fx.details.at(-1)!), failDetail = false, seq = fx.list.serverSeq;
  let hold: Promise<void> | null = null, release = () => {};
  const commands: Command[] = [], calls: string[] = [];
  const files = readdirSync(bundle), json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/')) calls.push(`${req.method} ${path}`);
    if (path === '/__reset') {
      detail = structuredClone(fx.details.at(-1)!); failDetail = false; seq = fx.list.serverSeq; release(); hold = null;
      commands.length = calls.length = 0; return json({ ok: true });
    }
    if (path === '/__fail') { failDetail = true; return json({ ok: true }); }
    if (path === '/__recover') { failDetail = false; return json({ ok: true }); }
    if (path === '/__hold') { hold = new Promise(r => { release = r; }); return json({ ok: true }); }
    if (path === '/__release') { hold = null; release(); return json({ ok: true }); }
    if (path === '/app-config.json') return json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return json({ ...fx.list, serverSeq: seq, features: [detail.feature] });
    if (path === `/api/v1/shared-ledger/features/${detail.feature.id}`) {
      if (hold) await hold;
      return failDetail ? json({ error: 'synthetic detail failure' }, 500) : json(detail);
    }
    if (path === '/api/v1/shared-ledger/commands' && req.method === 'POST') {
      const c = await req.json() as Command; commands.push(c);
      if (c.type !== 'dag.rewrite') return json({ error: 'unexpected write' }, 400);
      seq++; detail = { ...detail, serverSeq: seq, feature: { ...detail.feature, rev: detail.feature.rev + 1, version: detail.feature.version + 1 },
        dag: { ...detail.dag, version: detail.dag.version + 1, nodes: c.nodes } };
      failDetail = true;
      return json({ schemaVersion: 1, requestId: c.requestId, commandDigest: 'synthetic', serverSeq: seq, committedAt: fx.now,
        result: { featureId: detail.feature.id, rev: detail.feature.rev, version: detail.feature.version } });
    }
    if (path.startsWith('/api/')) return json({ error: 'fixture route absent' }, 404);
    if (files.includes(path.slice(1))) return new Response(Bun.file(join(bundle, path.slice(1))));
    return new Response(`<!doctype html><html lang="zh" data-theme="${new URL(req.url).searchParams.get('theme') ?? 'light'}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/retry-entry.css">
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head><body><div id="root"></div>
      <script type="module" src="/retry-entry.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { server, fx, calls, commands };
}

async function capture(page: Page, name: string, issues: Record<string, ShotIssue[]>) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  issues[name] = await shotIssues(page);
  await page.screenshot({ path: resolve(out!, `${name}.png`) });
}

type Fixture = ReturnType<typeof serve>;
const L = {
  zh: { team: /^(规划与提案|团队)$/ as string | RegExp, edit: /^编辑规划 /, locked: '已绑卡，节点锁定', reason: '改图原因', submit: '提交新版本', saved: '已保存，详情刷新失败',
    readFailed: '读取失败，保留缓存与草稿', retry: '重试' },
  en: { team: /^(Plans & proposals|Team)$/ as string | RegExp, edit: /^Edit plan /, locked: 'Bound task; node locked', reason: 'Rewrite reason', submit: 'Submit new version',
    saved: 'Saved; detail refresh failed', readFailed: 'Read failed; cache and draft retained', retry: 'Retry' },
};

async function save(page: Page, f: Fixture, lang: 'zh' | 'en', width: number) {
  const t = L[lang], { fx, commands } = f;
  await page.getByText(fx.details.at(-1)!.feature.title, { exact: true }).first().waitFor();
  await (width < 700 ? page.getByRole('button', { name: t.team }).first()
    : page.getByRole('tab', { name: t.team }).or(page.getByRole('button', { name: t.team })).first()).click();
  await page.getByRole('button', { name: t.edit }).click();
  const free = page.locator('fieldset').filter({ hasNot: page.getByText(t.locked) }).first();
  await free.getByRole('textbox').nth(1).fill('写入成功后的新规划');
  await page.getByRole('textbox', { name: t.reason }).fill('UIWRITE2 synthetic read failure');
  await page.getByRole('button', { name: t.submit, exact: true }).click();
  await page.getByRole('alert').filter({ hasText: baseline && lang === 'en' ? L.zh.saved : t.saved }).waitFor();
  expect(commands).toHaveLength(1);
}

async function scenario(browser: Browser, f: Fixture, width: number, theme: 'light' | 'dark', op: 'A' | 'B', issues: Record<string, ShotIssue[]>) {
  const { server, fx, calls, commands } = f, url = String(server.url), lang = op === 'B' ? 'en' : 'zh', t = L[lang];
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, serviceWorkers: 'block' });
  const external: string[] = [], errors: string[] = [];
  await ctx.route('**/*', r => {
    if (new URL(r.request().url()).origin === new URL(url).origin) return r.continue();
    external.push(r.request().url()); return r.abort();
  });
  await ctx.routeWebSocket(() => true, ws => { external.push(ws.url()); ws.close(); });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  const tag = `${baseline ? 'before' : 'after'}-${op}-${width}-${theme}`;
  try {
    await page.request.get(`${url}__reset`);
    await page.goto(`${url}?side=team&project=${fx.project}&team=${fx.team}&theme=${theme}&lang=${lang}`);
    await save(page, f, lang, width);
    if (op === 'B') {
      const text = await page.getByRole('alert').first().textContent();
      if (!baseline) expect(text).not.toMatch(/[一-鿿]/);
      await capture(page, tag, issues);
    } else {
      if (!baseline) {
        // Retry in flight: the detail read is held, the button shows its disabled state.
        await page.request.get(`${url}__hold`);
        const retry = page.getByRole('alert').getByRole('button', { name: t.retry, exact: true });
        await retry.click();
        await expect(retry.isDisabled()).resolves.toBe(true);
        await capture(page, `after-inflight-${width}-${theme}`, issues);
        await page.request.get(`${url}__release`);
        await page.getByRole('alert').filter({ hasText: t.saved }).getByRole('button', { name: t.retry, exact: true }).waitFor();
        await expect(retry.isDisabled()).resolves.toBe(false);
      }
      await page.getByRole('button', { name: t.edit }).click();
      await page.getByRole('alert').filter({ hasText: t.readFailed }).waitFor();
      await page.request.get(`${url}__recover`);
      await page.getByRole('alert').getByRole('button', { name: t.retry, exact: true }).click();
      if (baseline) await page.getByRole('alert').waitFor({ state: 'hidden' });
      else await page.getByRole('button', { name: t.submit, exact: true }).waitFor();
      await page.waitForTimeout(200);
      expect(await page.getByRole('alert').filter({ hasText: '已保存' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: t.submit, exact: true }).count()).toBe(baseline ? 0 : 1);
      await capture(page, tag, issues);
    }
    expect(commands).toHaveLength(1);
    expect(external).toEqual([]); expect(errors).toEqual([]);
    await Bun.write(resolve(out!, `${tag}-requests.json`), JSON.stringify({ calls, commands, external, errors }, null, 2));
  } finally { await ctx.close(); }
}

(out ? browserTest : test.skip)('saved retry follows its error source and English notices: 390/1400 × light/dark', async () => {
  mkdirSync(out!, { recursive: true });
  const bundle = mkdtempSync(join(tmpdir(), 'retry-browser-')), issues: Record<string, ShotIssue[]> = {};
  let browser: Browser | undefined, fixture: Fixture | undefined;
  try {
    const src = mkdtempSync(join(tmpdir(), 'retry-entry-')), web = resolve('web');
    // The harness renders on import; setLang afterwards re-renders through useLang before any interaction.
    writeFileSync(join(src, 'retry-entry.tsx'), `import '${web}/features/collab/shared/fixture-harness.tsx';
import { setLang } from '${web}/lib/i18n.tsx';
setLang(new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh');\n`);
    const build = Bun.spawn([process.execPath, 'build', join(src, 'retry-entry.tsx'), '--target', 'browser',
      '--outdir', bundle, '--tsconfig-override', 'web/tsconfig.json'], { stdout: 'ignore', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    rmSync(src, { recursive: true, force: true }); if (code) throw new Error(stderr);
    fixture = serve(bundle); Bun.gc(true);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
    browsers.add(browser);
    for (const op of ['A', 'B'] as const) for (const width of [390, 1400]) for (const theme of ['light', 'dark'] as const) {
      await scenario(browser, fixture, width, theme, op, issues);
    }
    for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  } finally {
    await Bun.write(resolve(out!, 'shot-issues.json'), JSON.stringify(issues, null, 2));
    try { await browser?.close(); } finally {
      if (browser) browsers.delete(browser); fixture?.server.stop(true); rmSync(bundle, { recursive: true, force: true });
    }
  }
}, 180_000);
