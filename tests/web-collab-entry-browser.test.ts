/**
 * team-project-UXENTRY1：侧栏「协作视图」行和团队区——探测中先占同高的位、读失败出灰行 + 重试，403 / 404 / 501 照旧不出。
 * 真 Chromium + team-view-harness 夹具（起法同 tests/web-collab-sidebar-browser.test.ts），中继模式 /m/mac-a/api/v1/*，数据全部合成：
 * 两个本机项目（未绑定团队，各自探本机台账）：甲先等 2.5 秒再回 200；乙先回两次 503（第一次也晚 2.5 秒）再回 200。
 * 团队快照：第一次晚 3 秒、回 500，之后回 200。只许回环请求，其余拦掉并断言为 0。
 * 截图（opt-in）：COLLAB_ENTRY_SHOTS_DIR=<仓库外目录>；再带 COLLAB_ENTRY_BASE_REPO=<基线 checkout> 同一流程拍改前（改前只拍图、不断言）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const OUT = process.env.COLLAB_ENTRY_SHOTS_DIR ? resolve(process.env.COLLAB_ENTRY_SHOTS_DIR) : null;
const BASE = process.env.COLLAB_ENTRY_BASE_REPO ? resolve(process.env.COLLAB_ENTRY_BASE_REPO) : null;
const work = mkdtempSync(join(tmpdir(), "cstra-test-collab-entry-"));
const shotsDir = OUT ?? join(work, "shots");
const ENTRY = "web/features/collab/team-view-harness.tsx";
const NOW = Date.UTC(2026, 9, 8, 4, 0);
const SLOW_LEDGER_MS = 2_500, SLOW_TEAM_MS = 3_000;
const A = { id: "alpha-app", name: "本机项目甲", emoji: "📦" }, B = { id: "beta-app", name: "本机项目乙", emoji: "📦" };
const PROJECTS = { "mac-a": [A, B] };
const ledger = generateTeamFixture({ seed: 3, features: 1, nodes: 5, now: NOW }).local;

// ---- 团队区：一条绑定到侧栏里没成组的本机项目（团队区出一行） ----
const f = createV2ProjectsFixtures();
const identity = { center: f.identity.centerId, team: f.identity.teamId, person: f.person.personId, project: f.identity.projectId,
  localProjectId: "team-local", homeInstanceId: "instance-a" };
const ports = (): SharedProjectsPorts => ({ person: async () => ({ ...f.person, ...f.requests.list, personId: identity.person, instanceId: "instance-a",
  subject: "owner:self" as const }), list: async () => [{ ...f.project, projectId: identity.project, code: identity.project, name: "团队项目丙" }],
members: async () => [{ ...f.member, personId: identity.person, role: "owner" }],
bindings: () => [{ centerId: identity.center, teamId: identity.team, projectId: identity.project, localProjectId: identity.localProjectId }],
} as Partial<SharedProjectsPorts> as SharedProjectsPorts);
const localSnapshot = { peers: [], projects: [{ id: "team-local", name: "团队项目丙（本机）", dirs: ["/synthetic/team-local"], personal: false }] };

/** 每条接口按顺序消费的状态码（用完停在最后一个）；第一次回包晚多久 */
/** context：200 = 有一条绑定；"none" = 200 但没有绑定（没入团队，前端按 403 处理）；其余 = 直接回这个状态码 */
interface Plan { ledger: Record<string, number[]>; ledgerFirstMs: number; context: 200 | "none" | number; snapshot: number[]; snapshotFirstMs: number }
let plan: Plan;
let hits: Record<string, number> = {};
const take = (key: string, list: number[]) => list[Math.min((hits[key] = (hits[key] ?? 0) + 1) - 1, list.length - 1)]!;

async function api(path: string): Promise<Response> {
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  if (path === "/shared-ledger/context") {
    if (plan.context === "none") return json({ identities: [] });
    return plan.context === 200 ? json({ identities: [identity] }) : json({ error: "synthetic" }, plan.context);
  }
  if (path === "/shared-projects/snapshot") {
    if (!hits.snapshot) await Bun.sleep(plan.snapshotFirstMs);
    const status = take("snapshot", plan.snapshot);
    return status === 200 ? json(await sharedProjectsSnapshot(ports(), localSnapshot)) : json({ error: "synthetic" }, status);
  }
  const id = path.match(/^\/ledger\/([^/]+)$/)?.[1];
  if (id && plan.ledger[id]) {
    if (!hits[id]) await Bun.sleep(plan.ledgerFirstMs);
    const status = take(id, plan.ledger[id]!);
    return status === 200 ? json({ ok: true, ...ledger }) : json({ ok: false, error: "synthetic" }, status);
  }
  return json({ ok: false, error: "not in fixture" }, 404);
}

