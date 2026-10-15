/** [验收线 2] [验收线 3] 本地合成页面；PDVIEW1_SHOTS_DIR 开启测试和截图，PROJECT_MAP_BUNDLE 提供 origin/main 构建。 */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { shotIssues } from './helpers/ui-shot-checks';
import { projectMapBoard, PROJECT_MAP_NOW } from './helpers/project-map-fixture';
import { openProjectMap, stopProjectMap } from './helpers/project-map-shots';
import { enlargedProjectMap } from './web-project-map-zoom-fixture.test';

const out = process.env.PDVIEW1_SHOTS_DIR;
const before = !!process.env.PROJECT_MAP_BUNDLE;
const phase = before ? 'before' : 'after';
const world = '[data-pd-mode]';
const scale = (page: Page) => page.evaluate<number>("new DOMMatrix(getComputedStyle(document.querySelector('[data-pd-mode]')).transform).a");
const evidence: Record<string, unknown> = {};
async function shot(page: Page, state: string, size: string) {
  await page.waitForTimeout(850);
  const issues = await shotIssues(page);
  evidence[`${state}-${size}`] = issues;
  await page.screenshot({ path: resolve(out!, `${phase}-${state}-${size}.png`) });
  if (!before) expect(issues).toEqual([]);
}
async function readyDesktop(page: Page) {
  await page.getByRole('button', { name: '收起右栏' }).click();
  await page.getByRole('button', { name: '收起大纲' }).click();
  await page.reload();
  await page.locator(world).waitFor({ state: 'attached' });
  await page.locator('[data-pd-title]').first().waitFor();
}
async function checkFar(page: Page) {
  expect(await page.locator(world).getAttribute('data-zoom')).toBe('far');
  expect(await scale(page)).toBeGreaterThanOrEqual(0.45);
  const details = page.locator('[data-pd-detail]');
  expect(await details.count()).toBeGreaterThan(0);
  for (const el of await details.all()) expect(await el.isVisible()).toBe(false);
  expect(await page.locator('[data-pd-title]').first().isVisible()).toBe(true);
  const title = await page.evaluate<{ px: number; lines: number }>(`(() => {
    const el = document.querySelector('[data-pd-title]');
    const s = getComputedStyle(el), k = new DOMMatrix(getComputedStyle(el.closest('[data-pd-mode]')).transform).a;
    return { px: parseFloat(s.fontSize) * k, lines: parseInt(s.webkitLineClamp) }; })()`);
  expect(title.px).toBeCloseTo(13, 1);
  expect(title.lines).toBe(2);
  for (const el of await page.locator('[data-pd-label]').all()) expect(await el.isVisible()).toBe(false);
  const longTitleBar = await page.evaluate<number>(`(() => {
    const card = document.querySelector('[data-pd-card]'), title = card.querySelector('[data-pd-title]'), original = title.textContent;
    title.textContent = '缩小后较长的项目标题仍然最多显示两行';
    const h = card.querySelector('[role=progressbar]').getBoundingClientRect().height;
    title.textContent = original;
    return h; })()`);
  expect(longTitleBar).toBeGreaterThan(0);

}
async function checkNearAndMode(page: Page) {
  const canvas = page.locator(world).locator('..');
  await canvas.hover({ position: { x: 100, y: 100 } });
  for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(250);
  expect(await scale(page)).toBeGreaterThanOrEqual(1);
  for (const el of await page.locator('[data-pd-detail], [data-pd-label]').all()) expect(await el.isVisible()).toBe(true);
  await page.getByRole('radio', { name: '按板块' }).click();
  await page.locator('[data-pd-mode="lane"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  const lane = await scale(page);
  expect(lane).toBeGreaterThanOrEqual(0.45);
  expect(lane).toBeLessThan(1);
  await page.getByRole('radio', { name: '按依赖' }).click();
  await page.locator('[data-pd-mode="dep"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  expect(await scale(page)).toBeGreaterThanOrEqual(0.7);
  await canvas.hover({ position: { x: 100, y: 100 } });
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, 100);
  await page.waitForTimeout(200);
  expect(await scale(page)).toBe(0.45);
}

async function standard(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const size = width === 390 ? '390x844' : '1280x800';
  const { page, ctx, external, errors } = await openProjectMap(browser, { width, board: projectMapBoard(PROJECT_MAP_NOW) });
  await page.clock.setFixedTime(PROJECT_MAP_NOW);
  if (width === 1280) await readyDesktop(page);
  await shot(page, 'open', size);
  if (width === 1280) {
    if (!before) {
      expect(await scale(page)).toBeGreaterThanOrEqual(0.7);
      expect(await page.getByRole('button', { name: /^还有 \d+ 个独立推进 →$/ }).count()).toBe(1);
    }
    await page.getByRole('button', { name: '适配全部' }).click();
    await shot(page, 'fit', size);
    if (before) expect(await scale(page)).toBe(0.96);
    else { await checkFar(page); await checkNearAndMode(page); }
    // 旧 bridge 没有子 DAG / 产品板时显示现成因果线，直接在相同合成总览上核对。
    await page.route('**/api/v1/ledger/*/product', route => route.fulfill({ status: 404, json: {} }));
    await page.route('**/api/v1/ledger/*/dag', route => route.fulfill({ status: 404, json: {} }));
    await page.reload();
    await page.getByRole('button', { name: '适配全部' }).waitFor();
    await shot(page, 'causal', size);
  } else expect(await page.locator(world).count()).toBe(0);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  evidence[`network-${size}`] = { external, errors };
  await ctx.close();
}

async function enlarged(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const { page, ctx, external, errors } = await openProjectMap(browser, { width: 1280, board: enlargedProjectMap() });
  await page.clock.setFixedTime(PROJECT_MAP_NOW);
  await readyDesktop(page);
  if (before) {
    await page.getByRole('button', { name: '适配全部' }).click();
    await shot(page, 'fit-large', '1280x800');
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
    return;
  }
  const hint = page.getByRole('button', { name: /^还有 \d+ 个独立推进 →$/ });
  const previous = await hint.textContent();
  await hint.click();
  await page.waitForTimeout(300);
  const remaining = await hint.count() ? await hint.textContent() : null;
  expect(remaining).not.toBe(previous);
  await page.getByRole('button', { name: '适配全部' }).click();
  expect(await page.getByRole('button', { name: '适配全部' }).getAttribute('class')).toContain('bump');
  await shot(page, 'fit-large', '1280x800');
  await checkFar(page);
  expect(await scale(page)).toBe(0.45);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  evidence['network-large'] = { external, errors };
  await ctx.close();
}

test.skipIf(!out)('PDVIEW1 product zoom, default viewport regression and paired screenshots', async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    await standard(browser, 1280);
    await standard(browser, 390);
    await enlarged(browser);
  } finally {
    await Bun.write(resolve(out, `${phase}-uiEvidence.json`), JSON.stringify(evidence, null, 2));
    await browser.close();
    await stopProjectMap();
  }
}, 180_000);
