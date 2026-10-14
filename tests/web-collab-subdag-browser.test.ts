/**
 * team-project-SUBDAG4 截图（opt-in）：SUBDAG_SHOTS_DIR=<仓库外目录> bun test tests/web-collab-subdag-browser.test.ts
 * 夹具 tests/helpers/subdag-fixture.ts（本机 / 团队同一份节点），时钟固定在 MAIN_NOW，浅色，guardedPage 拦非回环请求。
 * 1280：本机主线 feature、本机全完成 feature、本机切到「图」、团队主线 feature；390：本机、团队主线 feature（手机本卡不改，证明没回退）。
 * SUBDAG_BASELINE_WEB=<基线的 web 目录> 换成改前构建、文件名前缀 before-，只截图不断言；改后跑时同目录有 before-manifest.json 就逐项比
 * 画布文本（「图」= 改前的画布）和 390 的页面文本。本文件不 import 带 react 的模块。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { DONE_TITLE, MAIN_NOW, MAIN_TITLE, serveSubdag, SUBDAG_PROJECT, SUBDAG_TEAM } from "./helpers/subdag-fixture";

const out = process.env.SUBDAG_SHOTS_DIR;
const webRoot = process.env.SUBDAG_BASELINE_WEB ?? "web";
const prefix = process.env.SUBDAG_BASELINE_WEB ? "before-" : "after-";

interface Shot { view: string; size: string; phase: "before" | "after"; file: string; sha256: string }
interface Seen { text: string; canvas: string | null; issues: ShotIssue[] }

/** 以下都是在页面里跑的字符串：根 tsconfig 不带 dom 类型 */
const BOARD = `document.querySelector("[data-focus-board]")`;
const CANVAS_TEXT = `(() => { const w = document.querySelector("[class*=world]"); return w ? w.closest("[class*=wrap]").innerText : null; })()`;
const READY = `!!(document.querySelector("[data-focus-board]") || document.querySelector("[class*=world]")
  || document.querySelector("[class*=mseg]") && /a-owner|e01|✓/.test(document.body.innerText))`;
const HEADINGS = `[...document.querySelectorAll("[data-focus-board] h3")].map((h) => ({ text: h.innerText.trim(), top: h.getBoundingClientRect().top, bottom: h.getBoundingClientRect().bottom }))`;
const FIRST_CARD = `${BOARD}?.querySelector("[data-section=active] [data-focus-key]")?.getAttribute("data-focus-key") ?? null`;
const DIGIT_ONLY = `[...document.querySelectorAll("button")].filter((b) => b.getClientRects().length && /^[✓\\s]*\\d+$/.test(b.innerText.trim())).map((b) => b.innerText.trim())`;
const DONE_IN_VIEW = `(() => { const h = document.querySelector("[data-focus-board] [data-section=done] h3"); if (!h) return false;
  const r = h.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`;
const DONE_ROWS = `${BOARD}?.querySelectorAll("[data-section=done] [data-focus-key]").length ?? 0`;
/** 画布自带的浮条（视口外还有几件、适配全部）盖在节点上：改前同一画布就有，本卡不改画布，只在「图」那张放过这两类 */
const CANVAS_PILLS = /还有 \d+ 件在|适配全部/;
const flashed = (key: string) => `[...document.querySelectorAll('[data-focus-key="${key}"]')].some((el) => [...el.classList].some((c) => /flash/.test(c)))`;

