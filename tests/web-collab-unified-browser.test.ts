/**
 * team-project-N8：项目组「协作视图」按绑定统一入口，真 Chromium + 合成两台机器（中继模式 /m/<fp>/api/v1/*），不连生产 bridge / 中心。
 * 截图私存：COLLAB_UNIFIED_SHOTS_DIR=<仓库外目录>（缺省写临时目录、跑完删掉），390 / 1280 各一套，manifest 记 head 与 fixture 摘要。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot, type SharedProjectsLocalSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";
import { sharedCollabProject } from "../web/features/collab/team-source-key";
import type { FeatureDetail } from "../web/lib/api/shared-ledger";

const scratch = mkdtempSync(join(tmpdir(), "cstra-test-collab-unified-"));
const shots = process.env.COLLAB_UNIFIED_SHOTS_DIR ? resolve(process.env.COLLAB_UNIFIED_SHOTS_DIR) : join(scratch, "shots");
const entry = "web/features/collab/team-view-harness.tsx";
const manifest: { file: string; sha256: string }[] = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let css = "";

// ---- 合成数据：两台机器本机 id 不同（claudestra / claude-orchestrator）绑定同一中心项目 demo-b ----
const f = createV2ProjectsFixtures();
const CENTER = f.identity.centerId, TEAM = f.identity.teamId, PROJECT = f.identity.projectId;
const PERSON = { "mac-a": { personId: f.person.personId, instanceId: "instance-a" }, "mac-b": { personId: "person-b", instanceId: "instance-b" } } as const;
type Fp = keyof typeof PERSON;
const LOCAL_ID: Record<Fp, string> = { "mac-a": "claudestra", "mac-b": "claude-orchestrator" };
const PROJECTS = {
  "mac-a": [{ id: "claudestra", name: "claudestra", emoji: "🎼" }, { id: "plain-app", name: "未绑定项目", emoji: "📦" },
    { id: "notes", name: "个人笔记", emoji: "📝" }, { id: PROJECT, name: `${PROJECT}（同名本机项目）`, emoji: "🪞" }],
  "mac-b": [{ id: "claude-orchestrator", name: "claude-orchestrator", emoji: "🎻" }, { id: "plain-app", name: "未绑定项目", emoji: "📦" }],
};
const identity = (fp: Fp, over: Record<string, string> = {}) => ({ center: CENTER, team: TEAM, person: PERSON[fp].personId, project: PROJECT,
  localProjectId: LOCAL_ID[fp], homeInstanceId: PERSON[fp].instanceId, ...over });
/** 侧栏 N5 列表打开的 key（projects-entry.tsx:26 的输入） */
const n5Key = (fp: Fp, project = PROJECT) => sharedCollabProject({ machine: fp, center: CENTER, team: TEAM, project,
  person: PERSON[fp].personId, homeInstanceId: PERSON[fp].instanceId });

const NOW = Date.UTC(2026, 9, 8, 4, 0);
function centerFixture(project: string) {
  const g = generateTeamFixture({ features: 2, nodes: 6, now: NOW });
  const homes = ["instance-a", "instance-b"];
  const details: FeatureDetail[] = g.details.map((d, i) => {
    const home = homes[i]!;
    return { ...d, teamId: TEAM, feature: { ...d.feature, projectId: project, title: `${i ? "B" : "A"} 机的 feature：${d.feature.title}`,
      homeInstanceId: home, executorInstanceIds: [home], projection: { ...d.feature.projection!, sourceInstanceId: home } },
    tasks: d.tasks.map((t) => ({ ...t, executorInstanceId: home })) };
  });
  return { list: { ...g.list, teamId: TEAM, features: details.map((d) => d.feature) }, details };
}
const local = generateTeamFixture({ seed: 3, features: 1, nodes: 5, now: NOW }).local;

interface World {
  context: Partial<Record<Fp, { status: number; body?: unknown; gate?: Promise<void> }>>;
  center: Record<string, ReturnType<typeof centerFixture>>;
  centerStatus: number;
  log: string[];
}
let world: World;
const reset = (over: Partial<World> = {}) => (world = { context: { "mac-a": { status: 200, body: { identities: [identity("mac-a")] } },
  "mac-b": { status: 200, body: { identities: [identity("mac-b")] } } }, center: { [PROJECT]: centerFixture(PROJECT) }, centerStatus: 200, log: [], ...over });

