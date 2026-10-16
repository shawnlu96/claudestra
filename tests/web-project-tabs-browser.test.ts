/**
 * PROJTABS1 前后截图（opt-in，截图不进 git）：
 *   PROJTABS_SHOTS_DIR=<目录> [PROJTABS_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-project-tabs-browser.test.ts
 * 入口与数据见 tests/helpers/project-tabs-shots.ts（改前改后同一个入口、同一份数据），时刻钉在 2026-10-14 12:00 Asia/Shanghai，浅色，
 * 真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0；每张图跑 shotIssues。
 * 1280：冷开 / 项目地图 / 选中模块的模块进度 / 团队 / 点开任务（改前右栏详情，改后右侧抽屉）；390：冷开 / 模块进度 / 团队
 * （390 改前冷开就是产品 DAG 列表，项目地图那张和它重复，不另拍）。另拍无看板项目的「项目地图」（改后）核对退回因果线，不进正规清单。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { MAP, PLAIN, PT_NOW, ptRoute } from "./helpers/project-tabs-shots";
import { bundleProjectTabs } from "./helpers/project-tabs-shots";
import { serveToday, tailwindCss } from "./helpers/today-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.PROJTABS_SHOTS_DIR, baseRepo = process.env.PROJTABS_BASE_REPO;
const FP = "local";
type View = "cold" | "map" | "module" | "team" | "task" | "map-plain";

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(500); // 抽屉滑入 / 下划线平移（≤ .22s）走完
}

/** 产品看板上的模块卡（桌面画布 / 手机列表都是 button > strong 标题） */
const moduleCard = (page: Page, title: string) => page.locator(`button:has(strong:text-is("${title}"))`).first();

/** 改后：四个标签 */
async function after(page: Page, view: View, narrow: boolean) {
  const tab = (name: string) => page.locator(`[role=tab][data-project-tab]`, { hasText: name }).first();
  if (view === "map" || view === "map-plain") await tab("项目地图").click();
  if (view === "module") {
    await tab("项目地图").click();
    await moduleCard(page, "导出").click();
    await page.locator("[data-project-pane=module] nav").waitFor();
  }
  if (view === "team") {
    await tab("团队").click();
    await page.locator("[data-project-pane=team]").waitFor();
  }
  if (view === "task") {
    await page.evaluate(`window.__nav.task("P2")`);
    await page.locator("[data-task-drawer] [data-team-fact], [data-task-drawer] h5").first().waitFor();
  }
  if (view === "map") await page.locator("[data-project-pane=map]").waitFor();
}

/** 改前：同一展示状态在 main 上的对应页面（产品 DAG / 子 DAG / 团队标签或手机团队整屏 / 右栏详情） */
async function before(page: Page, view: View, narrow: boolean) {
  if (view === "map") await page.locator("[role=tab]", { hasText: "产品 DAG" }).first().click();
  if (view === "module") {
    await moduleCard(page, "导出").click();
    await page.locator(`nav[aria-label="返回产品 DAG"]`).waitFor(); // 进了子 DAG 的面包屑（手机分段名不变）
  }
  if (view === "team") {
    if (narrow) await page.locator("button", { hasText: /^团队$/ }).first().click();
    else await page.locator("[role=tab]", { hasText: /^团队$/ }).first().click();
  }
  if (view === "task") await page.evaluate(`window.__nav.task("P2")`);
  await page.waitForTimeout(300);
}

test.skipIf(!out)("PROJTABS1：项目页四标签与右侧抽屉，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const shots: { phase: string; view: string; size: string; file: string }[] = [];
  try {
    for (const { label, repo } of sides) {
      const isAfter = label === "after";
      const server = serveToday(await bundleProjectTabs(repo, resolve(out, `bundle-${label}`), FP), await tailwindCss(repo), FP,
        (path, req) => ptRoute(path, new URL(req.url).searchParams));
      try {
        for (const width of [1280, 390]) {
          const narrow = width < 640, height = narrow ? 844 : 800;
          const views: View[] = narrow ? ["cold", "module", "team"] : ["cold", "map", "module", "team", "task", ...(isAfter ? ["map-plain" as const] : [])];
          for (const view of views) {
            const g = await guardedPage(browser, String(server.url), { width });
            await g.page.clock.setFixedTime(new Date(PT_NOW));
            await g.page.setViewportSize({ width, height });
            await g.page.goto(String(server.url));
            await g.page.waitForFunction(`!!window.__nav`);
            await g.page.evaluate(`window.__nav.open(${JSON.stringify(view === "map-plain" ? PLAIN : MAP)})`);
            await g.page.locator(isAfter ? "[data-project-tab]" : "[role=tab]").first().waitFor({ timeout: 15_000 });
            if (isAfter) await g.page.locator("[data-headline]").waitFor();
            await g.page.waitForTimeout(600);
            // 底部「允许用这个 Floka 打开协作邀请链接」提示与本卡无关：先关掉，免得盖住页面
            const later = g.page.getByRole("button", { name: "以后再说" });
            if (await later.isVisible().catch(() => false)) await later.click();
            await (isAfter ? after : before)(g.page, view, narrow);
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 5);
            const size = `${width}x${height}`, name = `${label}-${view}-${size}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: g.external, errors: g.errors };
            if (view !== "map-plain") shots.push({ phase: label, view, size, file: `${name}.png` });
            await g.ctx.close();
          }
        }
      } finally {
        server.stop(true);
      }
    }
  } finally {
    await browser.close();
  }
  await Bun.write(resolve(out, "shots.json"), JSON.stringify({ now: PT_NOW, shots, issues, requests }, null, 2));
  for (const [name, r] of Object.entries(requests)) expect({ name, external: r.external, errors: r.errors }).toEqual({ name, external: [], errors: [] });
  for (const [name, list] of Object.entries(issues)) if (name.startsWith("after-")) expect({ name, list }).toEqual({ name, list: [] });
}, 300_000);
