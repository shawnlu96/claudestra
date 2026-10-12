import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharedProductBoard } from '../web/features/collab/dag/shared-product-model';
import { fixtureDetail, fixtureList, fixtureNow } from '../web/features/collab/shared/shared-fixture';

interface ElementBox { width: number; height: number; top: number; bottom: number }
interface VisibleElement {
  getBoundingClientRect(): ElementBox;
  closest(selector: string): VisibleElement | null;
  querySelector(selector: string): VisibleElement | null;
  ownerDocument: { defaultView: { innerHeight: number } | null };
}
const ten = { ...fixtureList, features: Array.from({ length: 12 }, (_, i) => ({ ...fixtureDetail.feature,
  id: `feature-${i}`, title: `Team feature ${i + 1}`, projectId: 'project-a', updatedAt: Date.now(),
  counts: { total: 12, completed: i, blocked: i % 3, missing: i === 11 ? 1 : 0 },
  projection: { sourceInstanceId: 'home-a', sourceSeq: 1, observedAt: Date.now() - (i === 10 ? 11 * 60_000 : 0), receivedAt: Date.now() } })) };
test('shared DTO feeds PD2 without fabricating edges, ETA, or completion for stale/missing projections', () => {
  const stale = fixtureList.features[2]!;
  const board = sharedProductBoard({ ...fixtureList, features: [{ ...stale,
    projection: { ...stale.projection!, observedAt: fixtureNow - 11 * 60_000 } }] }, fixtureNow);
  expect(board.deps).toEqual([]);
  expect(board.features[0]).toMatchObject({ status: 'active', eta: null, counts: { completed: 0, active: 0 } });
  expect(sharedProductBoard(ten, fixtureNow).features).toHaveLength(12);
});
const shots = process.env.SHARED_LEDGER_SHOTS_DIR;
const globalCss = process.env.SHARED_LEDGER_GLOBAL_CSS;
test.skipIf(!shots)('real team entry opens PD2 board with twelve visible features and shared detail', async () => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const bundle = resolve(shots, 'bundle');
  const build = Bun.spawn(['/usr/bin/env', '-i', 'PATH=/opt/homebrew/bin:/usr/bin:/bin', process.execPath, '--no-env-file', 'build',
    'web/features/collab/dag/shared-preview.tsx', '--target', 'browser', '--outdir', bundle, '--tsconfig-override', 'web/tsconfig.json'],
  { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(build.stderr).text();
  if (await build.exited) throw new Error(stderr);
  const files = readdirSync(bundle);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/_global.css' && globalCss) return new Response(Bun.file(globalCss));
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'c5-machine', version: 'fixture' });
    if (path === '/api/v1/shared-ledger/context') return Response.json({ identities: [{ center: 'fixture', team: 'team-a', person: 'member', project: 'project-a' }] });
    if (path === '/api/v1/shared-ledger/features') return Response.json(ten);
    if (path.startsWith('/api/v1/shared-ledger/features/')) return Response.json({ ...fixtureDetail,
      feature: { ...ten.features[0], projectId: 'project-a' } });
    if (path.startsWith('/api/')) return new Response('Forbidden local owner capability', { status: 403 });
    if (path !== '/') return new Response(Bun.file(resolve(bundle, path.slice(1))));
    const styles = files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('');
    const globals = globalCss ? '<link rel="stylesheet" href="/_global.css">' : '';
    return new Response(`<html data-theme="light"><head>${globals}${styles}
      <style>body{margin:0;font-family:system-ui}button{cursor:pointer}</style></head><body><div id="root"></div>
      <script src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  const browser = await chromium.launch({ headless: true, channel: 'chrome', env: { PATH: '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
  try {
    for (const width of [390, 1400]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(server.url.toString());
      const entry = page.getByRole('button', { name: '团队 · 全部 feature', exact: true });
      await entry.waitFor(); expect(await entry.isVisible()).toBe(true);
      await page.screenshot({ path: resolve(shots, `entry-${width}.png`) });
      await entry.click();
      await page.getByRole('heading', { name: '全部 feature', exact: true }).waitFor();
      const back = page.getByRole('button', { name: '返回会话', exact: true });
      expect(await back.isVisible()).toBe(true);
      if (globalCss) {
        const bounds = await back.boundingBox();
        expect(bounds?.height).toBeGreaterThanOrEqual(40);
      }
      const cards = page.locator('button').filter({ hasText: /^Team feature \d/ });
      await cards.first().waitFor();
      expect(await cards.count()).toBe(12);
      for (let i = 0; i < 12; i++) { await cards.nth(i).scrollIntoViewIfNeeded(); expect(await cards.nth(i).isVisible()).toBe(true); }
      await cards.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(shots, `product-${width}.png`), fullPage: true });
      if (width === 1400) {
        const canvas = page.locator('[class*="canvas_"]').first();
        for (let i = 0; i < 12; i++) {
          const card = cards.nth(i);
          for (let retry = 0; retry < 5; retry++) {
            const bounds = await card.boundingBox(), area = await canvas.boundingBox();
            if (!bounds || !area) throw new Error('missing canvas/card bounds');
            const delta = area.y + 24 - bounds.y;
            if (bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height) break;
            await page.mouse.move(area.x + area.width - 100, area.y + area.height / 2);
            await page.mouse.down();
            await page.mouse.move(area.x + area.width - 100, area.y + area.height / 2 + delta, { steps: 8 });
            await page.mouse.up();
          }
          expect(await card.evaluate(el => {
            const node = el as unknown as VisibleElement;
            const region = node.closest('[class*="canvas_"]'), heading = node.querySelector('strong');
            if (!region || !heading) return false;
            const canvas = region.getBoundingClientRect(), card = node.getBoundingClientRect();
            const title = heading.getBoundingClientRect();
            return title.width > 0 && title.height >= 10 && card.top >= canvas.top - 1 && card.bottom <= canvas.bottom + 1;
          })).toBe(true);
          if ([0, 5, 11].includes(i)) await page.screenshot({ path: resolve(shots, `product-1400-part-${i}.png`) });
        }
        await page.getByRole('button', { name: '适配全部', exact: true }).click();
        await page.waitForTimeout(500);
      } else {
        for (let i = 0; i < 12; i++) {
          const title = cards.nth(i).locator('strong');
          await title.scrollIntoViewIfNeeded();
          expect(await title.evaluate(el => {
            const node = el as unknown as VisibleElement, r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= (node.ownerDocument.defaultView?.innerHeight ?? 0);
          })).toBe(true);
        }
      }
      await cards.first().click();
      await page.getByRole('heading', { name: 'Team feature 1', exact: true }).waitFor();
      const edit = page.getByRole('button', { name: '编辑规划', exact: true });
      await edit.scrollIntoViewIfNeeded(); expect(await edit.isVisible()).toBe(true);
      await page.screenshot({ path: resolve(shots, `detail-${width}.png`), fullPage: true });
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
}, 120000);