function n4Ports(fp: Fp): SharedProjectsPorts {
  const who = { ...f.person, ...f.requests.list, ...PERSON[fp], subject: "owner:self" as const };
  const ids = (world.context[fp]?.body as { identities?: ReturnType<typeof identity>[] } | undefined)?.identities ?? [];
  const projects = [...new Set(ids.map((i) => i.project))].map((projectId) => ({ ...f.project, projectId, code: projectId, name: `中心项目 ${projectId}` }));
  return { person: async () => who, list: async () => projects,
    members: async () => [{ ...f.member, personId: PERSON[fp].personId, role: fp === "mac-a" ? "owner" : "member" }],
    bindings: () => ids.map((i) => ({ centerId: i.center, teamId: i.team, projectId: i.project, localProjectId: i.localProjectId })),
  } as Partial<SharedProjectsPorts> as SharedProjectsPorts;
}
const localSnapshot = (fp: Fp): SharedProjectsLocalSnapshot => ({ peers: [],
  projects: PROJECTS[fp].map((p) => ({ id: p.id, name: p.name, dirs: [`/synthetic/${p.id}`], personal: p.id === "notes" })) });

async function api(fp: Fp, req: Request, path: string): Promise<Response> {
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const hdr = req.headers.get("x-shared-ledger-project");
  world.log.push(`${fp} ${path}${hdr ? ` [${hdr}]` : ""}`);
  if (path === "/shared-ledger/context") {
    const c = world.context[fp]!;
    await c.gate;
    return json(c.body ?? { error: "synthetic" }, c.status);
  }
  if (path === "/shared-projects/snapshot") return json(await sharedProjectsSnapshot(n4Ports(fp), localSnapshot(fp)));
  if (path.startsWith("/shared-ledger/features")) {
    const c = hdr ? world.center[hdr] : undefined;
    if (world.centerStatus !== 200 || !c) return json({ error: "synthetic center failure" }, world.centerStatus === 200 ? 403 : world.centerStatus);
    const id = path.match(/^\/shared-ledger\/features\/(.+)$/)?.[1];
    if (!id) return json(c.list);
    const d = c.details.find((d) => d.feature.id === decodeURIComponent(id));
    return d ? json(d) : json({ error: "nf" }, 404);
  }
  const ledger = path.match(/^\/ledger\/([^/]+)$/);
  if (ledger && PROJECTS[fp].some((p) => p.id === ledger[1])) {
    const tag = (v: { title: string }) => ({ ...v, title: `本机 ${ledger[1]} · ${v.title}` });
    return json({ ok: true, ...local, items: local.items.map(tag), tasks: local.tasks.map(tag) });
  }
  return json({ ok: false, error: "not in fixture" }, 404);
}

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true, mode: 0o700 }); chmodSync(shots, 0o700);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", scratch, "--tsconfig-override", "web/tsconfig.json"],
    { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const req = createRequire(resolve("web/package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = resolve("web/app/globals.css");
  css = (await postcss([tw({ base: resolve("web") })]).process(readFileSync(from, "utf8"), { from })).css;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/team-view-harness.js") return new Response(Bun.file(join(scratch, "team-view-harness.js")));
    if (path === "/team-view-harness.css") return new Response(Bun.file(join(scratch, "team-view-harness.css")));
    if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "relay", relayBase: url.origin, version: "" });
    const m = path.match(/^\/m\/(mac-a|mac-b)\/api\/v1(\/.*)$/);
    if (m) return api(m[1] as Fp, request, decodeURIComponent(m[2]!));
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/team-view-harness.css"></head>
      <body><div id="root"></div><script src="/team-view-harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);

afterAll(async () => {
  try {
    const [head, dirty] = await Promise.all([git("rev-parse", "HEAD"), git("status", "--porcelain", "--", "web", "tests")]);
    if (manifest.length) writeFileSync(join(shots, "manifest.json"), JSON.stringify({ head, dirty: !!dirty, specRev: 1,
      fixture: "two synthetic relay machines (mac-a local id claudestra / mac-b local id claude-orchestrator) bound to one center project; "
        + "center features from instance-a and instance-b; N4 snapshot producer with synthetic ports; no production bridge, center, relay or device",
      fixtureSha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
      testSha256: createHash("sha256").update(readFileSync("tests/web-collab-unified-browser.test.ts")).digest("hex"), shots: manifest }, null, 2), { mode: 0o600 });
  } finally {
    server?.stop(true);
    try { await browser?.close(); } finally { if (!process.env.COLLAB_UNIFIED_SHOTS_DIR) rmSync(scratch, { recursive: true, force: true }); }
  }
}, 60_000);

/** React DevTools 钩子：拿到 fiber 根，按组件名断言渲染树（TeamSource > CollabView） */
const HOOK = `window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; },
  onCommitFiberRoot(_id, root) { window.__fiberRoot = root; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };`;
const pages: Page[] = [];
afterEach(async () => { await Promise.all(pages.splice(0).map((p) => p.close().catch(() => undefined))); }, 30_000);
async function open(width: number, machine: Fp = "mac-a", extra: Record<string, string> = {}) {
  const page = await browser.newPage({ viewport: { width, height: width < 640 ? 844 : 900 } });
  pages.push(page);
  await page.addInitScript(HOOK);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort()); // 只许回环
  const q = new URLSearchParams({ machine, projects: JSON.stringify(PROJECTS), ...extra });
  await page.goto(`${server.url}?${q}`);
  await page.locator("[data-machine]").first().waitFor();
  return { page, errors };
}
async function shot(page: Page, name: string, width: number) {
  const file = `${name}-${width}.png`;
  const png = await page.screenshot({ path: join(shots, file), animations: "disabled" });
  chmodSync(join(shots, file), 0o600);
  manifest.push({ file, sha256: createHash("sha256").update(png).digest("hex") });
}
const group = (page: Page, name: string) => page.locator("nav[aria-label='侧栏'] > ul > li").filter({ has: page.getByRole("button", { name, exact: false }) }).first();
const entryOf = (page: Page, name: string) => group(page, name).getByRole("button", { name: "协作视图" });
const opened = (page: Page) => page.evaluate("document.body.dataset.open ?? ''") as Promise<string>;
const ledgerHits = (id: string) => world.log.filter((l) => l.endsWith(` /ledger/${id}`) || l.includes(` /ledger/${id}/`));
const centerHits = () => world.log.filter((l) => l.includes("/shared-ledger/features"));
const contextHits = (fp: Fp) => world.log.filter((l) => l === `${fp} /shared-ledger/context`);
/** 渲染树里 TeamSource 的祖先链与它下面的 CollabView */
const tree = (page: Page) => page.evaluate(`(() => {
  const name = (f) => typeof f.type === "function" ? f.type.displayName || f.type.name : null;
  const out = []; const walk = (f, chain) => { for (; f; f = f.sibling) { const n = name(f); const next = n ? [...chain, n] : chain;
    if (n === "CollabView") out.push(next.filter((x) => ["CollabSwitch", "SharedCollabContent", "TeamSource", "CollabView"].includes(x)).join(">"));
    walk(f.child, next); } };
  walk(window.__fiberRoot?.current, []); return out; })()`) as Promise<string[]>;

