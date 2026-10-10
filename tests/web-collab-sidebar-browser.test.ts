/**
 * team-project-N8C1：协作视图打开时桌面端收起会话栏（CollabSidebarGate）+ 视图左缘窄栏按钮（CollabSidebarRail）。
 * 真 Chromium + team-view-harness 夹具（?sidebarGate=1 让夹具侧栏套上线上那层 Gate），本机未绑定项目、数据全部合成。
 * 截图：COLLAB_SIDEBAR_SHOTS_DIR=<仓库外目录>（缺省写临时目录、跑完删掉）。
 * 改前对照：在基线上带 COLLAB_SIDEBAR_SHOTS_BEFORE=1 跑，只走同一流程拍图（基线没有窄栏，不点展开、不断言）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";

const BEFORE = process.env.COLLAB_SIDEBAR_SHOTS_BEFORE === "1";
const work = mkdtempSync(join(tmpdir(), "cstra-test-collab-sidebar-"));
const shotsDir = process.env.COLLAB_SIDEBAR_SHOTS_DIR ? resolve(process.env.COLLAB_SIDEBAR_SHOTS_DIR) : join(work, "shots");
const SIDE = "[data-collab-sidebar] > aside";
const TARGET = "项目 24";
/** 项目多到侧栏列表要滚动（验「收起再回来滚动位置还在」） */
const PROJECTS = { "mac-a": Array.from({ length: 30 }, (_, i) => ({ id: `proj-${i}`, name: `项目 ${i}`, emoji: "📦" })) };
const ledger = generateTeamFixture({ seed: 3, features: 1, nodes: 5, now: Date.UTC(2026, 9, 8, 4, 0) }).local;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  const bundle = Bun.spawn([process.execPath, "build", "web/features/collab/team-view-harness.tsx", "--target", "browser", "--outdir", work,
    "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await bundle.exited) throw new Error(await new Response(bundle.stderr).text());
  const webRequire = createRequire(resolve("web/package.json"));
  const globals = resolve("web/app/globals.css");
  const tailwind = await webRequire("postcss")([webRequire("@tailwindcss/postcss")({ base: resolve("web") })])
    .process(readFileSync(globals, "utf8"), { from: globals });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css"><link rel="stylesheet" href="/team-view-harness.css"></head>
    <body><div id="root"></div><script src="/team-view-harness.js"></script></body></html>`;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const api = url.pathname.match(/^\/m\/mac-a\/api\/v1(\/.*)$/)?.[1];
    if (api === "/shared-ledger/context") return Response.json({ identities: [] });
    if (api && /^\/ledger\/proj-\d+$/.test(api)) return Response.json({ ok: true, ...ledger });
    if (api) return Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
    if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/tw.css") return new Response(tailwind.css, { headers: { "Content-Type": "text/css" } });
    if (url.pathname === "/app-config.json") return Response.json({ mode: "relay", relayBase: url.origin, version: "" });
    return /^\/team-view-harness\.(js|css)$/.test(url.pathname) ? new Response(Bun.file(join(work, url.pathname))) : new Response(null, { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);

afterAll(async () => {
  server?.stop(true);
  await browser?.close();
  if (!process.env.COLLAB_SIDEBAR_SHOTS_DIR) rmSync(work, { recursive: true, force: true });
}, 60_000);

async function open(width: number, extra: Record<string, string> = {}) {
  const page = await browser.newPage({ viewport: { width, height: width < 640 ? 844 : 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort()); // 只许回环
  await page.goto(`${server.url}?${new URLSearchParams({ machine: "mac-a", theme: "light", sidebarGate: "1", projects: JSON.stringify(PROJECTS), ...extra })}`);
  await page.locator("[data-machine]").first().waitFor();
  return { page, errors };
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shotsDir, `${BEFORE ? "before" : "after"}-${name}.png`), animations: "disabled" });
const entry = (page: Page) => page.locator("nav[aria-label='侧栏'] > ul > li").filter({ has: page.getByRole("button", { name: TARGET, exact: false }) })
  .first().getByRole("button", { name: "协作视图" });
const viewReady = (page: Page) => page.locator("main").getByText("团队视图 feature 1", { exact: false }).first().waitFor();
const js = (page: Page, expr: string) => page.evaluate(expr) as Promise<unknown>;
const closeView = async (page: Page) => {
  await page.evaluate("window.__systemBack()");
  await page.waitForFunction("document.body.dataset.open === ''");
  await page.mouse.move(640, 400); // 截图不带侧栏行的 hover / focus 态
  await js(page, "document.activeElement?.blur()");
};
const gate = (page: Page) => js(page, "document.querySelector('[data-collab-sidebar]')?.dataset.collabSidebar ?? null");
const scrollTop = (page: Page) => js(page, "document.querySelector(\"nav[aria-label='侧栏']\").scrollTop") as Promise<number>;
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

test("1280：打开协作视图会话栏收起、视图占满；窄栏按钮展开 / 收起；关掉后会话栏原样回来；再打开默认收起", async () => {
  const { page, errors } = await open(1280);
  await entry(page).scrollIntoViewIfNeeded();
  if (BEFORE) {
    await entry(page).click();
    await viewReady(page);
    await shot(page, "1-open-1280");
    await closeView(page);
    await shot(page, "3-closed-1280");
    return;
  }
  // 侧栏的宽度变量、滚动位置、DOM 节点：收起再回来都得是原来那份（没卸载）
  await page.evaluate("(() => { const a = document.querySelector('aside'); a.style.setProperty('--sb-w', '301px'); a.__same = true; })()");
  const top = await scrollTop(page);
  expect(top).toBeGreaterThan(0);
  const wide = (await box(page, SIDE)).width;
  expect(await gate(page)).toBe("shown");

  await entry(page).click();
  await viewReady(page);
  expect(await gate(page)).toBe("collapsed");
  expect(await page.locator(SIDE).isVisible()).toBe(false);
  expect(await box(page, "main")).toMatchObject({ x: 0, width: 1280 });
  const toggle = page.locator("main button[aria-expanded]").first();
  expect(await toggle.getAttribute("aria-label")).toBe("展开会话栏");
  expect(await toggle.getAttribute("title")).toBe("展开会话栏");
  expect((await toggle.innerText()).trim()).toBe(""); // 只有图标
  expect((await toggle.boundingBox())!.x).toBeLessThan(32);
  await shot(page, "1-open-1280");

  // 键盘：侧栏收起后第一个 Tab 落在窄栏按钮上，有可见的 focus 圈，回车展开
  await page.keyboard.press("Tab");
  expect(await js(page, "document.activeElement?.getAttribute('aria-label')")).toBe("展开会话栏");
  expect(await js(page, "(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; })()")).toBe(true);
  await page.keyboard.press("Enter");
  expect(await gate(page)).toBe("shown");
  expect(await toggle.getAttribute("aria-label")).toBe("收起会话栏");
  expect(await toggle.getAttribute("aria-expanded")).toBe("true");
  expect((await box(page, SIDE)).width).toBe(wide);
  expect(await scrollTop(page)).toBe(top);
  expect((await box(page, "main")).x).toBe(wide);

  await toggle.click();
  expect(await gate(page)).toBe("collapsed");
  expect(await toggle.getAttribute("aria-label")).toBe("展开会话栏");
  expect(await page.locator(SIDE).isVisible()).toBe(false);
  await toggle.click();
  expect(await gate(page)).toBe("shown");
  await page.mouse.move(640, 400);
  await shot(page, "2-expanded-1280");

  await toggle.click(); // 收起着关掉
  await closeView(page);
  expect(await gate(page)).toBe("shown");
  expect(await page.locator("main button[aria-expanded]").count()).toBe(0);
  expect((await box(page, SIDE)).width).toBe(wide);
  expect(await scrollTop(page)).toBe(top);
  expect(await js(page, "(() => { const a = document.querySelector('aside'); return [a.__same === true, a.style.getPropertyValue('--sb-w')]; })()")).toEqual([true, "301px"]);
  await shot(page, "3-closed-1280");

  // 展开只管那一次打开：展开着关掉，再打开默认又是收起
  await entry(page).click();
  await viewReady(page);
  expect(await gate(page)).toBe("collapsed");
  await toggle.click();
  expect(await gate(page)).toBe("shown");
  await closeView(page);
  await entry(page).click();
  await viewReady(page);
  expect(await gate(page)).toBe("collapsed");
  expect(await toggle.getAttribute("aria-label")).toBe("展开会话栏");
  expect(errors).toEqual([]);
  await page.close();
}, 90_000);

test("390：窄屏不出现窄栏，Gate 外层始终是 contents，打开 / 关闭照旧", async () => {
  const { page, errors } = await open(390);
  await entry(page).scrollIntoViewIfNeeded();
  await entry(page).click();
  await page.getByRole("button", { name: "返回", exact: true }).waitFor();
  await page.getByText("i28-A1", { exact: false }).first().waitFor();
  await shot(page, "4-open-390");
  if (!BEFORE) {
    expect(await gate(page)).toBe("collapsed");
    expect(await js(page, "getComputedStyle(document.querySelector('[data-collab-sidebar]')).display")).toBe("contents");
    expect(await page.locator("main button[aria-expanded]").first().isVisible()).toBe(false);
    expect(await box(page, "main")).toMatchObject({ x: 0, width: 390 });
    expect(await page.locator(SIDE).isVisible()).toBe(false);
  }
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await entry(page).waitFor();
  if (!BEFORE) {
    expect(await gate(page)).toBe("shown");
    expect((await box(page, SIDE)).width).toBe(390);
  }
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

test("390：视图开着时返回列表（生产语义：不关视图），滚动列表后选会话关掉视图，列表停在新位置、不被旧位置盖回去", async () => {
  const { page, errors } = await open(390, { keepOnBack: "1" });
  const scrollTo = (top: number) => js(page, `new Promise((done) => { const n = document.querySelector("nav[aria-label='侧栏']");
    n.addEventListener("scroll", () => requestAnimationFrame(() => done(n.scrollTop)), { once: true }); n.scrollTop = ${top}; })`) as Promise<number>;
  const before = await scrollTo(120);
  expect(before).toBeGreaterThan(0);
  await entry(page).scrollIntoViewIfNeeded(); // 打开前列表停在一个「旧位置」
  const old = await scrollTop(page);
  await entry(page).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await entry(page).waitFor();
  expect(await js(page, "document.body.dataset.open")).not.toBe(""); // 视图还开着，只是回到了列表
  expect(await js(page, "getComputedStyle(document.querySelector('[data-collab-sidebar]')).display")).toBe("contents");
  const moved = await scrollTo(old > 200 ? 40 : old + 300);
  expect(moved).not.toBe(old);
  await page.evaluate("window.__systemBack()"); // 选会话 → closingCollab 关视图
  await page.waitForFunction("document.body.dataset.open === ''");
  await js(page, "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
  expect(await scrollTop(page)).toBe(moved);
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);