async function bundle(repo: string, label: string) {
  const dir = join(work, label);
  const build = Bun.spawn([process.execPath, "build", ENTRY, "--target", "browser", "--outdir", dir, "--tsconfig-override", "web/tsconfig.json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  const css = (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
  return { dir, css: css as string };
}
function serve({ dir, css }: { dir: string; css: string }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css"><link rel="stylesheet" href="/team-view-harness.css"></head>
    <body><div id="root"></div><script src="/team-view-harness.js"></script></body></html>`;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.match(/^\/m\/mac-a\/api\/v1(\/.*)$/)?.[1];
    if (path) return api(path);
    if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/tw.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (url.pathname === "/app-config.json") return Response.json({ mode: "relay", relayBase: url.origin, version: "" });
    return /^\/team-view-harness\.(js|css)$/.test(url.pathname) ? new Response(Bun.file(join(dir, url.pathname))) : new Response(null, { status: 404 });
  } });
}

let browser: Browser;
const sides: { label: "before" | "after"; server: ReturnType<typeof Bun.serve> }[] = [];
const manifest: { file: string; sha256: string }[] = [];
const issues: Record<string, ShotIssue[]> = {};
const external: string[] = [];

beforeAll(async () => {
  mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  if (BASE) sides.push({ label: "before", server: serve(await bundle(BASE, "before")) });
  sides.push({ label: "after", server: serve(await bundle(resolve(import.meta.dir, ".."), "after")) });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);

afterAll(async () => {
  for (const s of sides) s.server.stop(true);
  await browser?.close();
  if (OUT) writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ manifest, issues, external }, null, 2));
  else rmSync(work, { recursive: true, force: true });
}, 60_000);

const start = (over: Partial<Plan> = {}) => {
  hits = {};
  plan = { ledger: { [A.id]: [200], [B.id]: [503, 503, 200] }, ledgerFirstMs: SLOW_LEDGER_MS, context: 200, snapshot: [500, 200],
    snapshotFirstMs: SLOW_TEAM_MS, ...over };
};
async function open(server: ReturnType<typeof Bun.serve>, width: number) {
  const g = await guardedPage(browser, String(server.url), { width });
  await g.page.setViewportSize({ width, height: width < 640 ? 844 : 800 });
  await g.page.goto(`${server.url}?${new URLSearchParams({ machine: "mac-a", theme: "light", projects: JSON.stringify(PROJECTS) })}`);
  await g.page.locator("[data-machine]").first().waitFor();
  return g;
}
const group = (page: Page, name: string) => page.locator("nav[aria-label='侧栏'] > ul > li").filter({ has: page.getByRole("button", { name, exact: false }) });
const sessionY = async (page: Page, name: string) => (await group(page, name).getByText("（合成会话行）").boundingBox())!.y;
const rowH = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!.height;
const team = (page: Page) => page.locator("section[aria-label='团队项目']");
async function shot(page: Page, label: string, name: string) {
  await page.mouse.move(5, 5);
  await page.evaluate("document.activeElement?.blur()");
  const file = `${label}-${name}.png`;
  const png = await page.screenshot({ path: join(shotsDir, file), animations: "disabled" });
  manifest.push({ file, sha256: createHash("sha256").update(png).digest("hex") });
  issues[`${label}-${name}`] = await shotIssues(page);
}

for (const width of [1280, 390]) {
  test(`${width}：首屏占位 → 读到换正常行（下方会话行不动）/ 失败灰行 + 重试 → 恢复；团队区占位 → 没读到 + 重试 → 恢复`, async () => {
    for (const { label, server } of sides) {
      start();
      const t0 = Date.now();
      const { page, ctx, errors, external: ext } = await open(server, width);
      await group(page, A.name).getByText("（合成会话行）").waitFor();
      const y0 = { a: await sessionY(page, A.name), b: await sessionY(page, B.name) };
      if (label === "after") {
        expect(Date.now() - t0).toBeLessThan(SLOW_LEDGER_MS); // 下面看到的确实是读到之前的首屏
        expect(await page.locator("li[data-collab-entry=pending]").count()).toBe(2);
        expect(await page.locator("[data-team-projects=pending]").count()).toBe(1);
        expect(await page.locator("body").innerText()).not.toMatch(/加载中|正在读取|Loading/);
      }
      await shot(page, label, `1-pending-${width}`);

      if (label === "after") {
        const ready = group(page, A.name).getByRole("button", { name: "协作视图" });
        await ready.waitFor();
        expect(await rowH(page, "li[data-collab-entry=pending], li[data-collab-entry=failed]")).toBe(await rowH(page, "[data-collab-entry=ready]"));
        expect(await sessionY(page, A.name)).toBe(y0.a);
        const retry = group(page, B.name).getByRole("button", { name: "没读到，点一下重试" });
        await retry.waitFor();
        expect(await retry.getAttribute("title")).toBe("没读到，点一下重试");
        expect((await retry.innerText()).trim()).toBe("");
        expect(await sessionY(page, B.name)).toBe(y0.b);
        expect(await group(page, B.name).getByRole("button", { name: "协作视图" }).count()).toBe(0); // 灰行不能开
        await team(page).getByText("没读到团队项目").waitFor();
        expect(await team(page).getByRole("button", { name: "重试" }).isVisible()).toBe(true);
      } else await page.waitForTimeout(SLOW_TEAM_MS + 500);
      await shot(page, label, `2-failed-${width}`);

      if (label === "after") {
        // 乙：每点一次只多一个台账请求；第二次 503 仍是灰行，第三次 200 变正常行，会话行一直不动
        const retry = group(page, B.name).getByRole("button", { name: "没读到，点一下重试" });
        const before = hits[B.id]!;
        await retry.click();
        await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
        expect(hits[B.id]).toBe(before + 1);
        expect(await retry.isVisible()).toBe(true);
        await retry.click();
        await group(page, B.name).getByRole("button", { name: "协作视图" }).waitFor();
        expect(hits[B.id]).toBe(before + 2);
        expect(await sessionY(page, B.name)).toBe(y0.b);
        // 团队区：点一次重试 = 一次 refresh（快照接口多一个请求），读到后出团队行
        const snaps = hits.snapshot!;
        await team(page).getByRole("button", { name: "重试" }).click();
        await team(page).getByRole("button", { name: "团队项目丙", exact: false }).waitFor();
        expect(hits.snapshot).toBe(snaps + 1);
        expect(await team(page).getByText("没读到团队项目").count()).toBe(0);
      } else await page.waitForTimeout(1_000);
      await shot(page, label, `3-recovered-${width}`);

      if (label === "after") {
        for (const name of [`1-pending-${width}`, `2-failed-${width}`, `3-recovered-${width}`]) expect(issues[`after-${name}`]).toEqual([]);
        expect(errors).toEqual([]);
      }
      expect(ext).toEqual([]);
      external.push(...ext);
      await ctx.close();
    }
  }, 120_000);
}

test("1280：台账 403 / 404 不出「协作视图」行；团队区 403（没有绑定）/ 404（context）/ 501（快照）整节不出", async () => {
  const after = sides.find((s) => s.label === "after")!.server;
  // 团队区 501：context 正常、快照接口回 501（这台 bridge 不支持团队项目）；context 本身 501 会让项目组入口走团队选源的「读不到」，不是本卡的事
  for (const [ledgerStatus, context, snapshot] of [[403, "none", 200], [404, 404, 200], [200, 200, 501]] as const) {
    start({ ledger: { [A.id]: [200], [B.id]: [ledgerStatus] }, ledgerFirstMs: 0, context, snapshot: [snapshot], snapshotFirstMs: 0 });
    const { page, ctx, errors, external: ext } = await open(after, 1280);
    await group(page, A.name).getByRole("button", { name: "协作视图" }).waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-collab-entry=pending], [data-team-projects=pending]"));
    const b = group(page, B.name);
    expect(await b.locator("[data-collab-entry]").count()).toBe(ledgerStatus === 200 ? 1 : 0);
    expect(await team(page).count()).toBe(0);
    expect(errors).toEqual([]);
    expect(ext).toEqual([]);
    await ctx.close();
  }
}, 60_000);