for (const width of [1280, 390]) {
  const mobile = width < 640;
  test(`${width}：未绑定 / 个人 / 同名本机项目走本机，已绑定（主场机）项目组入口 = N5 列表同 key、同视图，不探本机台账`, async () => {
    reset();
    const { page, errors } = await open(width);
    for (const name of ["未绑定项目", "个人笔记", `${PROJECT}（同名本机项目）`]) await entryOf(page, name).waitFor();
    expect(ledgerHits("claudestra")).toEqual([]);
    // 本节点的 store 每机 1 次；另一次是 N5 侧栏列表自己的 sharedProjectsByBindings 读
    expect(contextHits("mac-a").length).toBeLessThanOrEqual(2);
    // 未绑定 / 个人项目：除每机 1 次 context 外不发共享请求
    expect(world.log.filter((l) => l.includes("/shared-ledger/") && !l.endsWith("/shared-ledger/context"))).toEqual([]);
    await shot(page, "1-unbound-sidebar", width);
    await entryOf(page, "未绑定项目").click();
    expect(await opened(page)).toBe("plain-app");
    await page.getByText("本机 plain-app ·", { exact: false }).first().waitFor();
    expect(await tree(page)).toEqual(["CollabSwitch>SharedCollabContent>CollabView"]);
    await shot(page, "1-unbound-view", width);
    if (mobile) await page.getByRole("button", { name: "返回", exact: true }).click();
    await entryOf(page, "个人笔记").click();
    await page.getByText("本机 notes ·", { exact: false }).first().waitFor();
    await shot(page, "4-personal-view", width);
    if (mobile) await page.getByRole("button", { name: "返回", exact: true }).click();
    // 已绑定（主场机 mac-a）：入口 → 中心 key，同 N5
    await entryOf(page, "claudestra").click();
    expect(await opened(page)).toBe(n5Key("mac-a"));
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    await page.getByText("B 机的 feature", { exact: false }).first().waitFor();
    expect(await tree(page)).toEqual(["CollabSwitch>SharedCollabContent>TeamSource>CollabView"]);
    const viaGroup = await page.locator("main").innerText();
    await shot(page, "3-bound-home-view", width);
    if (mobile) await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.locator("section[aria-label='团队项目']").getByRole("button", { name: `中心项目 ${PROJECT}` }).click();
    expect(await opened(page)).toBe(n5Key("mac-a"));
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    expect(await page.locator("main").innerText()).toBe(viaGroup);
    expect(ledgerHits("claudestra")).toEqual([]);
    expect(errors).toEqual([]);
  }, 90_000);

  test(`${width}：非主场成员机（本机 id claude-orchestrator）看到同一份中心列表；换机器后旧机器 context 晚回包丢弃`, async () => {
    reset();
    let release!: () => void;
    world.context["mac-a"] = { ...world.context["mac-a"]!, gate: new Promise<void>((r) => (release = r)) };
    const { page, errors } = await open(width, "mac-a");
    await page.locator("[data-machine='mac-b']").click();
    release(); // mac-a 的 context 此刻才回来：不能进 mac-b
    await entryOf(page, "claude-orchestrator").click();
    expect(await opened(page)).toBe(n5Key("mac-b"));
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    await page.getByText("B 机的 feature", { exact: false }).first().waitFor();
    expect(ledgerHits("claude-orchestrator")).toEqual([]);
    expect(world.log.filter((l) => l.startsWith("mac-b") && l.includes("/shared-ledger/features")).every((l) => l.endsWith(`[${PROJECT}]`))).toBe(true);
    await shot(page, "2-bound-member-view", width);
    expect(errors).toEqual([]);
  }, 90_000);

  test(`${width}：中心读不到——有缓存保留并显示重试条、无缓存 LoadState 错误；中心 403 → 入口『团队权限已失效』；均不回退本机`, async () => {
    reset();
    const { page } = await open(width);
    const back = () => mobile ? page.getByRole("button", { name: "返回", exact: true }).click() : Promise.resolve();
    await entryOf(page, "claudestra").click();
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    await back();
    await entryOf(page, "未绑定项目").click(); // 换走：中心视图卸载，总览缓存留着
    await page.getByText("本机 plain-app ·", { exact: false }).first().waitFor();
    world.centerStatus = 503;
    await back();
    await entryOf(page, "claudestra").click();
    await page.getByText("没取到", { exact: false }).first().waitFor({ timeout: 20_000 });
    await shot(page, "5-center-down-cached", width);
    expect(await page.getByText("i28-A3", { exact: true }).count()).toBeGreaterThan(0); // 中心缓存的卡还在
    expect(await page.locator("main").innerText()).not.toContain("本机 claudestra");
    await page.close();
    reset({ centerStatus: 503 });
    const fresh = await open(width);
    await entryOf(fresh.page, "claudestra").click();
    await fresh.page.getByRole("button", { name: "重试" }).first().waitFor({ timeout: 20_000 });
    await shot(fresh.page, "5-center-down-nocache", width);
    expect(ledgerHits("claudestra")).toEqual([]);
    world.centerStatus = 403;
    const denied403 = fresh.page.waitForResponse((r) => r.url().includes("/shared-ledger/features") && r.status() === 403);
    await fresh.page.getByRole("button", { name: "重试" }).first().click();
    await denied403;
    if (mobile) await fresh.page.evaluate("window.__systemBack()");
    await group(fresh.page, "claudestra").getByText("团队权限已失效", { exact: false }).waitFor({ timeout: 40_000 });
    expect(await entryOf(fresh.page, "claudestra").count()).toBe(0);
    expect(ledgerHits("claudestra")).toEqual([]);
  }, 120_000);

  test(`${width}：同一中心 projectId 跨团队 → 禁用、TeamSource 请求 0；context 403 → 按未绑定走本机；5xx 从没成功过 → checking 禁用`, async () => {
    reset();
    world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a"), identity("mac-a", { team: "team-other", localProjectId: "elsewhere" })] } };
    const { page } = await open(width);
    await group(page, "claudestra").getByText("绑定无法区分", { exact: false }).waitFor();
    expect(await entryOf(page, "claudestra").count()).toBe(0);
    await shot(page, "6-ambiguous", width);
    expect(centerHits()).toEqual([]);
    expect(ledgerHits("claudestra")).toEqual([]);
    await page.close();
    reset();
    world.context["mac-a"] = { status: 403 };
    const denied = await open(width);
    await entryOf(denied.page, "claudestra").click();
    expect(await opened(denied.page)).toBe("claudestra");
    await denied.page.close();
    reset();
    world.context["mac-a"] = { status: 503 };
    const down = await open(width);
    await group(down.page, "claudestra").getByText("团队绑定暂时读不到", { exact: false }).waitFor();
    expect(ledgerHits("claudestra")).toEqual([]);
  }, 90_000);

  test(`${width}：改绑 A→B 时打开着的 A 视图关闭，A 的迟到回包不进 B`, async () => {
    reset();
    world.center["demo-c"] = centerFixture("demo-c");
    const { page } = await open(width);
    await entryOf(page, "claudestra").click();
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    expect(await opened(page)).toBe(n5Key("mac-a"));
    world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a", { project: "demo-c" })] } };
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.waitForFunction("document.body.dataset.open === ''");
    await shot(page, "7-rebound-closed", width);
    const before = centerHits().length;
    await entryOf(page, "claudestra").click();
    expect(await opened(page)).toBe(n5Key("mac-a", "demo-c"));
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    expect(centerHits().slice(before).every((l) => l.endsWith("[demo-c]"))).toBe(true);
  }, 90_000);

  test(`${width}：中心 403 后 context 成功但不再列出该身份 → 仍『团队权限已失效』，不回退本机`, async () => {
    reset({ centerStatus: 403 });
    const { page } = await open(width);
    const denied = page.waitForResponse((r) => r.url().includes("/shared-ledger/features") && r.status() === 403);
    await entryOf(page, "claudestra").click();
    await denied;
    if (mobile) await page.evaluate("window.__systemBack()");
    await group(page, "claudestra").getByText("团队权限已失效", { exact: false }).waitFor({ timeout: 40_000 });
    // 读凭据被移除：bridge 只列仍有读凭据的身份，context 200、identities 为空
    world.context["mac-a"] = { status: 200, body: { identities: [] } };
    const refreshed = page.waitForResponse((r) => r.url().endsWith("/shared-ledger/context"));
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await refreshed;
    await page.waitForFunction("document.body.dataset.open === ''");
    await page.waitForTimeout(500); // 两个 context 读者（本 store / N5 列表）都落地
    await group(page, "claudestra").getByText("团队权限已失效", { exact: false }).waitFor();
    expect(await entryOf(page, "claudestra").count()).toBe(0);
    expect(ledgerHits("claudestra")).toEqual([]);
  }, 120_000);
}

