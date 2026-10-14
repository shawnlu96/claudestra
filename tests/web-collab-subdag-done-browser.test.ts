/**
 * team-project-SUBDAG5 已完成区截图（opt-in）：SUBDAG_SHOTS_DIR=<仓库外目录> bun test tests/web-collab-subdag-done-browser.test.ts
 * 夹具 tests/helpers/subdag-fixture.ts，时钟 MAIN_NOW（上海 20:00），浅色，guardedPage 拦非回环请求。主线 F1 已完成 30 = 今天 12 / 昨天 8 / 更早 10，
 * 全完成 F9 12/12 其中今天 5。截图：1280 折叠 / 展开 / 搜索 / 全完成自动展开；390 走旧手机列表，只证明没回退（改前改后页面文本一致）。
 * 分页和「更早第 15 位」用第二个服务：extra 钩子给 F1 再塞 55 个更早完成的节点（5 个排在 d30 前面），更早段变 65 行，d30 落在第 15 位。
 * SUBDAG_BASELINE_WEB=<基线的 web 目录> 换成改前构建、文件名前缀 before-，只截图不断言。本文件不 import 带 react 的模块。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { teamDagFeature } from "@/features/collab/team-source-dag";
import type { DagBoard } from "@/features/collab/dag/dag-types";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { DONE_TITLE, MAIN_NOW, MAIN_TITLE, serveSubdag, SUBDAG_PROJECT, SUBDAG_TEAM, type Extra } from "./helpers/subdag-fixture";
import { node } from "./web-collab-dag-fixture";

const out = process.env.SUBDAG_SHOTS_DIR;
const webRoot = process.env.SUBDAG_BASELINE_WEB ?? "web";
const after = !process.env.SUBDAG_BASELINE_WEB;
const prefix = after ? "after-" : "before-";
const HOUR = 60 * 60_000;
const L = `/api/v1/ledger/${SUBDAG_PROJECT}`;

/** 页面里跑的字符串（根 tsconfig 不带 dom 类型） */
const DONE = `document.querySelector("[data-focus-board] [data-section=done]")`;
const SECTIONS = `[...(${DONE}?.querySelectorAll("[data-done-section] h4 button") ?? [])].map((b) => [b.innerText.replace(/\\s+/g, " ").trim(), b.getAttribute("aria-expanded")])`;
const visibleRows = (k: string) => `[...(${DONE}?.querySelectorAll('[data-done-section="${k}"] [data-focus-key]') ?? [])].filter((r) => getComputedStyle(r).visibility === "visible").length`;
const SHOWN_KEYS = `[...(${DONE}?.querySelectorAll("[data-focus-key]") ?? [])].filter((r) => r.checkVisibility({ visibilityProperty: true })).map((r) => r.dataset.focusKey)`;
const DONE_OPEN = `${DONE}?.querySelector("h3 button")?.getAttribute("aria-expanded") ?? null`;
const SEARCH = `${DONE}?.querySelector("input")?.value ?? null`;
const flashedInView = (key: string) => `(() => { const el = ${DONE}?.querySelector('[data-focus-key="${key}"]'); if (!el) return null;
  const r = el.getBoundingClientRect(), box = el.closest("[data-focus-board]").getBoundingClientRect();
  return { flash: [...el.classList].some((c) => /flash/.test(c)), inView: r.top >= box.top && r.bottom <= Math.min(box.bottom, innerHeight),
    section: el.closest("[data-done-section]")?.dataset.doneSection ?? null, index: [...el.parentElement.querySelectorAll("[data-focus-key]")].indexOf(el) }; })()`;
/** 列表 / 画布 / 手机分段就位（手机上全完成的 feature 只有一个收着的 ✓ 块，没有节点 key 可等） */
const READY = `!!document.querySelector("[data-focus-board], [class*=world], [class*=mseg]")`;

