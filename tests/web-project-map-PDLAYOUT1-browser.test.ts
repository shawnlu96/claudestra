/**
 * PDLAYOUT1 [验收线 4]：项目地图的前后截图（opt-in：PROJECT_MAP_SHOTS_DIR；改前构建由 PROJECT_MAP_BUNDLE 传入，见 tests/helpers/project-map-shots.ts）。
 * 同一份 projectMapBoard，1280×800 与 390×844、浅色：默认（按依赖）、按板块（只有改后）、已收尾 + 已暂停都展开（改前是「N 已完成」展开）。
 * 每张图 shotIssues 为空、非回环请求为 0；证据写进 <dir>/<前缀>uiEvidence.json。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { resolve } from "node:path";
import { shotIssues } from "./helpers/ui-shot-checks";
import { PROJECT_MAP_NOW, projectMapBoard } from "./helpers/project-map-fixture";
import { openProjectMap, projectMapShotsDir as out, shotPrefix, stopProjectMap } from "./helpers/project-map-shots";

const before = shotPrefix === "before-";
const HINT = /"(还有 \d+ 件在右边 →|下面还有 \d+ 件 ↓|← 左边还有 \d+ 件|↑ 上面还有 \d+ 件)"/;
/** 最后一个已收尾小标签进了视口 */
const lastChipInView = (page: Page) => page.evaluate<boolean>(`(() => {
  const r = [...document.querySelectorAll("[data-pd-chip^='done:']")].at(-1).getBoundingClientRect();
  return r.bottom <= innerHeight - 40; })()`);

test.skipIf(!out)("project map before/after: default, by area, wrapped-up + paused open; phone unchanged", async () => {
  if (!out) return;
  const dir = out;
  const board = projectMapBoard(PROJECT_MAP_NOW);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const evidence: Record<string, unknown> = {};
  try {
    for (const width of [1280, 390]) {
      const size = width === 390 ? "390x844" : "1280x800";
      const { page, ctx, external, errors } = await openProjectMap(browser, { width, board });
      await page.clock.setFixedTime(PROJECT_MAP_NOW);
      const shot = async (state: string) => {
        await page.waitForTimeout(300);
        const raw = await shotIssues(page);
        await page.screenshot({ path: resolve(dir, `${shotPrefix}${state}-${size}.png`) });
        // 视口「还有 N 件」浮签（v4 viewport-tools，缩放下限归 PDVIEW1）压在卡上不算本卡的排版问题；原始结果照记
        const issues = raw.filter((i) => !HINT.test(i.detail));
        evidence[`${state}-${size}`] = { issues, raw };
        if (!before) expect(issues).toEqual([]); // 改前照实记账，只当对照
      };
      if (width === 1280) {
        // 改前改后同一步：收起右栏，把宽度留给项目地图；视口打开时的摆放跟着重量过的尺寸走，所以收起后重载一次
        await page.getByRole("button", { name: "收起右栏" }).click();
        await page.reload();
        await page.getByText("合并提速", { exact: true }).first().waitFor();
        if (!before) await page.getByRole("radio", { name: "按依赖" }).waitFor();
      }
      await shot("default");
      if (width === 1280 && !before) {
        await page.getByRole("radio", { name: "按板块" }).click();
        await page.locator("[data-pd-lane-head]").nth(6).waitFor();
        expect(await page.locator("[data-pd-lane-head]").count()).toBe(7);
        await shot("lanes");
        await page.getByRole("radio", { name: "按依赖" }).click();
      }
      if (width === 1280) {
        if (before) await page.getByRole("button", { name: /^\d+ 已完成$/ }).click();
        else {
          await page.getByRole("button", { name: "已收尾 8" }).click();
          await page.getByRole("button", { name: "已暂停 2" }).click();
          expect(await page.locator("[data-pd-chip^='done:']").count()).toBe(8);
          expect(await page.locator("[data-pd-chip^='paused:']").count()).toBe(2);
          // 小标签在画布最底部：用「下面还有 N 件」平移过去
          for (let i = 0; i < 4 && !(await lastChipInView(page)); i++) {
            const down = page.getByRole("button", { name: /^下面还有 \d+ 件/ });
            if (!(await down.count())) break;
            await down.click();
            await page.waitForTimeout(350);
          }
        }
        await shot("shelves");
      }
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      evidence[`requests-${size}`] = { errors, external };
      await ctx.close();
    }
  } finally {
    await Bun.write(resolve(out, `${shotPrefix}uiEvidence.json`), JSON.stringify(evidence, null, 2));
    await browser.close();
    await stopProjectMap();
  }
}, 180_000);
