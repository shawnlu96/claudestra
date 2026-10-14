/** SUBDAG8 opt-in mobile screenshots and behavior: SUBDAG_SHOTS_DIR=<artifact-dir> bun test <this-file>.
 * SUBDAG_BASELINE_WEB points at the unchanged main web tree for the paired before run.
 * The real CollabView and subdag-fixture exercise both local and team sources; guardedPage denies external traffic.
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";
import { serveSubdag, MAIN_NOW, MAIN_TITLE, DONE_TITLE, SUBDAG_PROJECT, SUBDAG_TEAM } from "./helpers/subdag-fixture";

const destination = process.env.SUBDAG_SHOTS_DIR;
const sourceWeb = process.env.SUBDAG_BASELINE_WEB ?? "web";
const phase = process.env.SUBDAG_BASELINE_WEB ? "before" : "after";
const board = "document.querySelector('[data-focus-board]')";
const anchors = "document.querySelector('[data-focus-anchors]')";
const flash = (key: string) => `[...document.querySelectorAll('[data-focus-key="${key}"]')].some(e => [...e.classList].some(c => /flash/.test(c)))`;
const doneVisible = `(() => { const h = ${board}?.querySelector('[data-section=done] h3'); if (!h) return false;
  const r = h.getBoundingClientRect(), a = ${anchors}.getBoundingClientRect(); return r.top >= a.bottom - 1 && r.bottom < innerHeight; })()`;
const dimensions = `(() => { const b = ${board}; return [...b.querySelectorAll('button,[role=button],[data-state]')].filter(e => e.getClientRects().length)
  .map(e => ({ text: e.innerText, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })); })()`;
const overflow = "document.scrollingElement.scrollWidth > innerWidth";
interface Shot { view: string; size: string; phase: "before" | "after"; ref: string; sha256: string }

async function paint(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(550);
}

async function feature(page: Page, title: string) {
  await page.getByRole("tab", { name: "产品 DAG", exact: true }).first().click();
  const target = page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first();
  if (!await target.isVisible()) await page.locator("button[aria-expanded=false]").filter({ hasText: "已完成" }).first().click();
  await target.click();
  await page.waitForFunction("!!document.querySelector('[data-focus-board],[class*=mnode],[class*=mdone]')");
  await paint(page);
}

async function touchChecks(page: Page) {
  const sizes = await page.evaluate(dimensions) as { text: string; width: number; height: number }[];
  expect(sizes.filter(s => s.width < 44 || s.height < 44)).toEqual([]);
  expect(await page.evaluate(overflow) as boolean).toBe(false);
  return sizes;
}

async function mobileChecks(page: Page) {
  const initial = await page.evaluate(`(() => { const b = ${board}, a = ${anchors};
    return { first: b.querySelector('[data-state]').dataset.focusKey, nav: a.innerText, bar: b.querySelector('[class*=bar]').getBoundingClientRect().top,
      navTop: a.getBoundingClientRect().top, cardTop: b.querySelector('[data-state]').getBoundingClientRect().top,
      digits: [...b.querySelectorAll('button')].filter(e => /^[✓\\s]*\\d+$/.test(e.innerText.trim())).map(e => e.innerText) }; })()`) as {
    first: string; nav: string; bar: number; navTop: number; cardTop: number; digits: string[];
  };
  expect(initial.first).toBe("a-owner");
  expect(initial.nav).toMatch(/进行中 8[\s\S]*接下来 16[\s\S]*已完成 30/);
  expect(initial.bar).toBeLessThan(initial.navTop);
  expect(initial.navTop).toBeLessThan(initial.cardTop);
  expect(initial.cardTop).toBeLessThan(900);
  expect(initial.digits).toEqual([]);
  expect(await page.getByRole("button", { name: "列表", exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "图", exact: true }).count()).toBe(0);
  const sizes = await touchChecks(page);
  await page.evaluate(`${board}.scrollTop = 1000`);
  await paint(page);
  const sticky = await page.evaluate(`${anchors}.getBoundingClientRect().top - ${board}.getBoundingClientRect().top`) as number;
  expect(Math.abs(sticky)).toBeLessThanOrEqual(1);
  await page.locator("[data-focus-anchors]").getByRole("button", { name: "已完成 30", exact: true }).click();
  await page.waitForFunction(doneVisible);
  await paint(page);
  await page.waitForFunction(`${anchors}.querySelector('button:last-child').getAttribute('aria-pressed') === 'true'`);
  // Both smooth and immediate jumps must change the highlight, including the last collapsed section.
  for (const motion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    for (const label of ["进行中 8", "接下来 16", "已完成 30", "接下来 16", "已完成 30"]) {
      await page.locator("[data-focus-anchors]").getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction(`!![...${anchors}.querySelectorAll('button')].find(e => e.innerText === ${JSON.stringify(label)} && e.ariaPressed === 'true')`);
    }
  }
  return { initial, sizes, sticky };
}

async function detailShot(page: Page, after: boolean, shoot: (page: Page, view: string, width: number) => Promise<void>) {
  const target = after ? page.locator('[data-focus-key="a-w2"] button').first()
    : page.getByRole("button").filter({ hasText: "a-w2" }).first();
  await target.scrollIntoViewIfNeeded();
  await paint(page);
  const pos = after ? await page.evaluate(`${board}.scrollTop`) as number : null;
  await target.click();
  await page.locator("aside button[aria-label='关闭']").waitFor();
  await paint(page);
  await shoot(page, "local-detail", 390);
  await page.locator("aside button[aria-label='关闭']").click();
  await page.locator("aside button[aria-label='关闭']").waitFor({ state: "hidden" });
  if (after) expect(Math.abs((await page.evaluate(`${board}.scrollTop`) as number) - pos!)).toBeLessThanOrEqual(2);
}

function mobileFixture(bundle: string) {
  let fallback = false;
  const fixture = serveSubdag(bundle, { extra(path) {
    if (path.startsWith("/api/v1/usage/task/")) return Response.json({ ok: false });
    if (fallback && path.endsWith("/product")) return Response.json({ error: "unsupported" }, { status: 404 });
    const taskId = path.match(/\/tasks\/(.+)$/)?.[1];
    if (taskId) {
      const task = fixture.fx.local.ov.tasks.find(t => t.id === taskId) ?? fixture.fx.local.ov.tasks[0]!;
      return Response.json({ ok: true, task: { ...task, id: taskId }, events: [], timeline: [], now: MAIN_NOW });
    }
    return null;
  } });
  return { ...fixture, legacy: () => { fallback = true; } };
}

test.skipIf(!destination)("SUBDAG8: 390 shared FocusBoard, sticky anchors, touch targets, detail and fallback parity", async () => {
  if (!destination) return;
  mkdirSync(destination, { recursive: true });
  const bundle = resolve(destination, `${phase}-mobile-bundle`);
  const compiler = Bun.spawn([process.execPath, "build", `${sourceWeb}/features/collab/shared/fixture-harness.tsx`,
    "--tsconfig-override", `${sourceWeb}/tsconfig.json`, "--target=browser", `--outdir=${bundle}`], { stdout: "pipe", stderr: "pipe" });
  const compilerError = await new Response(compiler.stderr).text();
  expect(await compiler.exited, compilerError).toBe(0);
  const fixture = mobileFixture(bundle);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: Shot[] = [], texts: Record<string, string> = {}, issues: Record<string, unknown> = {}, checks: Record<string, unknown> = {};
  const external: string[] = [], errors: string[] = [];
  const after = phase === "after";
  const shoot = async (page: Page, view: string, width: number) => {
    await paint(page);
    const ref = `${phase}-${view}-${width}.png`;
    const bytes = await page.screenshot({ path: resolve(destination, ref) });
    shots.push({ view, size: `${width}x900`, phase, ref, sha256: createHash("sha256").update(bytes).digest("hex") });
    texts[`${view}-${width}`] = await page.locator("body").innerText();
    issues[`${view}-${width}`] = await shotIssues(page);
  };
  const open = async (side: string, width: number) => {
    const session = await guardedPage(browser, String(fixture.server.url), { width, theme: "light" });
    await session.page.clock.setFixedTime(MAIN_NOW);
    await session.page.goto(`${fixture.server.url}?side=${side}&project=${SUBDAG_PROJECT}&team=${SUBDAG_TEAM}`);
    return session;
  };
  const finish = async (g: Awaited<ReturnType<typeof open>>) => {
    external.push(...g.external); errors.push(...g.errors);
    await g.ctx.close();
  };
  try {
    const local = await open("local", 390), page = local.page;
    await feature(page, MAIN_TITLE);
    await shoot(page, "local-main", 390);
    if (after) checks.mobile = await mobileChecks(page);
    if (after) {
      await page.locator("[data-focus-anchors]").getByRole("button", { name: "接下来 16", exact: true }).click();
      await page.waitForFunction(`${anchors}.querySelector('button:nth-child(2)').getAttribute('aria-pressed') === 'true'`);
    } else await page.getByRole("button").filter({ hasText: "n1" }).first().scrollIntoViewIfNeeded();
    await shoot(page, "local-next", 390);
    await detailShot(page, after, shoot);
    if (after) {
      // Chip expands completed rows before scrolling and flashes the target once.
      await page.locator('[data-focus-key="a-owner"]').getByRole("button", { name: "d30", exact: true }).click();
      await page.waitForFunction(flash("d30"));
      await page.getByRole("tab", { name: "谁在干活", exact: true }).click();
      await page.locator("[data-work-board] section button").filter({ hasText: "T-a-w2" }).first().click();
      await page.waitForFunction(flash("a-w2"));
      await page.waitForFunction(`(() => { const r = ${board}.querySelector('[data-focus-key="a-w2"]').getBoundingClientRect();
        return r.top >= ${anchors}.getBoundingClientRect().bottom && r.bottom <= innerHeight; })()`);

      await page.waitForTimeout(1800);
      await page.getByRole("tab", { name: "谁在干活", exact: true }).click();
      await page.getByRole("tab", { name: "产品 DAG", exact: true }).click();
      await paint(page);
      expect(await page.evaluate(flash("a-w2")) as boolean).toBe(false);
      checks.jumpAndChip = true;
    }
    await feature(page, DONE_TITLE);
    await shoot(page, "local-done", 390);
    if (after) {
      checks.doneSizes = await touchChecks(page);
      expect(await page.locator("[data-section=done] [data-focus-key]").count()).toBe(12);
    }
    await finish(local);
    const team = await open("team", 390);
    await feature(team.page, MAIN_TITLE);
    await shoot(team.page, "team-main", 390);
    if (after) checks.teamSizes = await touchChecks(team.page);
    await finish(team);
    for (const side of ["local", "team"]) {
      const desktop = await open(side, 1280);
      await feature(desktop.page, MAIN_TITLE);
      await shoot(desktop.page, `${side}-main`, 1280);
      await finish(desktop);
    }
    fixture.legacy();
    const legacy = await open("local", 390);
    await legacy.page.getByRole("tab", { name: "子 DAG", exact: true }).waitFor();
    await paint(legacy.page);
    texts.fallback = await legacy.page.locator("body").innerText();
    expect(await legacy.page.locator("[data-focus-board]").count()).toBe(0);
    await finish(legacy);
  } finally {
    await browser.close();
    fixture.server.stop(true);
  }
  writeFileSync(resolve(destination, `${phase}-mobile-manifest.json`), JSON.stringify({ shots, texts, checks, issues, external, errors, unexpected: fixture.unexpected }, null, 2));
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  if (!after) return;
  for (const [view, found] of Object.entries(issues)) expect({ view, found }).toEqual({ view, found: [] });
  const beforePath = resolve(destination, "before-mobile-manifest.json");
  if (existsSync(beforePath)) {
    const baseline = JSON.parse(readFileSync(beforePath, "utf8")) as { texts: Record<string, string> };
    for (const key of ["local-main-1280", "team-main-1280", "fallback"]) expect({ key, text: texts[key] }).toEqual({ key, text: baseline.texts[key] });
  }
}, 240_000);
