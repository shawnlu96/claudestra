/** Opt-in fixture screenshots: UXCARD2_SHOTS_DIR, optionally UXCARD2_BASELINE_WEB for the main baseline. Only synthetic, loopback data. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome, type TeamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";

const out = process.env.UXCARD2_SHOTS_DIR;
const baseWeb = process.env.UXCARD2_BASELINE_WEB;
const phase = baseWeb ? "before" : "after";
const FIX = "i28-A5", REVIEW = "i28-A4", MERGE = "i28-A3", AWAY = "i28-A6";
const views = [{ id: FIX, name: "fix" }, { id: REVIEW, name: "paused-review" }, { id: MERGE, name: "merge" },
  { id: AWAY, name: "away-build" }, { id: FIX, name: "observe-fix" }];
const labels = ["fix 未暂停", "review 已暂停", "merge", "别的机器 build（团队源）", "observe 档 fix"];
const summary = { families: { claude: { totalTokens: 17_500_000 }, codex: { totalTokens: 14_000_000 } }, totalTokens: 31_500_000,
  hasArchive: true, detailFrom: "2026-10-01", unavailableBefore: null, lent: { claude: { orders: 2, tokensReported: false } },
  weekEstimate: { claude: { estimatePct: 3 }, codex: { estimatePct: 2 } } };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function fixtureRoutes(page: Page, home: HomeFixture, team: TeamFromHome, away: boolean, observe: boolean) {
  const json = (v: unknown) => ({ json: v });
  const local = home.sourceInstanceId;
  const remote = "peer-fixture";
  const identity = { center: "center", team: home.team, person: "person-a", project: home.project, machine: "local", homeInstanceId: local };
  await page.route(/\/api\/v1\/shared-ledger\/context(\?.*)?$/, (r) => r.fulfill(json({ identities: [{ ...identity, localProjectId: home.project }] })));
  await page.route(/\/api\/v1\/shared-projects\/snapshot(\?.*)?$/, (r) => r.fulfill(json({ v: 1,
    identity: { subject: "owner:self", kind: "person", centerId: "center", teamId: home.team, personId: "person-a", instanceId: local },
    teamRole: { available: true, value: "member" }, capabilities: { invite: { available: false }, leave: { available: false } },
    projects: [], localProjects: [], peers: [{ name: "alice-mac", instanceId: remote, enabled: true, invitable: true }] })));
  if (away) {
    const copy = structuredClone(team);
    for (const feature of copy.list.features) feature.homeInstanceId = remote;
    for (const d of copy.details) { d.feature.homeInstanceId = remote; for (const task of d.tasks) task.executorInstanceId = remote; }
    await page.route(/\/api\/v1\/shared-ledger\/features(\?.*)?$/, (r) => r.fulfill(json(copy.list)));
    await page.route(/\/api\/v1\/shared-ledger\/features\/[^/?]+(\?.*)?$/, (r) => {
      const id = new URL(r.request().url()).pathname.split("/").at(-1);
      return r.fulfill(json(copy.details.find((d) => d.feature.id === id)));
    });
  }
  await page.route(/\/api\/v1\/ledger\/[^/]+\/tasks\/[^/]+\/pause$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").at(-2)!;
    const paused = id === REVIEW;
    return r.fulfill(json({ mode: observe ? "observe" : "on", paused, actor: paused ? "owner" : null,
      at: paused ? home.now - 10 * 60_000 : null, reason: paused ? "先核规格再继续" : null,
      stage: home.details[id]!.task.stage, canPause: !paused, refusal: paused ? "已暂停" : null }));
  });
  await page.route(/\/api\/v1\/usage\/task\/[^/]+$/, (r) => r.fulfill(json({ ok: true, summary })));
}

async function openCard(page: Page, home: HomeFixture, id: string, narrow: boolean) {
  const task = home.details[id]!.task;
  if (narrow) {
    const feature = home.features.find((f) => f.id === task.itemId)!;
    await page.getByRole("button").filter({ has: page.getByText(feature.title, { exact: true }) }).first().click();
  }
  await page.getByText(task.title, { exact: true }).first().click();
  await page.locator('aside [data-now="who"]').waitFor();
  await page.waitForTimeout(400);
  await page.evaluate("document.fonts.ready");
}

interface SharpResult { composite(layers: { input: Buffer; top: number; left: number }[]): SharpResult; png(): SharpResult; toBuffer(): Promise<Buffer> }

test.skipIf(!out)("UXCARD2 local/team detail fixture matrix with screenshots and no external traffic", async () => {
  if (!out) return;
  const sharp = createRequire(new URL("../web/package.json", import.meta.url))("sharp") as
    (input: { create: { width: number; height: number; channels: number; background: string } }) => SharpResult;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`), root = baseWeb ?? "web";
  const build = Bun.spawn([process.execPath, "build", `${root}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${root}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  const code = await build.exited;
  if (code) throw new Error(await new Response(build.stderr).text());
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const { server } = serve(home, team, bundle);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const shots: { view: string; size: string; phase: string; ref: string; sha256: string }[] = [];
  const records: { ref: string; sourceSide: string; text: string; issues: unknown[]; external: string[]; errors: string[]; calls: string[] }[] = [];
  try {
    for (const width of [1280, 390]) for (const side of ["local", "team"] as const) {
      const height = width === 390 ? 1400 : 2600;
      const images: Buffer[] = [];
      for (const view of views) {
        // Away-home cards are only represented by the team source; both evidence matrices show the genuine shared detail for that state.
        const sourceSide = view.name === "away-build" ? "team" : side;
        const g = await guardedPage(browser, server.url.href, { width });
        await g.page.setViewportSize({ width, height });
        await g.page.clock.setFixedTime(home.now);
        await fixtureRoutes(g.page, home, team, view.name === "away-build", view.name === "observe-fix");
        await g.page.goto(`${server.url}?side=${sourceSide}&loadAgents=1&theme=light&project=${home.project}&team=${home.team}&homeInstanceId=${home.sourceInstanceId}`);
        await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
        await openCard(g.page, home, view.id, width < 640);
        const panel = g.page.locator("aside").filter({ hasText: view.id }).first();
        if (!baseWeb) {
          await panel.locator('[data-detail-usage="section"]').waitFor();
          if (view.name === "paused-review") await expectText(panel.locator('[data-now="who"]'), "已暂停 · owner 10分前 暂停 · 先核规格再继续");
          const canPause = view.name === "fix" || view.name === "paused-review";
          expect(await panel.locator("[data-card-pause]").count()).toBe(canPause ? 1 : 0);
          if (view.name === "away-build") {
            await expectText(panel.locator('[data-detail-usage="section"]'), "这张卡在 alice-mac 上执行，用量记在那台机器");
            expect(g.calls.some((c) => c.includes("/usage/task/"))).toBe(false);
            expect(g.calls.some((c) => /\/tasks\/[^/]+\/pause/.test(c))).toBe(false);
          } else await expectText(panel.locator('[data-detail-usage="section"]'), "Claude 约 1,750 万 token · 约占本周额度 3%");
        }
        const ref = `${phase}-${side}-${view.name}-${width}.png`;
        const bytes = await g.page.screenshot({ path: resolve(out, ref) });
        images.push(bytes);
        const issues = await shotIssues(g.page);
        records.push({ ref, sourceSide, text: await panel.innerText(), issues, external: g.external, errors: g.errors, calls: g.calls });
        expect(issues).toEqual([]); expect(g.external).toEqual([]); expect(g.errors).toEqual([]);
        await g.ctx.close();
      }
      const ref = `${phase}-${side}-${width}-matrix.png`;
      const rowHeight = height + 56;
      const layers = images.flatMap((input, i) => {
        const svg = `<svg width="${width}" height="56"><rect width="100%" height="100%" fill="#f1f5f9"/>` +
          `<text x="16" y="35" font-size="20" font-family="sans-serif" fill="#0f172a">${labels[i]}</text></svg>`;
        return [{ input: Buffer.from(svg), top: i * rowHeight, left: 0 }, { input, top: i * rowHeight + 56, left: 0 }];
      });
      const png = await sharp({ create: { width, height: rowHeight * images.length, channels: 3, background: "#ffffff" } })
        .composite(layers).png().toBuffer();
      writeFileSync(resolve(out, ref), png);
      shots.push({ view: `${side}-matrix`, size: `${width}x${rowHeight * images.length}`, phase, ref, sha256: sha(png) });
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${phase}-shots.json`), JSON.stringify({ shots, records }, null, 2));
}, 240_000);

async function expectText(locator: ReturnType<Page["locator"]>, text: string) {
  await locator.filter({ hasText: text }).first().waitFor();
  expect(await locator.innerText()).toContain(text);
}
