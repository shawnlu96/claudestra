/**
 * PDFOCUS1 [验收线 3]：同份 projectMapBoard，浅色。1280：选中『团队项目』（改前同一处单击 = 进了子 DAG）、过滤『受阻 · 久未动』、
 * 关键路径 + 选中路径上的卡；390 手机没动作对照。改前没有过滤 / 关键路径，配对用改前的默认画面。
 * PROJECT_MAP_SHOTS_DIR 开启；PROJECT_MAP_BUNDLE 指向 origin/main 构建时截 before（见 tests/helpers/project-map-shots.ts）。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { resolve } from "node:path";
import { PROJECT_MAP_NOW, projectMapBoard } from "./helpers/project-map-fixture";
import { openProjectMap, projectMapShotsDir as out, shotPrefix, stopProjectMap } from "./helpers/project-map-shots";
import { shotIssues } from "./helpers/ui-shot-checks";

const before = shotPrefix === "before-";
const lit = (page: Page) => page.evaluate<string[]>(
  "[...document.querySelectorAll('[data-pd-card]:not([data-pd-dim])')].map(e => e.getAttribute('data-pd-card')).sort()");

/** 点卡头（中间是任务行，会点到任务） */
const HEAD = { position: { x: 60, y: 12 } };
const teamCard = (page: Page) => page.locator('[data-pd-card="f-team"] > button').first();

/** 拖画布：+48 让区边落在列缝（同 PDEDGEUI1）；选中前再往左拖，让右侧页不盖住团队项目和它的下游 */
async function drag(page: Page, dx: number) {
  await page.mouse.move(600, 200);
  await page.mouse.down();
  await page.mouse.move(600 + dx, 200, { steps: 6 });
  await page.mouse.up();
}
const nudge = (page: Page) => drag(page, 48);
const LEFT = -330;

test.skipIf(!out)("project-map focus: select / filter / critical path at 1280, unchanged phone, no external requests", async () => {
  if (!out) return;
  const dir = out;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const evidence: Record<string, unknown> = { baseline: process.env.PROJECT_MAP_BASE_SHA ?? null };
  try {
    for (const width of [1280, 390]) {
      const size = width === 1280 ? "1280x800" : "390x844";
      const { page, ctx, errors, external } = await openProjectMap(browser, { width, board: projectMapBoard(PROJECT_MAP_NOW) });
      await page.clock.setFixedTime(PROJECT_MAP_NOW);
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
        await page.screenshot({ path: resolve(dir, `${shotPrefix}${view}-${size}.png`) });
        evidence[`${view}-${size}`] = { shotIssues: issues };
        expect(issues).toEqual([]);
      };
      if (width === 390) await shot("default");
      else {
        await nudge(page);
        const reset = async () => { await page.reload(); await page.getByText("合并提速", { exact: true }).first().waitFor(); await nudge(page); };
        // 过滤 / 关键路径改前都没有：配对用改前的默认画面
        if (!before) {
          await page.locator('[data-pd-filter="blocked"]').click();
          expect(await lit(page)).toEqual(["f-agents", "f-dispatch", "f-sched"]);
        }
        await shot("filter-blocked");
        if (!before) {
          await page.locator('[data-pd-filter="all"]').click();
          await page.locator("[data-pd-cp-toggle]").click();
          await drag(page, LEFT);
          await teamCard(page).click(HEAD);
          await page.locator('[data-pd-side="f-team"] [data-pd-cp-chain]').waitFor();
          expect(await page.locator("[data-pd-cp]").allTextContents()).toEqual(["关键路径 · 约 33 小时", "关键路径 · 约 33 小时"]);
          expect(await lit(page)).toEqual(["f-private", "f-team"]);
        }
        await shot("cp-select");
        if (!before) { await page.keyboard.press("Escape"); await page.locator("[data-pd-cp-toggle]").click(); await reset(); }
        await drag(page, LEFT);
        // 同一处单击：改前进子 DAG，改后是选中 + 模块页
        await teamCard(page).click(HEAD);
        if (!before) {
          await page.locator('[data-pd-side="f-team"]').waitFor();
          expect(await lit(page)).toEqual(["f-private", "f-roster", "f-team"]);
        } else await page.getByRole("navigation").getByText("团队项目", { exact: true }).waitFor();
        await shot("select-team");
        if (!before) {
          await teamCard(page).dblclick(HEAD);
          await page.getByRole("navigation").getByText("团队项目", { exact: true }).waitFor();
          await page.getByRole("navigation").getByRole("button", { name: "产品 DAG" }).click();
          await page.locator('[data-pd-card="f-team"]').waitFor();
        }
      }
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      evidence[`requests-${size}`] = { errors, external };
      await ctx.close();
    }
  } finally {
    await Bun.write(resolve(dir, `${shotPrefix}focus-uiEvidence.json`), JSON.stringify(evidence, null, 2));
    await browser.close();
    await stopProjectMap();
  }
}, 180_000);
