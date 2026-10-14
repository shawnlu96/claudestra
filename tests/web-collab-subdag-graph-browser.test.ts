/**
 * team-project-SUBDAG7 截图与浏览器验收（opt-in）：SUBDAG_SHOTS_DIR=<仓库外目录> bun test tests/web-collab-subdag-graph-browser.test.ts
 * 夹具 tests/helpers/subdag-fixture.ts（只 import），时钟固定在 MAIN_NOW，浅色，guardedPage 拦非回环请求。大 feature（v190 形状：180 个节点，
 * 已完成 157，第 0 列 67，进行中 8）用 extra 钩子把本机 /dag 里主线 feature 的节点换掉，/work 另加一行指向第 0 列第 30 个已完成节点供跳转。
 * 1280：本机主线「图」、大 feature 完整画布已完成第 1 / 2 页、团队主线「图」；390：本机主线子 DAG（手机本卡不改，证明没回退）。
 * SUBDAG_BASELINE_WEB=<基线的 web 目录> 换成改前构建、文件名前缀 before-，只截图不断言（改前「图」= 完整画布，已完成一次铺满，第 2 页同第 1 页）；
 * 改后跑时同目录有 before-manifest.json 就比 390 的页面文本。本文件不 import 带 react 的模块。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { MAIN_NOW, MAIN_TITLE, serveSubdag, SUBDAG_PROJECT, SUBDAG_TEAM } from "./helpers/subdag-fixture";
import { mainlineWork, node, workRow } from "./web-collab-dag-fixture";
import type { BoardNode, DagBoard } from "../web/features/collab/dag/dag-types";

const out = process.env.SUBDAG_SHOTS_DIR;
const webRoot = process.env.SUBDAG_BASELINE_WEB ?? "web";
const after = !process.env.SUBDAG_BASELINE_WEB;
const prefix = after ? "after-" : "before-";
const L = `/api/v1/ledger/${SUBDAG_PROJECT}`;

interface Shot { view: string; size: string; phase: "before" | "after"; file: string; sha256: string }

/** v190 形状：第 0 列 67 个已完成，第 1..3 列各 30，进行中 8，没开始 15 */
function bigNodes(): BoardNode[] {
  const col = (c: number, n: number) => Array.from({ length: n }, (_, i) => node(`c${c}-${String(i).padStart(2, "0")}`, "done", c ? [`c${c - 1}-00`] : [],
    { doneAt: MAIN_NOW - (c * 100 + i + 1) * 60_000, round: 1 }));
  const active = Array.from({ length: 8 }, (_, i) => node(`a${i}`, "active", ["c3-00"], { since: MAIN_NOW - 5 * 60_000 }));
  const idle = Array.from({ length: 15 }, (_, i) => node(`i${String(i).padStart(2, "0")}`, "idle", [`a${i % 8}`]));
  return [...col(0, 67), ...col(1, 30), ...col(2, 30), ...col(3, 30), ...active, ...idle];
}

/** 以下都是在页面里跑的字符串：根 tsconfig 不带 dom 类型 */
const WORLD = `document.querySelector("[class*=world]")`;
const fullCards = `[...${WORLD}.children].filter((e) => [...e.classList].some((c) => /^(full|[a-zA-Z0-9]*_full)/.test(c))).length`;
const colDone = (col: number) => `${WORLD}.querySelectorAll('button[title^="做 c${col}-"]').length`;
const foldText = (kind: string) => `${WORLD}.querySelector('[data-fold=${kind}]')?.innerText.replace(/\\s+/g, " ").trim() ?? null`;
const graphPressed = `document.querySelector('[role=group] button[aria-pressed=true]')?.innerText ?? null`;
const nodeEl = (key: string) => `${WORLD}.querySelector('button[title="做 ${key}"]')?.parentElement`;
const flashed = (key: string) => `[...(${nodeEl(key)}?.classList ?? [])].some((c) => /flash/.test(c))`;
const centerGap = (key: string) => `(() => { const n = ${nodeEl(key)}.getBoundingClientRect(), c = document.querySelector("[class*=canvas]").getBoundingClientRect();
  return Math.hypot(n.left + n.width / 2 - (c.left + c.width / 2), n.top + n.height / 2 - (c.top + c.height / 2)); })()`;
