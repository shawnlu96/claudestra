/** Opt-in isolated fixture screenshots; no production config, credentials or bridge connections. */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const out = process.env.SHARED_LEDGER_SHOTS_DIR;
async function screenshot(page: Page, url: string, path: string) {
  await page.goto(url); await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path, fullPage: true });
}
test.skipIf(!out)('shared ledger: 390/1400 light/dark states and actual enabled/locked/conflict interactions', async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, 'fixture-bundle');
  const build = Bun.spawn([process.execPath, 'build', 'web/features/collab/shared/fixture-harness.tsx',
    '--target', 'browser', '--outdir', bundle, '--tsconfig-override', 'web/tsconfig.json'], { stdout: 'pipe', stderr: 'pipe' });
  const code = await build.exited, stderr = await new Response(build.stderr).text();
  if (code) throw new Error(stderr);
  const files = readdirSync(bundle);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname !== '/') return new Response(Bun.file(resolve(bundle, url.pathname.slice(1))));
    return new Response(`<html data-theme="${url.searchParams.get('theme') === 'light' ? 'light' : 'dark'}"><head>
      ${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
      <style>body{margin:0}button{font:inherit}#root{min-height:100vh}</style></head>
      <body><div id="root"></div><script src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`,
      { headers: { 'Content-Type': 'text/html' } });
  } });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [390, 1400]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      for (const view of ['list', 'detail', 'new', 'conflict']) {
        const url = `${server.url}?view=${view}&theme=${theme}`;
        await screenshot(page, `${url}&phase=before`, resolve(out, `before-${width}-${theme}-${view}.png`));
        await screenshot(page, url, resolve(out, `after-${width}-${theme}-${view}.png`));
        if (view === 'list') { expect(await page.getByText('过期', { exact: true }).count()).toBeGreaterThan(0); }
        if (view === 'detail') {
          await page.getByRole('button', { name: 'C4 团队总表与冲突草稿', exact: true }).click();
          for (const label of ['开卡', '绑卡', '阶段', '审批']) expect(await page.getByRole('button', { name: label, exact: true }).isDisabled()).toBe(true);
          await page.getByRole('button', { name: '编辑规划' }).click();
          expect(await page.getByRole('textbox', { name: '节点 1', exact: true }).isDisabled()).toBe(true);
          expect(await page.getByRole('textbox', { name: '节点 2', exact: true }).isEnabled()).toBe(true);
        }
        if (view === 'conflict') {
          expect(await page.getByRole('button', { name: '提交新版本' }).isDisabled()).toBe(true);
          await page.getByRole('button', { name: '重读后编辑' }).click();
          expect(await page.evaluate<number>(`Array.from(document.querySelectorAll('input')).filter(i => i.value === '我的草稿：团队总表与冲突恢复').length`)).toBe(1);
          await page.getByRole('button', { name: '提交新版本' }).click();
          await page.getByTestId('submitted').waitFor();
          await page.goto(url); await page.getByRole('button', { name: '放弃草稿' }).click();
          expect(await page.getByRole('heading', { name: '规划已被他人更新' }).count()).toBe(0);
        }
      }
      await page.goto(`${server.url}?view=live&theme=${theme}`);
      await page.getByRole('button', { name: /团队共享台账/ }).click();
      await page.getByRole('button', { name: '编辑规划' }).click();
      const title = page.locator('fieldset').nth(1).getByRole('textbox').nth(1);
      await title.fill('保留我的实际提交草稿');
      await page.getByRole('textbox', { name: '改图原因' }).fill('Test real 409 conflict flow');
      await page.getByRole('button', { name: '提交新版本' }).click();
      await page.getByRole('heading', { name: '规划已被他人更新' }).waitFor();
      expect(await title.inputValue()).toBe('保留我的实际提交草稿');
      await page.getByRole('button', { name: '重读后编辑' }).click();
      await page.getByRole('button', { name: '提交新版本' }).click();
      await page.getByRole('button', { name: '编辑规划' }).waitFor();
      expect(await page.getByRole('heading', { name: '规划已被他人更新' }).count()).toBe(0);
      expect(errors).toEqual([]); await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
}, 60000);