/** 给 F1 多 55 个更早完成的节点：x01–x05 落在 d21（72h 前）和 d30（81h 前）之间，x06–x55 比 d30 还早 */
function biggerF1(board: DagBoard): DagBoard {
  const extra = Array.from({ length: 55 }, (_, i) => node(`x${String(i + 1).padStart(2, "0")}`, "done", [],
    { doneAt: MAIN_NOW - (i < 5 ? 72.5 + i : 90 + i) * HOUR, round: 1 }));
  return { ...board, features: board.features.map((f) => f.id !== "F1" ? f
    : { ...f, nodes: [...f.nodes, ...extra], counts: { ...f.counts, total: f.counts.total + 55, done: f.counts.done + 55 } }) };
}
const bigExtra: Extra = async (path, url, req) => {
  if (req.headers.get("x-fixture-raw") || (path !== `${L}/dag` && path !== `${L}/dag/F1`)) return null;
  const raw = await fetch(new URL(`${L}/dag`, url), { headers: { "x-fixture-raw": "1" } });
  const board = biggerF1(await raw.json() as DagBoard);
  return Response.json(path === `${L}/dag` ? board : teamDagFeature(board, "F1"));
};

async function openFeature(page: Page, title: string) {
  const tab = page.getByRole("tab", { name: "产品 DAG", exact: true });
  if (await tab.count()) await tab.first().click();
  const card = page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first();
  if (!await card.isVisible()) await page.locator("button[aria-expanded=false]").filter({ hasText: "已完成" }).first().click();
  await card.click();
  await page.waitForFunction(READY, undefined, { timeout: 15_000 });
  await calm(page);
}

/** 截图前把已完成区顶到滚动区上沿（主线 feature 的已完成区在首屏下面） */
const toDone = (page: Page) => page.evaluate(`${DONE}.scrollIntoView({ block: "start" })`);

async function calm(page: Page) {
  await page.mouse.move(1, 1);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(500);
}

const doneHead = (page: Page) => page.locator("[data-focus-board] [data-section=done] h3 button");

