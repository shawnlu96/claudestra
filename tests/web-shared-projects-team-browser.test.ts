/** N9W screenshots: real Chromium, synthetic harness port or the actual N4 snapshot/team route behind the real binding entry. */
import { afterAll, beforeAll, expect } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shotIssues } from "./helpers/ui-shot-checks";
import { budgetedTest } from "./browser-test-budget";
import { createV2ProjectsFixtures, createV2ProjectsTeamFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects";
import { SharedTeamConflict, type SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";

const HARNESS = "web/features/collab/shared-projects/fixture-harness.tsx";
const work = mkdtempSync(join(tmpdir(), "cstra-test-team-ui-"));
const shotDir = resolve(process.env.SHARED_PROJECTS_SHOTS_DIR ?? join(work, "shots"));
const shots: { file: string; sha256: string }[] = [];
const BUDGET_MS = 30_000;
const f = createV2ProjectsFixtures(), t = createV2ProjectsTeamFixtures();
const SECRETS = [f.grant.bearer, f.invite.code, f.creatorInvite.code, f.identity.centerId];
let chrome: Browser;
let site: ReturnType<typeof Bun.serve>;
const browserTest = budgetedTest(() => chrome.contexts());

beforeAll(async () => {
  mkdirSync(shotDir, { recursive: true, mode: 0o700 });
  chmodSync(shotDir, 0o700);
  const bundle = Bun.spawn([process.execPath, "build", HARNESS, "--target", "browser", "--outdir", work,
    "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await bundle.exited) throw new Error(await new Response(bundle.stderr).text());
  const web = createRequire(resolve("web/package.json"));
  const postcss = web("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tailwind = web("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const globals = resolve("web/app/globals.css");
  const style = (await postcss([tailwind({ base: resolve("web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
  site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(page, { headers: { "Content-Type": "text/html" } });
    if (path === "/fixture.js") return new Response(Bun.file(join(work, "fixture-harness.js")));
    if (path === "/style.css") return new Response(style, { headers: { "Content-Type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "synthetic-machine" });
    return new Response(null, { status: 404 });
  } });
  chrome = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const warm = await chrome.newPage({ viewport: { width: 390, height: 900 } }); // First render stays off the test budgets.
  try { await warm.goto(String(site.url)); await warm.waitForSelector("#root > *"); } finally { await warm.close(); }
}, 60_000);

afterAll(async () => {
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args]).stdout.toString().trim();
    // A separate manifest name, so it can share SHARED_PROJECTS_SHOTS_DIR with the N5 browser manifest.
    if (shots.length) writeFileSync(join(shotDir, "manifest-team.json"), JSON.stringify({
      head: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain", "--", "web", "tests"), specRev: 1, card: "team-project-N9W",
      fixture: "synthetic harness port, or actual N4 snapshot/team route with N1C/N9K fixtures behind the real binding entry; no production center",
      harnessSha256: createHash("sha256").update(readFileSync(HARNESS)).digest("hex"),
      testSha256: createHash("sha256").update(readFileSync("tests/web-shared-projects-team-browser.test.ts")).digest("hex"), shots,
    }, null, 2), { mode: 0o600 });
  } finally {
    site?.stop(true);
    try { await chrome?.close(); } finally { rmSync(work, { recursive: true, force: true }); }
  }
}, BUDGET_MS);

async function shoot(page: Page, name: string) {
  const file = `${name}.png`, png = await page.screenshot({ path: join(shotDir, file), animations: "disabled" });
  chmodSync(join(shotDir, file), 0o600);
  shots.push({ file, sha256: createHash("sha256").update(png).digest("hex") });
  expect(await shotIssues(page)).toEqual([]);
  const text = await page.locator("body").innerText();
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** The actual N4 route for this machine: team read and rename are the only injected center ports. */
function n4Team(opts: { role?: "owner" | "member"; rename?: "conflict" | "nocurrent" | "unconfirmed" } = {}) {
  let record = { ...t.record };
  const role = opts.role ?? "owner", self = { ...t.self, teamRole: role };
  const counts = { snapshot: 0, patch: [] as { body: unknown; header: string | undefined }[] };
  const d = { now: Date.now, person: async () => ({ ...f.person, ...f.requests.list, subject: "owner:self" }), list: async () => [f.project],
    members: async () => [f.member], bindings: () => [{ ...f.identity, localProjectId: "local-app" }],
    team: async () => ({ ...t.responses.team, team: record, self, members: [t.owner, self] }),
    updateTeam: async (_who: unknown, input: { rev: number; name: string }) => {
      if (opts.rename === "nocurrent") throw new SharedTeamConflict({ ...record, teamId: "other-team" });
      if (opts.rename === "conflict" && counts.patch.length === 1) record = { ...record, name: "同事改的团队名", rev: 2 };
      if (input.rev !== record.rev) throw new SharedTeamConflict(record);
      return record = { ...record, name: input.name, rev: record.rev + 1 };
    },
  } as unknown as SharedProjectsPorts;
  const route = async (r: Route) => {
    const req = r.request(), url = new URL(req.url());
    if (url.pathname === "/api/v1/shared-ledger/context") return r.fulfill({ json: { identities: [{ center: f.identity.centerId,
      team: f.identity.teamId, project: f.identity.projectId, person: f.person.personId, homeInstanceId: f.person.instanceId }] } });
    if (url.pathname === "/api/v1/asks") return r.fulfill({ json: { asks: [] } });
    if (url.pathname.endsWith("/snapshot")) counts.snapshot++;
    if (req.method() === "PATCH") {
      counts.patch.push({ body: req.postDataJSON(), header: req.headers()["x-shared-ledger-project"] });
      if (opts.rename === "unconfirmed") return r.fulfill({ status: 409, json: { ok: false, code: "project_conflict" } });
    }
    const res = await handleSharedProjectsApi(new Request(url.toString(), { method: req.method(), headers: req.headers(),
      ...(req.postData() ? { body: req.postData() } : {}) }), url, { auth: async () => ({ id: "owner:self", role: "owner", agents: ["*"],
      manage: true, createdAt: "" }), ports: d, localSnapshot: async () => ({ projects: [{ id: "local-app", name: "本机工作区", dirs: [],
      personal: false }], peers: [{ name: "synthetic-transport", enabled: true, invitable: true }] }) });
    return res ? r.fulfill({ status: res.status, json: await res.json() }) : r.fulfill({ status: 404 });
  };
  return { counts, route };
}

async function open(width: number, query: string, n4?: ReturnType<typeof n4Team>) {
  const page = await chrome.newPage({ viewport: { width, height: 900 } }), errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const origin = String(site.url).replace(/\/$/, "");
  await page.route("**/*", r => {
    const url = new URL(r.request().url());
    if (url.origin !== origin) { errors.push("non-loopback request"); return r.abort(); }
    return n4 && url.pathname.startsWith("/api/v1/") ? n4.route(r) : r.continue();
  });
  await page.goto(`${site.url}${query}`);
  await page.getByRole("button", { name: "项目设置", exact: true }).click();
  return { page, errors };
}
const teamSelect = (page: Page) => page.locator("select", { has: page.locator("option", { hasText: "请选择团队" }) });
const selectedTeam = (page: Page) => teamSelect(page).locator("option:checked").innerText();

for (const width of [390, 1280]) {
  browserTest(`owner on the actual N4 route sees the center team name in the create form at ${width}px`, async () => {
    const n4 = n4Team();
    const { page, errors } = await open(width, "?fixture=bindings-team", n4);
    try {
      await page.getByRole("button", { name: "创建项目", exact: true }).waitFor();
      expect(await selectedTeam(page)).toBe("合成团队");
      expect(await page.getByLabel("团队显示名", { exact: true }).inputValue()).toBe("合成团队");
      expect(await page.getByLabel("团队显示名", { exact: true }).getAttribute("maxlength")).toBe("64");
      await shoot(page, `team-owner-create-${width}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);

  browserTest(`member on the actual N4 route keeps the owner-only notice and has no rename at ${width}px`, async () => {
    const { page, errors } = await open(width, "?fixture=bindings-team", n4Team({ role: "member" }));
    try {
      await page.getByText("仅团队 owner 可以新建团队项目。", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "创建项目", exact: true }).count()).toBe(0);
      expect(await page.getByLabel("团队显示名", { exact: true }).count()).toBe(0);
      expect(await page.getByText("合成团队", { exact: true }).first().isVisible()).toBe(true);
      await shoot(page, `team-member-${width}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);

  for (const [state, query, name] of [
    ["unnamed", "?team=unnamed", "未命名团队 · fixture-team"],
    ["unavailable", "?team=unavailable", "团队 fixture-team（中心未提供显示名）"],
  ] as const) browserTest(`${state} team display name is a fixed label, never a project name, at ${width}px`, async () => {
    const { page, errors } = await open(width, `${query}&fixture=settings`);
    try {
      await page.getByText(name, { exact: true }).first().waitFor();
      expect(await selectedTeam(page)).toBe(name);
      expect(await selectedTeam(page)).not.toBe("团队工作台");
      expect(await page.getByLabel("团队显示名", { exact: true }).count()).toBe(state === "unavailable" ? 0 : 1);
      await shoot(page, `team-name-${state}-${width}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);

  browserTest(`several centers tag each team name with its short center id at ${width}px`, async () => {
    const { page, errors } = await open(width, "?centers=2");
    try {
      await page.getByText("示例团队 · 中心 center", { exact: true }).first().waitFor();
      expect(await page.getByText("另一中心团队 · 中心 b7c41e", { exact: true }).first().isVisible()).toBe(true);
      expect(await teamSelect(page).locator("option").allTextContents())
        .toEqual(["请选择团队", "示例团队 · 中心 center", "另一中心团队 · 中心 b7c41e"]);
      expect(await page.locator("body").innerText()).not.toContain("fixture-second-center-b7c41e");
      await shoot(page, `team-name-multicenter-${width}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);

  browserTest(`team directory lists only invitable people by code and sends their personId at ${width}px`, async () => {
    const { page, errors } = await open(width, "?fixture=settings&directory=1");
    try {
      await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
      const pick = page.getByLabel("从团队目录选择", { exact: true });
      await pick.locator("option", { hasText: "目录中的伙伴" }).waitFor({ state: "attached" });
      expect(await pick.locator("option").allInnerTexts()).toEqual(["请选择团队成员", "目录中的伙伴"]);
      expect(await page.getByLabel("邀请对象", { exact: true }).count()).toBe(0);
      expect(await page.getByText("中心暂未提供团队成员目录；", { exact: false }).count()).toBe(0);
      await pick.selectOption("fixture-directory-person");
      await page.getByText("协作伙伴的机器", { exact: true }).click();
      expect(await page.locator("body").innerText()).not.toContain("fixture-directory-person");
      await page.getByText("不在团队目录里的人请用新成员代号。", { exact: false }).scrollIntoViewIfNeeded();
      await shoot(page, `team-directory-invite-${width}`);
      await page.getByRole("button", { name: "邀请成员", exact: true }).click();
      await page.getByText("邀请已发送，等待对方确认加入。", { exact: true }).waitFor();
      expect(JSON.parse((await page.locator("body").getAttribute("data-last-invite"))!))
        .toEqual({ peers: ["fixture-peer"], note: "", recipient: { personId: "fixture-directory-person" } });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);

  browserTest(`rename conflict with current shows it and retries once on its revision at ${width}px`, async () => {
    const n4 = n4Team({ rename: "conflict" });
    const { page, errors } = await open(width, "?fixture=bindings-team", n4);
    try {
      const name = page.getByLabel("团队显示名", { exact: true });
      await name.fill("我的团队名");
      await page.getByRole("button", { name: "保存团队名称", exact: true }).click();
      await page.getByText("当前名称：同事改的团队名", { exact: true }).waitFor();
      expect(await page.getByText("项目已被更新", { exact: false }).count()).toBe(0);
      expect(n4.counts.patch).toEqual([{ body: { rev: 1, name: "我的团队名" }, header: f.identity.projectId }]);
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      await page.getByText("同事改的团队名", { exact: true }).first().waitFor();
      expect(await name.inputValue()).toBe("我的团队名"); // Refresh exposes the new value but keeps the dirty draft.
      await shoot(page, `team-rename-conflict-${width}`);
      await page.getByRole("button", { name: "按当前版本重试", exact: true }).click();
      await page.getByText("团队名称已保存。", { exact: true }).waitFor();
      expect(n4.counts.patch.map(p => p.body)).toEqual([{ rev: 1, name: "我的团队名" }, { rev: 2, name: "我的团队名" }]);
      await page.getByText("我的团队名", { exact: true }).first().waitFor();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);
}

for (const [rename, width] of [["nocurrent", 390], ["unconfirmed", 390], ["unconfirmed", 1280]] as const) {
  browserTest(`rename ${rename} shows an unconfirmed result, re-reads once and never resubmits at ${width}px`, async () => {
    const n4 = n4Team({ rename });
    const { page, errors } = await open(width, "?fixture=bindings-team", n4);
    try {
      await page.getByLabel("团队显示名", { exact: true }).fill("未确认的团队名");
      const before = n4.counts.snapshot;
      await page.getByRole("button", { name: "保存团队名称", exact: true }).click();
      await page.getByText("结果未确认，请刷新", { exact: true }).waitFor();
      for (let i = 0; i < 100 && n4.counts.snapshot <= before; i++) await Bun.sleep(20);
      await Bun.sleep(300); // A second read would have to start within this window; none is scheduled.
      expect(n4.counts.snapshot).toBe(before + 1);
      expect(n4.counts.patch).toHaveLength(1);
      expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).count()).toBe(0);
      expect(await page.getByText("项目已被更新", { exact: false }).count()).toBe(0);
      expect(await page.getByText("团队名称已保存。", { exact: true }).count()).toBe(0);
      if (rename === "unconfirmed") await shoot(page, `team-rename-unconfirmed-${width}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, BUDGET_MS);
}