async function settle(page: Page) {
  // 鼠标停在刚点过的位置会悬停到某张卡（依赖联动把别的行变淡）：截图前移开
  await page.mouse.move(1, 1);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(500);
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

async function openFeature(page: Page, title: string) {
  const tab = page.getByRole("tab", { name: "产品 DAG", exact: true });
  if (await tab.count()) await tab.first().click();
  const card = page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first();
  // 全完成的 feature 收在产品 DAG 的「N 已完成」里
  if (!await card.isVisible()) await page.locator("button[aria-expanded=false]").filter({ hasText: "已完成" }).first().click();
  await card.click();
  await page.waitForFunction(READY, undefined, { timeout: 15_000 });
  await settle(page);
}

test.skipIf(!out)("SUBDAG4: 子 DAG 分区列表，本机 / 团队，1280 / 390", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { server, unexpected } = serveSubdag(bundle);
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: Shot[] = [], seen: Record<string, Seen> = {}, external: string[] = [], errors: string[] = [];
  const checks: Record<string, unknown> = {};
  const after = prefix === "after-";
  const shoot = async (page: Page, view: string, size: string) => {
    const name = `${prefix}${view}-${size}`;
    const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
    shots.push({ view, size, phase: after ? "after" : "before", file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
    seen[`${view}-${size}`] = { text: await page.locator("body").innerText(), canvas: await page.evaluate(CANVAS_TEXT) as string | null, issues: await shotIssues(page) };
  };
  const open = async (side: "local" | "team", width: number) => {
    const g = await guardedPage(browser, `${server.url}`, { width, theme: "light" });
    await g.page.clock.setFixedTime(MAIN_NOW);
    await g.page.goto(`${server.url}?side=${side}&theme=light&project=${SUBDAG_PROJECT}&team=${SUBDAG_TEAM}`);
    return g;
  };
  try {
    // 本机 1280：主线 → 图 → 全完成 → 回主线做 chip / 跳转
    {
      const g = await open("local", 1280);
      const page = g.page;
      await openFeature(page, MAIN_TITLE);
      await shoot(page, "local-main", "1280");
      checks.headings = await page.evaluate(HEADINGS);
      checks.firstCard = await page.evaluate(FIRST_CARD);
      checks.digitOnly = await page.evaluate(DIGIT_ONLY);
      checks.innerHeight = await page.evaluate("innerHeight");
      if (after) await page.getByRole("button", { name: "图", exact: true }).click();
      await settle(page);
      await shoot(page, "local-graph", "1280");
      if (after) await page.getByRole("button", { name: "列表", exact: true }).click();
      await openFeature(page, DONE_TITLE);
      await shoot(page, "local-done", "1280");
      checks.doneRows = await page.evaluate(DONE_ROWS);
      if (after) {
        await openFeature(page, MAIN_TITLE);
        // 分段条：点「已完成」段滚到已完成区，标题进入视口（PM 补 · 首屏直达另外两区）
        await page.locator('button[aria-label="已完成 30"]').click();
        await page.waitForFunction(DONE_IN_VIEW, undefined, { timeout: 5_000 });
        checks.segDoneInView = await page.evaluate(DONE_IN_VIEW);
        // chip：a-owner 的上游 d30 在已完成区（默认收着），点了先展开再滚到那一行闪一次
        await page.locator('[data-focus-key="a-owner"]').getByRole("button", { name: "d30", exact: true }).click();
        await page.waitForFunction(flashed("d30"), undefined, { timeout: 5_000 });
        checks.chipDone = await page.evaluate(DONE_ROWS);
        // 「谁在干活」点行 → 回子 DAG 列表，滚到那张卡闪一次
        await page.getByRole("tab", { name: "谁在干活", exact: true }).click();
        await page.locator("[data-work-board] section button").filter({ hasText: "T-a-w2" }).first().click();
        await page.waitForFunction(flashed("a-w2"), undefined, { timeout: 5_000 });
        checks.jumpBoard = await page.evaluate(`!!${BOARD}`);
      }
      external.push(...g.external); errors.push(...g.errors);
      await g.ctx.close();
    }
    // 团队 1280：同一版面，没有已耗、没有事件行、没有「暂无」
    {
      const g = await open("team", 1280);
      await openFeature(g.page, MAIN_TITLE);
      await shoot(g.page, "team-main", "1280");
      checks.teamBoard = await g.page.evaluate(`${BOARD}?.innerText ?? null`);
      external.push(...g.external); errors.push(...g.errors);
      await g.ctx.close();
    }
    for (const side of ["local", "team"] as const) {
      const g = await open(side, 390);
      await openFeature(g.page, MAIN_TITLE);
      await shoot(g.page, `${side}-main`, "390");
      external.push(...g.external); errors.push(...g.errors);
      await g.ctx.close();
    }
  } finally { await browser.close(); server.stop(true); }
  const issues = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.issues]));
  const texts = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { text: v.text, canvas: v.canvas }]));
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-SUBDAG4", web: webRoot, shots, issues, checks, external, errors, unexpected, texts }, null, 2) + "\n");
  if (!after) return;
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  for (const [name, list] of Object.entries(issues)) {
    const own = name === "local-graph-1280" ? list.filter((i) => !(i.kind === "overlap" && CANVAS_PILLS.test(i.detail))) : list;
    expect({ name, list: own }).toEqual({ name, list: [] });
  }
  // [验收线 1] 首屏三个分区标题依次出现，第一张是等 owner，没有只写数字的折叠块
  const heads = checks.headings as { text: string; top: number; bottom: number }[];
  expect(heads.map((h) => h.text)).toEqual(["进行中 8", "接下来 16", "已完成 30"]);
  expect(checks.firstCard).toBe("a-owner");
  expect(checks.digitOnly).toEqual([]);
  expect(checks.segDoneInView).toBe(true);
  // [验收线 2] 全完成 feature 不点就展开
  expect(checks.doneRows as number).toBeGreaterThanOrEqual(12);
  // [验收线 3] 图 = 画布；chip / 跳转闪到目标，已完成目标先展开
  expect(seen["local-graph-1280"]!.canvas).not.toBeNull();
  expect(checks.chipDone as number).toBeGreaterThan(0);
  expect(checks.jumpBoard).toBe(true);
  // [验收线 4] 团队同一版面：执行者来自团队看板，没有已耗 / 事件 / 「暂无」
  const team = checks.teamBoard as string;
  expect(team).toContain("进行中 8");
  expect(team).toMatch(/dev-\d/);
  expect(team).not.toMatch(/暂无|分钟前|小时前|天前|刚刚|\d+分|\d+小时/);
  const before = resolve(out, "before-manifest.json");
  if (!existsSync(before)) return;
  const base = JSON.parse(readFileSync(before, "utf8")) as { texts: Record<string, { text: string; canvas: string | null }> };
  // [验收线 3] 「图」的画布文本 = 改前同一 feature 的画布；[验收线 5] 390 改前 / 改后页面文本一致
  expect(seen["local-graph-1280"]!.canvas).toBe(base.texts["local-main-1280"]!.canvas);
  for (const k of ["local-main-390", "team-main-390"]) expect({ k, text: seen[k]!.text }).toEqual({ k, text: base.texts[k]!.text });
}, 240_000);