test.skipIf(!out)("SUBDAG5: 已完成区搜索 / 按天分段 / 分页，1280 / 390", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const plain = serveSubdag(bundle), big = serveSubdag(bundle, { extra: bigExtra });
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: { view: string; size: string; phase: string; file: string; sha256: string }[] = [];
  const issues: Record<string, ShotIssue[]> = {}, texts: Record<string, string> = {}, checks: Record<string, unknown> = {};
  const external: string[] = [], errors: string[] = [];
  const shoot = async (page: Page, view: string, size: string) => {
    const file = `${prefix}${view}-${size}.png`;
    const png = await page.screenshot({ path: resolve(out, file) });
    shots.push({ view, size, phase: after ? "after" : "before", file, sha256: createHash("sha256").update(png).digest("hex") });
    issues[`${view}-${size}`] = await shotIssues(page);
    texts[`${view}-${size}`] = await page.locator("body").innerText();
  };
  const open = async (server: { url: URL }, width: number) => {
    const g = await guardedPage(browser, `${server.url}`, { width, theme: "light" });
    await g.page.clock.setFixedTime(MAIN_NOW);
    await g.page.goto(`${server.url}?side=local&theme=light&project=${SUBDAG_PROJECT}&team=${SUBDAG_TEAM}`);
    return g;
  };
  const close = async (g: Awaited<ReturnType<typeof open>>) => {
    external.push(...g.external); errors.push(...g.errors);
    await g.ctx.close();
  };
  try {
    {
      const g = await open(plain.server, 1280), page = g.page;
      await openFeature(page, MAIN_TITLE);
      await toDone(page);
      await calm(page);
      await shoot(page, "collapsed", "1280");
      await doneHead(page).click();
      await toDone(page);
      await calm(page);
      await shoot(page, "expanded", "1280");
      checks.sections = await page.evaluate(SECTIONS);
      checks.visible = await page.evaluate(`[${["today", "yesterday", "earlier"].map(visibleRows).join(",")}]`);
      const search = page.locator("[data-focus-board] [data-section=done] input");
      if (await search.count()) {
        await search.fill("D17");
        await toDone(page);
        await calm(page);
        checks.searchKeys = await page.evaluate(SHOWN_KEYS);
        await shoot(page, "search", "1280");
        await search.press("Escape");
        await calm(page);
        checks.afterEsc = [await page.evaluate(SEARCH), (await page.evaluate(SHOWN_KEYS) as string[]).length];
        await search.fill("没有这个词");
        checks.noMatch = (await page.locator("[data-focus-board] [data-section=done]").innerText()).replace(/\s+/g, " ").trim();
      } else await shoot(page, "search", "1280");
      // [验收线 4] 全完成 feature 不点就展开今天；手动收起 → 切走 → 切回，不再自动展开
      await openFeature(page, DONE_TITLE);
      await shoot(page, "done-auto", "1280");
      checks.autoSections = await page.evaluate(SECTIONS);
      checks.autoOpen = await page.evaluate(DONE_OPEN);
      if (after) {
        await doneHead(page).click();
        await openFeature(page, MAIN_TITLE);
        await openFeature(page, DONE_TITLE);
        checks.autoAfterClose = await page.evaluate(DONE_OPEN);
      }
      await close(g);
    }
    if (after) {
      // [验收线 2] 分页 + [验收线 3] 搜索中发起跳转到更早段第 15 位
      const g = await open(big.server, 1280), page = g.page;
      await openFeature(page, MAIN_TITLE);
      await doneHead(page).click();
      await page.locator('[data-done-section="earlier"] h4 button').click();
      await calm(page);
      checks.earlierBefore = await page.evaluate(visibleRows("earlier"));
      await page.locator('[data-done-section="earlier"]').getByRole("button", { name: "再显示 50", exact: true }).click();
      checks.earlierAfter = await page.evaluate(visibleRows("earlier"));
      await page.locator('[data-done-section="earlier"] h4 button').click();
      await page.locator("[data-focus-board] [data-section=done] input").fill("x0");
      await page.evaluate(`document.querySelector("[data-focus-board]").scrollTop = 0`);
      await page.locator('[data-focus-key="a-owner"]').getByRole("button", { name: "d30", exact: true }).click();
      await page.waitForFunction(`(${flashedInView("d30")})?.flash === true`, undefined, { timeout: 5_000 });
      await page.waitForTimeout(900);
      checks.jump = { search: await page.evaluate(SEARCH), row: await page.evaluate(flashedInView("d30")), sections: await page.evaluate(SECTIONS) };
      await close(g);
    }
    for (const title of [MAIN_TITLE, DONE_TITLE]) {
      const g = await open(plain.server, 390);
      await openFeature(g.page, title);
      await shoot(g.page, title === MAIN_TITLE ? "mobile-main" : "mobile-done", "390");
      await close(g);
    }
  } finally { await browser.close(); plain.server.stop(true); big.server.stop(true); }
  const unexpected = [...plain.unexpected, ...big.unexpected];
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-SUBDAG5", web: webRoot, shots, issues, checks, external, errors, unexpected, texts },
    null, 2) + "\n");
  if (!after) return;
  // [验收线 5] 非回环请求 0、夹具外接口 0、页面无报错、截图自动检查为空
  expect({ external, errors, unexpected }).toEqual({ external: [], errors: [], unexpected: [] });
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  // [验收线 2] 三段 12 / 8 / 10，只有今天展开；更早段 65 行先 20，再显示 50 后全部列出
  expect(checks.sections).toEqual([["今天 12", "true"], ["昨天 8", "false"], ["更早 10", "false"]]);
  expect(checks.visible).toEqual([12, 0, 0]);
  expect([checks.earlierBefore, checks.earlierAfter]).toEqual([20, 65]);
  // 搜索一个 key 只剩这一行；Esc 清空；无结果只有一行「没有匹配」
  expect(checks.searchKeys).toEqual(["d17"]);
  expect(checks.afterEsc).toEqual(["", 12]);
  expect(checks.noMatch).toBe("已完成 30 没有匹配");
  // [验收线 3] 搜索中跳到更早第 15 位：搜索清空、更早展开、在视口里、闪一次
  expect(checks.jump).toEqual({ search: "", row: { flash: true, inView: true, section: "earlier", index: 14 },
    sections: [["今天 12", "true"], ["昨天 8", "false"], ["更早 65", "true"]] });
  // [验收线 4]
  expect(checks.autoSections).toEqual([["今天 5", "true"], ["昨天 7", "false"]]);
  expect([checks.autoOpen, checks.autoAfterClose]).toEqual(["true", "false"]);
  const before = resolve(out, "before-manifest.json");
  if (!existsSync(before)) return;
  const base = JSON.parse(readFileSync(before, "utf8")) as { texts: Record<string, string> };
  // 390 走旧手机列表：改前 / 改后页面文本一致
  for (const k of ["mobile-main-390", "mobile-done-390"]) expect({ k, text: texts[k] }).toEqual({ k, text: base.texts[k] });
}, 240_000);