test("1280：打开它的项目组折叠期间改绑 A→B，旧视图照样关闭（其他项目组的入口仍订阅同一 store）", async () => {
  reset();
  world.center["demo-c"] = centerFixture("demo-c");
  const { page } = await open(1280);
  await entryOf(page, "claudestra").click();
  await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
  expect(await opened(page)).toBe(n5Key("mac-a"));
  await group(page, "claudestra").locator("> button").click(); // 折叠：claudestra 的入口卸载
  expect(await entryOf(page, "claudestra").count()).toBe(0);
  world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a", { project: "demo-c" })] } };
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/shared-ledger/context"));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await refreshed;
  await page.waitForFunction("document.body.dataset.open === ''");
  await group(page, "claudestra").locator("> button").click(); // 展开后新入口开 demo-c
  await entryOf(page, "claudestra").click();
  expect(await opened(page)).toBe(n5Key("mac-a", "demo-c"));
}, 60_000);

test("1280：全部项目组折叠（没有任何入口挂着）期间改绑 A→B，旧视图照样关闭", async () => {
  reset();
  world.center["demo-c"] = centerFixture("demo-c");
  const { page } = await open(1280);
  await entryOf(page, "claudestra").click();
  await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
  expect(await opened(page)).toBe(n5Key("mac-a"));
  for (const p of PROJECTS["mac-a"]) await group(page, p.name).locator("> button").click(); // 全部折叠：所有入口卸载
  expect(await page.locator("nav[aria-label='侧栏'] > ul").getByRole("button", { name: "协作视图" }).count()).toBe(0);
  world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a", { project: "demo-c" })] } };
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await page.waitForFunction("document.body.dataset.open === ''", undefined, { timeout: 20_000 });
  await group(page, "claudestra").locator("> button").click();
  await entryOf(page, "claudestra").click();
  expect(await opened(page)).toBe(n5Key("mac-a", "demo-c"));
}, 60_000);

