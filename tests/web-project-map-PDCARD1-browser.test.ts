/** PDCARD1 [验收线 3]：同一份 projectMapBoard 的默认 / k=1.3 链 1 局部 / 手机对照。 */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { resolve } from 'node:path';
import { shotIssues } from './helpers/ui-shot-checks';
import { PROJECT_MAP_NOW as now, projectMapBoard } from './helpers/project-map-fixture';
import { openProjectMap, projectMapShotsDir as out, shotPrefix, stopProjectMap } from './helpers/project-map-shots';

const before = shotPrefix === 'before-';
const HINT = /"(还有 \d+ 件在右边 →|下面还有 \d+ 件 ↓|← 左边还有 \d+ 件|↑ 上面还有 \d+ 件)"/;

/** 截图夹具的固定相机：同一模块对齐到同一位置，缩放精确为规格要求的 1.3。 */
async function chainCamera(page: Page) {
  await page.evaluate(`(() => {
    const card = document.querySelector('[data-pd-card="f-private"]');
    const world = card.closest('[data-pd-mode]');
    const x = 35 - parseFloat(card.style.left) * 1.3, y = 65 - parseFloat(card.style.top) * 1.3;
    world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(1.3)';
  })()`);
}

/** 只查卡片文本真正可见的部分，省略号与视口裁剪不算溢出。 */
async function cardOverflow(page: Page) {
  return page.evaluate<string[]>(`(() => {
    const bad = [];
    for (const card of document.querySelectorAll('[data-pd-card]')) {
      const box = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('strong,[data-pd-task], [role=progressbar]')) {
        const r = el.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) bad.push(card.dataset.pdCard);
      }
    }
    return bad;
  })()`);
}

test.skipIf(!out)('project map card paired screenshots: desktop default, chain 1 at 1.3 and unchanged phone', async () => {
  if (!out) return;
  const dir = out;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const evidence: Record<string, unknown> = {};
  try {
    for (const width of [1280, 390]) {
      const size = width === 1280 ? '1280x800' : '390x844';
      const { page, ctx, external, errors } = await openProjectMap(browser, { width, board: projectMapBoard(now) });
      // 项目地图底座的总览时钟是另一份固定夹具；对齐响应 now，防止前沿时长被算成未来。
      await page.route('**/api/v1/ledger/*', async route => {
        const response = await route.fetch();
        const body = await response.json() as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, now } });
      });
      await page.clock.setFixedTime(now);
      if (width === 1280) await page.getByRole('button', { name: '收起右栏' }).click();
      await page.reload();
      await page.getByText('团队项目', { exact: true }).first().waitFor();
      const shot = async (view: string) => {
        await page.waitForTimeout(400);
        const raw = await shotIssues(page), overflow = await cardOverflow(page);
        // v4 的四边提示浮签属于视口组件；原始结果保留，沿用 PDLAYOUT1 的检查口径。
        const issues = raw.filter(i => !HINT.test(i.detail));
        await page.screenshot({ path: resolve(dir, `${shotPrefix}${view}-${size}.png`) });
        evidence[`${view}-${size}`] = { issues, raw, cardOverflow: overflow };
        if (!before) { expect(issues).toEqual([]); expect(overflow).toEqual([]); }
      };
      await shot('default');
      if (width === 1280) {
        await chainCamera(page);
        await shot('chain1');
        if (!before) {
          expect(await page.locator('[data-pd-card=f-team] button[data-pd-task]').count()).toBe(3);
          expect(await page.locator('[data-pd-task=tp-7]').innerText()).toContain('第 2 轮');
          expect(await page.locator('[data-pd-task=tp-5]').innerText()).toContain('2 小时');
          expect(await page.locator('[data-pd-card=f-sched]').innerText()).toContain('4 天没动');
        }
      }
      expect(errors).toEqual([]); expect(external).toEqual([]);
      evidence[`requests-${size}`] = { errors, external };
      await ctx.close();
    }
  } finally {
    await Bun.write(resolve(dir, `${shotPrefix}uiEvidence.json`), JSON.stringify(evidence, null, 2));
    await browser.close(); await stopProjectMap();
  }
}, 180_000);