/** 画布自带的浮条（视口外还有几件、适配全部）盖在节点上：改前同一画布就有，本卡不改，放过这两类 */
const CANVAS_PILLS = /还有 \d+ 件|适配全部/;

async function settle(page: Page) {
  await page.mouse.move(1, 1);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(500);
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

async function openMain(page: Page) {
  await page.getByRole("tab", { name: "产品 DAG", exact: true }).first().click();
  await page.getByRole("button").filter({ has: page.getByText(MAIN_TITLE, { exact: true }) }).first().click();
  await page.waitForFunction(`!!(document.querySelector("[data-focus-board]") || ${WORLD} || document.querySelector("[class*=mseg]"))`, undefined, { timeout: 15_000 });
  await settle(page);
}

async function toGraph(page: Page) {
  await page.getByRole("button", { name: "图", exact: true }).click();
  await page.waitForFunction(`!!${WORLD}`);
  await settle(page);
}

test.skipIf(!out)("SUBDAG7: 子 DAG 聚焦图 / 完整画布已完成分页，本机 / 团队 1280，本机 390", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const main = serveSubdag(bundle);
  const big = serveSubdag(bundle, { extra: (path) => {
    if (path === `${L}/dag`) {
      const b: DagBoard = big.fx.local.board, nodes = bigNodes();
      const count = (p: string) => nodes.filter((n) => n.phase === p).length;
      return Response.json({ ...b, features: b.features.map((f) => (f.title === MAIN_TITLE
        ? { ...f, nodes, counts: { total: nodes.length, done: count("done"), active: count("active"), idle: count("idle"), missing: 0 } } : f)) });
    }
    if (path === `${L}/work`) {
      const w = mainlineWork(MAIN_NOW);
      return Response.json({ ...w, working: [...w.working, workRow("c0-29", { since: MAIN_NOW - 60_000 })] });
    }
    return null;
  } });
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: Shot[] = [], issues: Record<string, ShotIssue[]> = {}, texts: Record<string, string> = {}, external: string[] = [], errors: string[] = [];
  const checks: Record<string, unknown> = {};
  const shoot = async (page: Page, view: string, width: number) => {
    const name = `${prefix}${view}-${width}x900`;
    const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
    shots.push({ view, size: `${width}x900`, phase: after ? "after" : "before", file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
    issues[`${view}-${width}`] = await shotIssues(page);
    texts[`${view}-${width}`] = await page.locator("body").innerText();
  };
  const open = async (url: string, side: "local" | "team", width: number) => {
    const g = await guardedPage(browser, url, { width, theme: "light" });
    await g.page.clock.setFixedTime(MAIN_NOW);
    await g.page.goto(`${url}?side=${side}&theme=light&project=${SUBDAG_PROJECT}&team=${SUBDAG_TEAM}`);
    return g;
  };
  const done = async (g: Awaited<ReturnType<typeof open>>) => { external.push(...g.external); errors.push(...g.errors); await g.ctx.close(); };
  try {
    // 本机 1280 主线：「图」= 聚焦图（改前 = 完整画布）
    {
      const g = await open(`${main.server.url}`, "local", 1280);
      const page = g.page;
      await openMain(page);
      await toGraph(page);
      await shoot(page, "main-graph", 1280);
      if (after) {
        checks.fullCards = await page.evaluate(fullCards);
        checks.rest = await page.evaluate(foldText("rest"));
        checks.far = await page.evaluate(foldText("far"));
        await page.locator("[data-fold=far]").click();
        await settle(page);
        checks.farFull = { done: await page.evaluate(foldText("done")), far: await page.evaluate(foldText("far")), pressed: await page.evaluate(graphPressed) };
        await toGraph(page);
        checks.backFocus = await page.evaluate(foldText("rest"));
      }
      await done(g);
    }
    // 本机 1280 大 feature：完整画布点开已完成（改前一次铺满）→ 第 2 页 → 回聚焦图，从「谁在干活」跳到第 0 列第 30 个已完成
    {
      const g = await open(`${big.server.url}`, "local", 1280);
      const page = g.page;
      await openMain(page);
      await toGraph(page);
      if (after) await page.locator("[data-fold=rest]").click();
      else await page.locator("[class*=world] button[class*=fold]").first().click();
      await settle(page);
      await shoot(page, "big-done-page1", 1280);
      checks.page1 = { col0: await page.evaluate(colDone(0)), col1: await page.evaluate(colDone(1)), more: await page.evaluate(foldText("more")) };
      if (after) await page.locator("[data-fold=more]").first().click();
      await settle(page);
      await shoot(page, "big-done-page2", 1280);
      checks.page2 = { col0: await page.evaluate(colDone(0)), more: await page.evaluate(foldText("more")) };
      if (after) {
        await toGraph(page);
        await page.getByRole("tab", { name: "谁在干活", exact: true }).click();
        await page.locator("[data-work-board] section button").filter({ hasText: "T-c0-29" }).first().click();
        await page.waitForFunction(flashed("c0-29"), undefined, { timeout: 5_000 });
        await page.waitForTimeout(800);
        checks.jump = { col0: await page.evaluate(colDone(0)), pressed: await page.evaluate(graphPressed), gap: await page.evaluate(centerGap("c0-29")),
          flashed: await page.evaluate(flashed("c0-29")) };
      }
      await done(g);
    }
    // 团队 1280 主线「图」
    {
      const g = await open(`${main.server.url}`, "team", 1280);
      await openMain(g.page);
      await toGraph(g.page);
      await shoot(g.page, "team-main-graph", 1280);
      if (after) checks.teamFullCards = await g.page.evaluate(fullCards);
      await done(g);
    }
    // 本机 390：SUBDAG8 的窄屏列表，改前改后一致
    {
      const g = await open(`${main.server.url}`, "local", 390);
      await openMain(g.page);
      await shoot(g.page, "main", 390);
      checks.overflow390 = await g.page.evaluate("document.scrollingElement.scrollWidth > innerWidth");
      await done(g);
    }
  } finally { await browser.close(); main.server.stop(true); big.server.stop(true); }
  const unexpected = [...main.unexpected, ...big.unexpected];
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-SUBDAG7", web: webRoot, shots, issues, checks, external, errors, unexpected, texts }, null, 2) + "\n");
  if (!after) return;
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  for (const [name, list] of Object.entries(issues)) {
    expect({ name, list: list.filter((i) => !(i.kind === "overlap" && CANVAS_PILLS.test(i.detail))) }).toEqual({ name, list: [] });
  }
  // [验收线 3] 主线「图」：完整卡正好 8 张，两枚小片带字；点「更远」进完整画布（✓N 收着，「图」仍按下），再点「图」回聚焦图
  expect(checks.fullCards).toBe(8);
  expect(checks.rest).toBe("其余 29 已完成");
  expect(checks.far).toBe("更远 8");
  expect(checks.farFull).toEqual({ done: "30", far: null, pressed: "图" });
  expect(checks.backFocus).toBe("其余 29 已完成");
  expect(checks.teamFullCards).toBe(8);
  // [验收线 4] 大 feature：第 0 列 12 个 +「还有 55」，点一下 24 个；跳到第 0 列第 30 个已完成：开到第 3 页（36 个）、进完整画布、居中、闪一次
  expect(checks.page1).toEqual({ col0: 12, col1: 12, more: "还有 55 个已完成" });
  expect(checks.page2).toEqual({ col0: 24, more: "还有 43 个已完成" });
  const jump = checks.jump as { col0: number; pressed: string; gap: number; flashed: boolean };
  expect(jump.col0).toBe(36);
  expect(jump.pressed).toBe("图");
  expect(jump.flashed).toBe(true);
  expect(jump.gap).toBeLessThan(40);
  // [验收线 6] 390 没有横向滚动；改前 / 改后页面文本一致
  expect(checks.overflow390).toBe(false);
  const before = resolve(out, "before-manifest.json");
  if (!existsSync(before)) return;
  const base = JSON.parse(readFileSync(before, "utf8")) as { texts: Record<string, string> };
  expect(texts["main-390"]).toBe(base.texts["main-390"]!);
}, 300_000);
