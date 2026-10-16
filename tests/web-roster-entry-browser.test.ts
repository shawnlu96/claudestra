/**
 * team-roster-ROSTER8: sidebar team-header avatar stack → standalone team page (collab-nav view "team"), real Chromium against
 * team-view-harness.tsx (real sidebar, project groups and CollabSwitch) with synthetic relay machines; no production bridge or center.
 * ROSTER_ENTRY_SHOTS_DIR=<outside repo> keeps the screenshots + manifest (default: temp dir, removed afterwards).
 * ROSTER_ENTRY_BASELINE=<checkout of the base commit> builds the harness from there and only takes the "before" shots.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rosterEntryContext, rosterEntrySnapshot, rosterFixture } from "../web/features/collab/team/roster-fixture";
import { sharedCollabProject } from "../web/features/collab/team-source-key";
import { shotIssues } from "./helpers/ui-shot-checks";

const scratch = mkdtempSync(join(tmpdir(), "cstra-test-roster-entry-"));
const shots = process.env.ROSTER_ENTRY_SHOTS_DIR ? resolve(process.env.ROSTER_ENTRY_SHOTS_DIR) : join(scratch, "shots");
const baseline = process.env.ROSTER_ENTRY_BASELINE ? resolve(process.env.ROSTER_ENTRY_BASELINE) : null;
const phase = baseline ? "before" : "after";
const entry = "web/features/collab/team-view-harness.tsx";
const NOW = Date.UTC(2026, 9, 16, 4, 0);
const PROJECTS = { "mac-a": [{ id: "alpha-app", name: "Alpha app", emoji: "" }, { id: "beta-app", name: "Beta app", emoji: "" }],
  "mac-b": [{ id: "other-app", name: "Other app", emoji: "" }] };
type Fp = keyof typeof PROJECTS;
const centerKey = (project: string) => sharedCollabProject({ machine: "mac-a", center: "center", team: "team-alpha", project,
  person: "person-a", homeInstanceId: "instance-local" });
const manifest: unknown[] = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let log: string[] = [];

function api(fp: Fp, req: Request, path: string, query: URLSearchParams): Response {
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  log.push(`${fp} ${path}${query.size ? `?${query}` : ""}`);
  if (fp !== "mac-a") return path === "/shared-ledger/context" ? json({ identities: [] }) : json({ error: "not in fixture" }, 404);
  if (path === "/shared-ledger/context") return json(rosterEntryContext());
  if (path === "/shared-projects/snapshot") {
    const snapshot = rosterEntrySnapshot(req.headers.get("x-shared-ledger-project") ?? "");
    return snapshot ? json(snapshot) : json({ error: "no binding" }, 403);
  }
  if (path === "/team/roster") return json(rosterFixture(NOW, query.get("project") ?? ""));
  if (path === "/peers/contacts") return json({ contacts: [] });
  if (path === "/team/quota") return json({ providers: [] });
  if (path === "/team/activity") return json({ now: NOW, interactions: [], truncated: false });
  return json({ ok: false, error: "not in fixture" }, 404);
}

async function css(root: string) {
  const req = createRequire(resolve(root, "web/package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = resolve(root, "web/app/globals.css");
  return (await postcss([tw({ base: resolve(root, "web") })]).process(readFileSync(from, "utf8"), { from })).css;
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true, mode: 0o700 });
  const root = baseline ?? process.cwd();
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", scratch, "--tsconfig-override", "web/tsconfig.json"],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const style = await css(root);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/team-view-harness.js" || path === "/team-view-harness.css") {
      const file = join(scratch, path.slice(1));
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("", { headers: { "Content-Type": "text/css" } });
    }
    if (path === "/style.css") return new Response(style, { headers: { "Content-Type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "relay", relayBase: url.origin, version: "" });
    const m = path.match(/^\/m\/(mac-a|mac-b)\/api\/v1(\/[^?]*)$/);
    if (m) return api(m[1] as Fp, request, decodeURIComponent(m[2]!), url.searchParams);
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/team-view-harness.css"></head>
      <body><div id="root"></div><script src="/team-view-harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);

afterAll(async () => {
  try {
    if (manifest.length) writeFileSync(join(shots, `${phase}-manifest.json`), JSON.stringify({ phase, specRev: 1,
      fixture: "two synthetic relay machines; mac-a binds team-alpha (alpha-app, beta-app) and sees team-beta without a local binding; no production data",
      fixtureSha256: createHash("sha256").update(readFileSync("web/features/collab/team/roster-fixture.ts")).digest("hex"), shots: manifest }, null, 2) + "\n");
  } finally {
    await browser?.close();
    server?.stop(true);
    if (!process.env.ROSTER_ENTRY_SHOTS_DIR) rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

async function open(width: number) {
  log = [];
  const page = await browser.newPage({ viewport: { width, height: width < 640 ? 844 : 900 }, locale: "zh-CN", colorScheme: "light" });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => { external.push(r.request().url()); return r.abort(); });
  await page.clock.install({ time: NOW });
  await page.goto(`${server.url}?${new URLSearchParams({ machine: "mac-a", theme: "light", projects: JSON.stringify(PROJECTS) })}`);
  // Both commits render the team header once the snapshot lands; only the after commit has the avatar stacks in it.
  await page.getByRole("button", { name: "项目设置", exact: true }).and(page.locator(":enabled")).waitFor({ timeout: 20_000 });
  return { page, errors, external };
}
async function shot(page: Page, name: string, width: number, external: string[], errors: string[]) {
  await page.evaluate("document.fonts.ready");
  const file = `${phase}-${name}-${width}.png`;
  const png = await page.screenshot({ path: join(shots, file), animations: "disabled" });
  const issues = await shotIssues(page);
  manifest.push({ file, size: `${width}`, sha256: createHash("sha256").update(png).digest("hex"), issues, external: [...external] });
  expect({ file, issues, external, errors }).toEqual({ file, issues: [], external: [], errors: [] });
}
const opened = (page: Page) => page.evaluate("document.body.dataset.open ?? ''") as Promise<string>;
const teamPage = (page: Page) => page.locator("[data-collab-view='team']");
const stack = (page: Page, team: string) => page.locator(`[data-team-entry='${team}']`);
const reads = (project: string) => log.filter((l) => l === `mac-a /team/roster?project=${project}`).length;
async function until(ok: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(50);
  }
}
/** Distinct /api paths plus the snapshot read count, compared between the base and this commit after the same settle time. */
const apiSummary = () => ({ paths: [...new Set(log.map((l) => l.replace(/\?.*$/, "")))].sort(),
  snapshots: log.filter((l) => l.endsWith("/shared-projects/snapshot")).length });

