/**
 * PDEDGEUI1 [验收线 2]：同份 projectMapBoard，浅色、桌面默认/锁页/任务页、手机对照。
 * PROJECT_MAP_SHOTS_DIR 开启；PROJECT_MAP_BUNDLE 指向 origin/main 构建时截 before。
 * 旧版点边没有页，保留点击后的原界面作配对，满足截图传输成对要求。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { resolve } from "node:path";
import { PROJECT_MAP_NOW, projectMapBoard } from "./helpers/project-map-fixture";
import { openProjectMap, projectMapShotsDir as out, shotPrefix, stopProjectMap } from "./helpers/project-map-shots";
import { shotIssues } from "./helpers/ui-shot-checks";

const before = shotPrefix === "before-";
const lock = "lock:f-team>f-private", task = "dep:f-private>f-team";

/** 逐个量世界坐标里的标签，不依赖文字检测器是否能识别被省略的文字。 */
async function labelOverlaps(page: Page) {
  return page.evaluate<string[]>(`(() => {
    const boxes = selector => [...document.querySelectorAll(selector)].map(e => ({ id: e.getAttribute('data-pd-label'), r: e.getBoundingClientRect() }))
      .filter(b => b.r.width > 0 && b.r.height > 0);
    const labels = boxes('[data-pd-label]'), cards = boxes('[data-pd-card],[data-pd-chip]');
    const hits = (a,b) => Math.min(a.right,b.right)-Math.max(a.left,b.left) > 0.5
      && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) > 0.5;
    return labels.flatMap((l,i) => [...cards, ...labels.slice(i+1)].filter(b => hits(l.r,b.r)).map(() => l.id));
  })()`);
}

async function openEdge(page: Page, id: string) {
  if (!before) {
    await page.locator(`[data-pd-label="${id}"]`).click();
    await page.locator(`[data-pd-side="${id}"]`).waitFor();
  } else {
    // 基线 SVG 没有命中路径：在同一条边的曲线中点做同一个点边动作。
    const p = await page.locator(`[data-pd-edge="${id}"]`).evaluate((el: unknown) => {
      const e = el as { getTotalLength(): number; getPointAtLength(n: number): { x: number; y: number };
        getScreenCTM(): { a: number; d: number; e: number; f: number } };
      const p = e.getPointAtLength(e.getTotalLength() / 2), m = e.getScreenCTM();
      return { x: m.a * p.x + m.e, y: m.d * p.y + m.f };
    });
    await page.mouse.click(p.x, p.y);
  }
}

test.skipIf(!out)("project-map edges: paired default/lock/task desktop shots, unchanged phone, no external requests or label overlaps", async () => {
  if (!out) return;
  const dir = out;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const evidence: Record<string, unknown> = { baseline: process.env.PROJECT_MAP_BASE_SHA ?? null };
  try {
    for (const width of [1280, 390]) {
      const size = width === 1280 ? "1280x800" : "390x844";
      const { page, ctx, errors, external } = await openProjectMap(browser, { width, board: projectMapBoard(PROJECT_MAP_NOW) });
      await page.clock.setFixedTime(PROJECT_MAP_NOW);
      // 底座概览默认是 10 月 2 日；地图证据用 10 月 14 日，必须让传入组件的 now 同步。
      await page.route("**/api/v1/ledger/*", async route => {
        const response = await route.fetch(), json = await response.json();
        await route.fulfill({ response, json: { ...json, now: PROJECT_MAP_NOW } });
      });
      if (width === 1280) {
        await page.getByRole("button", { name: "收起右栏" }).click();
        await page.getByRole("button", { name: "收起大纲" }).click();
      }
      await page.reload();
      await page.getByText("合并提速", { exact: true }).first().waitFor();
      await page.evaluate("document.fonts.ready");
      const shot = async (view: string) => {
        await page.waitForTimeout(350);
        const issues = await shotIssues(page);
        const overlap = await labelOverlaps(page);
        await page.screenshot({ path: resolve(dir, `${shotPrefix}${view}-${size}.png`) });
        evidence[`${view}-${size}`] = { shotIssues: issues, labelOverlaps: overlap };
        expect(issues).toEqual([]);
        expect(overlap).toEqual([]);
      };
      await shot("default");
      if (width === 1280) {
        // 侧页边界放在列缝里，避免截图检查把半遮住的卡标题算成和页内文字相交。
        await page.mouse.move(370, 200);
        await page.mouse.down();
        await page.mouse.move(418, 200, { steps: 6 });
        await page.mouse.up();
        await openEdge(page, lock);
        if (!before) expect(await page.locator("[data-pd-lock-evidence]").count()).toBe(6);
        await shot("lock");
        await page.keyboard.press("Escape");
        if (!before) expect(await page.locator("[data-pd-side]").count()).toBe(0);
        await openEdge(page, task);
        if (!before) expect(await page.locator("[data-pd-task-evidence]").count()).toBe(3);
        await shot("task");
      }
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      evidence[`requests-${size}`] = { errors, external };
      await ctx.close();
    }
  } finally {
    await Bun.write(resolve(dir, `${shotPrefix}edges-uiEvidence.json`), JSON.stringify(evidence, null, 2));
    await browser.close();
    await stopProjectMap();
  }
}, 180_000);