test("1280：N5 列表先打开中心视图、项目组入口的 context 后回包，再改绑 A→B：旧视图照样关闭（项目组全展开）", async () => {
  reset();
  world.center["demo-c"] = centerFixture("demo-c");
  const { page } = await open(1280, "mac-a", { holdN8Context: "1" });
  await page.locator("section[aria-label='团队项目']").getByRole("button", { name: `中心项目 ${PROJECT}` }).click();
  await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
  expect(await opened(page)).toBe(n5Key("mac-a"));
  expect(await entryOf(page, "claudestra").count()).toBe(0); // 本节点 store 还没回包，项目组入口未出现
  await page.evaluate("window.__releaseN8Context()");
  await entryOf(page, "claudestra").waitFor();
  expect(await opened(page)).toBe(n5Key("mac-a"));
  world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a", { project: "demo-c" })] } };
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await page.waitForFunction("document.body.dataset.open === ''", undefined, { timeout: 20_000 });
  await entryOf(page, "claudestra").click();
  expect(await opened(page)).toBe(n5Key("mac-a", "demo-c"));
  expect(ledgerHits("claudestra")).toEqual([]);
}, 60_000);

for (const change of ["改绑", "解绑"] as const) {
  test(`1280：首次 N8 context 释放前${change}，N5 打开的旧中心视图关闭`, async () => {
    reset();
    world.center["demo-c"] = centerFixture("demo-c");
    const { page } = await open(1280, "mac-a", { holdN8Context: "1" });
    await page.locator("section[aria-label='团队项目']").getByRole("button", { name: `中心项目 ${PROJECT}` }).click();
    await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
    expect(await opened(page)).toBe(n5Key("mac-a"));
    expect(await entryOf(page, "claudestra").count()).toBe(0);
    world.context["mac-a"] = { status: 200, body: { identities: change === "改绑" ? [identity("mac-a", { project: "demo-c" })] : [] } };
    await page.evaluate("window.__releaseN8Context()");
    await entryOf(page, "claudestra").waitFor();
    await page.waitForFunction("document.body.dataset.open === ''", undefined, { timeout: 5_000 });
    if (change === "改绑") {
      await entryOf(page, "claudestra").click();
      expect(await opened(page)).toBe(n5Key("mac-a", "demo-c"));
      expect(ledgerHits("claudestra")).toEqual([]);
    }
  }, 60_000);
}