test.skipIf(!baseline)("before: sidebar team area on the base commit, 1280 / 390", async () => {
  for (const width of [1280, 390]) {
    const { page, errors, external } = await open(width);
    try {
      await page.clock.runFor(2_000);
      writeFileSync(join(shots, `before-api-${width}.json`), JSON.stringify(apiSummary(), null, 2) + "\n");
      await shot(page, "sidebar", width, external, errors);
    } finally { await page.close(); }
  }
}, 120_000);

test.skipIf(!!baseline)("entry adds no request; stack opens the team page; back, open-in-collab and machine switch close it", async () => {
  for (const width of [1280, 390]) {
    const { page, errors, external } = await open(width);
    try {
      const alpha = stack(page, "team-alpha"), beta = stack(page, "team-beta");
      await alpha.waitFor();
      await page.clock.runFor(2_000);
      // [1] Nothing beyond the panel's own reads: no roster read; with a baseline run, the same paths and snapshot reads as the base commit.
      expect(log.filter((l) => l.includes("/team/roster"))).toEqual([]);
      const before = join(shots, `before-api-${width}.json`);
      if (existsSync(before)) expect(apiSummary()).toEqual(JSON.parse(readFileSync(before, "utf8")));
      // [4] [5] Avatars come from the directory; the unbound team is disabled with a reason.
      expect(await alpha.getAttribute("aria-label")).toBe("团队成员（3）");
      expect(await alpha.getAttribute("title")).toBe("Alpha、Beta、Gamma");
      expect(await alpha.innerText()).toMatch(/^A\s*B\s*G$/);
      expect(await beta.isDisabled()).toBe(true);
      expect(await beta.getAttribute("title")).toBe("这个团队还没有绑定本机项目");
      expect(await beta.innerText()).toContain("+2");
      if (width === 390) for (const b of [alpha, beta]) {
        const box = (await b.boundingBox())!;
        expect(box.width >= 44 && box.height >= 44).toBe(true);
      }
      await shot(page, "sidebar", width, external, errors);
      await beta.click({ force: true });
      expect(await opened(page)).toBe("");

      // [2] Open the team page for the team's first bound project.
      await alpha.click();
      await teamPage(page).waitFor();
      expect(await opened(page)).toBe("alpha-app");
      await page.locator("[data-roster-member]").first().waitFor();
      expect(reads("alpha-app")).toBe(1);
      const text = await teamPage(page).innerText();
      expect(text).toContain("Fixture team");
      expect(text).not.toMatch(/[0-9a-f]{16,}|\p{Extended_Pictographic}/u);
      expect(await page.evaluate<boolean>("(() => { const el = document.querySelector(\"[data-collab-view='team']\"); return el.scrollWidth <= el.clientWidth; })()")).toBe(true);
      await shot(page, "team-page", width, external, errors);

      // [3] The dropdown lists only this team's bound projects; switching moves the roster read and stops the old poll.
      const select = teamPage(page).getByRole("combobox", { name: "项目" });
      expect(await select.locator("option").allInnerTexts()).toEqual(["Alpha app", "Beta app"]);
      await select.selectOption("beta-app");
      await page.waitForFunction("document.body.dataset.open === 'beta-app'");
      await page.locator("[data-roster-member]").first().waitFor();
      const old = reads("alpha-app");
      await page.clock.runFor(61_000);
      // runFor only fires the poll timer; the request reaches the fake server a moment later (real time).
      await until(() => reads("beta-app") === 2, "second beta-app roster read");
      expect(reads("alpha-app")).toBe(old);
      await shot(page, "team-page-switched", width, external, errors);

      // [2] Open in collab view: same project, center key, view back to null.
      await teamPage(page).getByRole("button", { name: "在协作视图打开" }).click();
      await page.waitForFunction(`document.body.dataset.open === ${JSON.stringify(centerKey("beta-app"))}`);
      expect(await teamPage(page).count()).toBe(0);

      // Back from the team page returns to the chat (overlay closed).
      await alpha.evaluate((el) => (el as unknown as { click(): void }).click());
      await teamPage(page).waitFor();
      await teamPage(page).getByRole("button", { name: "返回" }).click();
      await page.waitForFunction("document.body.dataset.open === ''");
      expect(await teamPage(page).count()).toBe(0);
      if (width === 390) await shot(page, "back-to-sidebar", width, external, errors);

      // Switching machines closes the team page like the collab view.
      await alpha.evaluate((el) => (el as unknown as { click(): void }).click());
      await teamPage(page).waitFor();
      await page.locator("[data-machine='mac-b']").evaluate((el) => (el as unknown as { click(): void }).click());
      await page.waitForFunction("document.body.dataset.open === ''");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 180_000);
