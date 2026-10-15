/**
 * ROSTERLOAD1 cold-open roster (opt-in, real Chromium):
 *   ROSTER_LOAD_BROWSER=1 bun test tests/web-roster-load-browser.test.ts
 * The fixture delays the app config, the full-scope probe and the binding context separately, fails the first reads,
 * and holds the seat read back, so the cold path the old hook hid behind instant fixtures is exercised.
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { dualRosterBundle, serveRoster, type RosterServeOpts } from "./helpers/roster-shots";

const enabled = process.env.ROSTER_LOAD_BROWSER === "1";
const CENTER = "center-roster-project";
const rosterReads = (calls: string[]) => calls.filter(c => /\/team\/roster\?/.test(c));

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(25);
  return check();
}
/** Every text the roster showed before `stop`, so a loading frame that claims "no directory" cannot slip between samples. */
const WATCH = `window.__texts = new Set();
  new MutationObserver(() => window.__texts.add(document.body.innerText)).observe(document, { subtree: true, childList: true, characterData: true });`;

async function open(browser: Browser, query: Record<string, string>, opts: RosterServeOpts, clock = false) {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const bundle = await dualRosterBundle(mkdtempSync(resolve(tmpdir(), "roster-load-")));
  const srv = serveRoster(home, team, bundle, 200, opts);
  const g = await guardedPage(browser, String(srv.server.url));
  await g.page.addInitScript(WATCH);
  if (clock) await g.page.clock.install();
  const project = query.project === "shared" ? "shared-ledger:" + JSON.stringify({ center: "center", team: home.team, person: "person-a", project: CENTER, machine: "local" })
    : home.project;
  const started = Date.now();
  await g.page.goto(`${srv.server.url}?${new URLSearchParams({ ...query, project })}`);
  return { ...g, home, started, close: async () => { await g.ctx.close(); srv.stop(); } };
}
const texts = (page: Page) => page.evaluate<string[]>("[...window.__texts]");

test.skipIf(!enabled)("[1] cold team key: fp, permission and binding arrive late; the first seat read follows at once on the local project", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    const p = await open(browser, { project: "shared" }, { delay: { config: 700, contacts: 1200, context: 1800 }, centerProject: CENTER });
    try {
      expect(await until(() => rosterReads(p.calls).length > 0, 8_000)).toBe(true);
      const elapsed = Date.now() - p.started;
      await Bun.sleep(500);
      expect({ reads: rosterReads(p.calls), fast: elapsed < 8_000 }).toEqual({ reads: [`GET /api/v1/team/roster?project=${p.home.project}`], fast: true });
      expect(p.external).toEqual([]);
    } finally { await p.close(); }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!enabled)("[2] directory first, seats late: members group at once, seats show loading, never 'no directory' or unclaimed", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    const p = await open(browser, { view: "roster" }, { delay: { roster: 4_000, snapshot: 300 } });
    try {
      await p.page.waitForFunction("document.querySelectorAll('[data-roster-member]').length === 3", undefined, { timeout: 3_000 });
      expect(await p.page.locator("[data-roster-state='seats-loading']").count()).toBe(1);
      expect(rosterReads(p.calls).length).toBe(1);
      const before = await texts(p.page);
      expect(before.filter(t => /没有团队目录|未认领的机器|没有名册数据/.test(t))).toEqual([]);
      expect(before.some(t => t.includes("正在读取团队目录"))).toBe(true);
      await p.page.waitForFunction("document.querySelectorAll('[data-roster-machine]').length === 3", undefined, { timeout: 8_000 });
      expect(await p.page.locator("[data-roster-state='seats-loading']").count()).toBe(0);
    } finally { await p.close(); }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!enabled)("[2] directory read failure says so instead of 'no team directory'", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    const p = await open(browser, { view: "roster" }, { fail: { snapshot: 99 } });
    try {
      await p.page.waitForFunction("document.body.innerText.includes('团队目录读取失败')", undefined, { timeout: 5_000 });
      expect((await texts(p.page)).filter(t => /没有团队目录|未认领的机器/.test(t))).toEqual([]);
    } finally { await p.close(); }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!enabled)("[3] failed first reads retry within 10s at most three times, then fall back to the 60s poll; [4] hidden pauses, visible catches up", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    const p = await open(browser, {}, { fail: { roster: 4 } }, true);
    const reads = () => rosterReads(p.calls).length;
    const settle = () => p.page.waitForTimeout(300);
    try {
      expect(await until(() => reads() === 1, 5_000)).toBe(true);
      await settle();
      for (const n of [2, 3, 4]) {
        await p.page.clock.fastForward(10_000);
        expect(await until(() => reads() === n, 3_000)).toBe(true);
        await settle();
      }
      await p.page.clock.fastForward(40_000);
      await settle();
      expect(reads()).toBe(4);
      await p.page.clock.fastForward(20_001);
      expect(await until(() => reads() === 5, 3_000)).toBe(true);
      await settle();
      await p.page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })");
      await p.page.clock.fastForward(120_001);
      await settle();
      expect(reads()).toBe(5);
      await p.page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'))");
      expect(await until(() => reads() === 6, 3_000)).toBe(true);
      expect(p.external).toEqual([]);
    } finally { await p.close(); }
  } finally { await browser.close(); }
}, 90_000);