test("1280：中心 403 → 绑定变成跨团队不可区分 → 身份消失：仍『团队权限已失效』，不回退本机", async () => {
  reset({ centerStatus: 403 });
  const { page } = await open(1280);
  const denied = page.waitForResponse((r) => r.url().includes("/shared-ledger/features") && r.status() === 403);
  await entryOf(page, "claudestra").click();
  await denied;
  await group(page, "claudestra").getByText("团队权限已失效", { exact: false }).waitFor({ timeout: 40_000 });
  world.context["mac-a"] = { status: 200, body: { identities: [identity("mac-a"), identity("mac-a", { team: "team-other", localProjectId: "elsewhere" })] } };
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await group(page, "claudestra").getByText("绑定无法区分", { exact: false }).waitFor();
  world.context["mac-a"] = { status: 200, body: { identities: [] } };
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/shared-ledger/context"));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await refreshed;
  await page.waitForTimeout(500);
  await group(page, "claudestra").getByText("团队权限已失效", { exact: false }).waitFor();
  expect(await entryOf(page, "claudestra").count()).toBe(0);
  expect(ledgerHits("claudestra")).toEqual([]);
}, 120_000);

test("390：移动端 菜单 → 入口 → 全屏视图 → 返回", async () => {
  reset();
  const { page } = await open(390);
  await shot(page, "8-mobile-menu", 390);
  await entryOf(page, "claudestra").click();
  await page.getByText("A 机的 feature", { exact: false }).first().waitFor();
  expect(await page.locator("aside").isVisible()).toBe(false);
  await shot(page, "8-mobile-fullscreen", 390);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await entryOf(page, "claudestra").waitFor();
  expect(await opened(page)).toBe("");
  await shot(page, "8-mobile-back", 390);
  await page.close();
}, 60_000);
