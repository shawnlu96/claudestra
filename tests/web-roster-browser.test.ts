/** ROSTER_SHOTS_DIR=<outside repo> bun test tests/web-roster-browser.test.ts; baseline web directory selects before screenshots only. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { rosterBundle, serveRoster } from "./helpers/roster-shots";
import { shotIssues } from "./helpers/ui-shot-checks";
const out = process.env.ROSTER_SHOTS_DIR;
const baseline = process.env.ROSTER_BASELINE_WEB;
const phase = baseline ? "before" : "after";
const localReads = /\/team\/(quota|activity)|\/peers\/contacts|\/team\/roster\?project=shared-ledger:/;

async function openTeam(page: Page, side: string, width: number, title: string) {
  await page.getByRole("progressbar", { name: title, exact: true }).first().waitFor({ timeout: 30_000 });
  const label = baseline && side === "team" ? "规划与提案" : "团队";
  await page.getByRole(width === 390 ? "button" : "tab", { name: label, exact: true }).first().click();
}
async function assertMembers(page: Page, status: number, width: number) {
  const cards = page.locator("[data-roster-member]");
  await page.waitForFunction("document.querySelectorAll('[data-roster-member]').length >= 3");
  expect(await page.locator("body").innerText()).not.toMatch(/[0-9a-f]{16,}/i);
  if (status === 403) {
    expect(await page.locator("[data-roster-metric='Claude 在用 / 总']").innerText()).toContain("暂无");
    expect(await page.locator("[data-roster-metric='机器在线']").getAttribute("title")).toBeTruthy();
    expect(await page.locator("[data-roster-member]").first().innerText()).toContain("未知");
    expect(await page.locator("[data-roster-member]").first().innerText()).not.toMatch(/0\//);
  }
  const boxes = await page.evaluate<{ x: number; y: number }[]>(`[...document.querySelectorAll('[data-roster-member]')].map(el =>
    ({ x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }))`);
  if (width === 390) expect(new Set(boxes.map(b => b.x)).size).toBe(1);
  else expect({ boxes, sameRow: boxes.slice(0, 3).every(b => b.y === boxes[0]?.y) }).toEqual({ boxes, sameRow: true });
  for (const b of await page.locator("[role=tablist][aria-label] button, [data-roster-member] button").all()) {
    const r = await b.boundingBox();
    if (r) expect(r.width >= 44 && r.height >= 44).toBe(true);
  }
}

async function capture(page: Page, dir: string, view: string, width: number, shots: unknown[], calls: string[], external: string[], errors: string[]) {
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(250);
  const ref = `${phase}-${view}-${width}.png`;
  const png = await page.screenshot({ path: resolve(dir, ref) });
  const issues = await shotIssues(page);
  shots.push({ phase, view, size: `${width}x900`, ref, sha256: createHash("sha256").update(png).digest("hex"), issues, calls: [...calls], external, errors });
  expect(external).toEqual([]); expect(errors).toEqual([]);
  if (!baseline) expect(issues).toEqual([]);
}

test.skipIf(!out)("ROSTER4 local/team, members/flow/ops and 403, 1280/390 light; request boundaries and clean screenshots", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = await rosterBundle(resolve(out, phase), baseline ? dirname(resolve(baseline)) : undefined);
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: unknown[] = [];
  try {
    for (const side of ["local", "team"]) for (const width of [1280, 390]) for (const status of [200, 403]) {
      const srv = serveRoster(home, team, bundle, status);
      const { page, ctx, calls, external, errors } = await guardedPage(browser, String(srv.server.url), { width });
      await page.emulateMedia({ reducedMotion: "reduce" });
      try {
        await page.goto(`${srv.server.url}?side=${side}&theme=light&project=${home.project}&team=${home.team}`);
        await openTeam(page, side, width, home.features[0]!.title);
        if (!baseline) {
          await page.getByRole("tab", { name: "成员", exact: true }).waitFor();
          // At 1280 the roster needs all three columns: use the existing outline collapse, no test-only layout override.
          const collapse = page.getByRole("button", { name: "收起大纲", exact: true });
          if (width === 1280 && await collapse.count()) await collapse.click();
          const right = page.getByRole("button", { name: "收起右栏", exact: true });
          if (width === 1280 && await right.count()) await right.click();
          await page.waitForTimeout(250);
          await assertMembers(page, status, width);
          const readCount = calls.filter(c => /\/team\/roster\?/.test(c)).length;
          await page.getByRole("tab", { name: side === "local" ? "往来" : "规划与提案", exact: true }).click();
          await page.getByRole("tab", { name: "成员", exact: true }).click();
          expect(calls.filter(c => /\/team\/roster\?/.test(c)).length).toBe(readCount);
          if (side === "team") expect(calls.filter(c => localReads.test(c))).toEqual([]);
          else expect(calls.some(c => /\/team\/activity\?project=/.test(c))).toBe(true);
        }
        await capture(page, out, `${side}-${status === 403 ? "unknown" : "members"}`, width, shots, calls, external, errors);
        if (status === 200) {
          const child = side === "local" ? "往来" : "规划与提案";
          if (!baseline) await page.getByRole("tab", { name: child, exact: true }).click();
          await capture(page, out, `${side}-${side === "local" ? "flow" : "ops"}`, width, shots, calls, external, errors);
        }
      } finally { await ctx.close(); srv.stop(); }
    }
  } finally {
    await browser.close();
    writeFileSync(resolve(out, `${phase}-manifest.json`), JSON.stringify({ shots }, null, 2) + "\n");
  }
}, 360_000);

test.skipIf(!out || !!baseline)("ROSTER4 two consumers share polling; hidden pages and non-full-scope never read seats; 403 stops until machine switch", async () => {
  if (!out || baseline) return;
  const { dualRosterBundle } = await import("./helpers/roster-shots");
  const bundle = await dualRosterBundle(resolve(out, "logic"));
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    for (const mode of ["full", "guest", "forbidden", "no-local"] as const) {
      const srv = serveRoster(home, team, bundle, mode === "forbidden" ? 403 : 200);
      const { page, ctx, calls, external } = await guardedPage(browser, String(srv.server.url));
      try {
        if (mode === "guest") await ctx.route("**/api/v1/peers/contacts", r => r.fulfill({ status: 403, json: {} }));
        const project = mode === "no-local" ? 'shared-ledger:' + JSON.stringify({ center: 'center', team: home.team, person: 'person-a', project: home.project, machine: 'elsewhere' })
          : home.project;
        await page.clock.install();
        await page.goto(`${srv.server.url}?project=${encodeURIComponent(project)}`);
        await page.waitForFunction("document.querySelectorAll('output').length === 2");
        await page.waitForTimeout(200);
        const count = () => calls.filter(c => /\/team\/roster\?/.test(c)).length;
        expect(count()).toBe(mode === "guest" || mode === "no-local" ? 0 : 1);
        await page.clock.fastForward(60_001);
        await page.waitForTimeout(100);
        expect(count()).toBe(mode === "full" ? 2 : mode === "forbidden" ? 1 : 0);
        await page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })");
        await page.clock.fastForward(120_001);
        await page.waitForTimeout(100);
        expect(count()).toBe(mode === "full" ? 2 : mode === "forbidden" ? 1 : 0);
        expect(external).toEqual([]);
      } finally { await ctx.close(); srv.stop(); }
    }
  } finally { await browser.close(); }
}, 90_000);
