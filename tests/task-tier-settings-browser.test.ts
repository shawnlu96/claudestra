/**
 * TIER_SETTINGS_BROWSER=1 bun test tests/task-tier-settings-browser.test.ts — 设置页模型档位表的任务类型视图（TIER3g），真实浏览器、隔离夹具、
 * 假 bridge（只拦 /api/v1/settings/role-models），浅色。GET 回包由真的 taskTierEffectiveView 算（含继承、类型覆盖、security、docs 模板未注册、
 * 项目读不到），断言每格显示的有效值与来源与回包逐格一致；保存的 403 / 409 / 400 输入保留、提示可读；390 无横向滚动。
 * 截图：TIER_SETTINGS_SHOTS=<目录> 时只截默认展示（1280 / 390），改前在基线上跑同一条。
 * 直接调 API 被拒（缩权 403、security 低于 Opus 400、旧 rev 409）不需要浏览器，下面隔离测试照常跑。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { makeRoleModelSettingsApi } from "../src/bridge/local-api/role-model-settings.js";
import { CODEX_EFFORT_LEVELS } from "../src/lib/codex-launch.js";
import { effectivePrincipal } from "../src/lib/devices.js";
import { CARD_ROLES, defaultRoleModels, ROLE_MODEL_FAMILIES, type RoleModelTable } from "../src/lib/role-model-settings.js";
import { taskTierEffectiveView } from "../src/lib/task-tier-effective-view.js";
import { TASK_TIERS } from "../src/lib/task-tier-spec.js";

const enabled = process.env.TIER_SETTINGS_BROWSER === "1";
const shotsDir = process.env.TIER_SETTINGS_SHOTS ? resolve(process.env.TIER_SETTINGS_SHOTS) : null;
const out = resolve(".playwright-mcp/tier3g");
const SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5", HAIKU = "claude-haiku-5-5";
const SOURCE: Record<string, string> = {
  "tier-settings": "类型格设置", "tier-default": "类型默认", "role-settings": "继承角色格", "role-default": "继承角色默认",
  settings: "角色格设置", default: "默认表", error: "档位表坏了，按默认表",
};
let browser: Browser, server: Server, url: string;
type View = Record<string, any>;

/** 和 bridge viewOf 同形：角色格有存值（reviewer codex xhigh），code 类型覆盖 reviewer、ui 显式继承，security 继承，docs 模板未注册 */
async function fixtureView(): Promise<View> {
  const t: RoleModelTable = defaultRoleModels();
  t.rev = 3;
  t.roles.reviewer.codex = "xhigh";
  t.tiers = { code: { reviewer: { claude: SONNET, codex: "high" } }, ui: { author: { claude: "inherit", codex: "down1" } }, security: { reviewer: { claude: "inherit" } } };
  const projection = await taskTierEffectiveView(t, "ok", {
    projects: async () => ({ projects: ["alpha", "beta", "broken"].map((id) => ({ id, name: id, dirs: [], createdAt: "2026-10-01T00:00:00Z" })) }),
    mode: (id) => (id === "alpha" ? { mode: "on" } : id === "beta" ? { mode: "observe" } : { mode: "off", diagnostic: "policy_unreadable" }),
  });
  return { ok: true, config: { status: "ok", error: null }, rev: t.rev, families: ROLE_MODEL_FAMILIES, codexEfforts: CODEX_EFFORT_LEVELS,
    roles: CARD_ROLES.map((role) => ({ role, ...t.roles[role] })), tiers: t.tiers, taskTiers: TASK_TIERS, ...projection };
}

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { RoleModelSettingsSection } from "../../features/chat/components/settings/role-model-settings-section";
const models = [{ value: "${OPUS}", label: "Opus 5.5" }, { value: "${SONNET}", label: "Sonnet 5.5" }, { value: "${HAIKU}", label: "Haiku 5.5" }];
createRoot(document.getElementById("root")).render(<div className="space-y-3 px-5 pb-5 pt-3"><RoleModelSettingsSection modelOptions={models} /></div>);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/tier3g-fixture/fixture.tsx");
  await Bun.write(entry, fixture);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]); unlinkSync(entry);
  if (code) throw new Error(error);
  const assets = new Map(readdirSync(out).filter((name) => /\.(js|css)$/.test(name)).map((name) => ["/" + name, Bun.file(resolve(out, name))]));
  let productionCss = "";
  try { for (const name of readdirSync(resolve("web/.next/static/css"))) if (name.endsWith(".css")) productionCss += await Bun.file(resolve("web/.next/static/css", name)).text(); }
  catch { /* 没有 Next 构建时只缺样式，功能断言照跑 */ }
  server = createServer(async (req, res) => {
    if (req.url === "/") {
      const links = [...assets.keys(), "/production.css"].filter((x) => x.endsWith(".css")).map((x) => `<link rel="stylesheet" href="${x}">`).join("");
      res.setHeader("Content-Type", "text/html");
      return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}</head>
        <body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
    }
    if (req.url === "/production.css") { res.setHeader("Content-Type", "text/css"); return res.end(productionCss); }
    const asset = assets.get(req.url!);
    if (asset) { res.setHeader("Content-Type", req.url!.endsWith(".css") ? "text/css" : "text/javascript"); return res.end(Buffer.from(await asset.arrayBuffer())); }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/app-config.json") return res.end(JSON.stringify({ mode: "direct", fp: "test", machineName: "test" }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });

type Reply = { status: number; json: unknown };
async function pageWith(width: number, get: View, put?: (body: unknown) => Reply): Promise<Page & { puts: unknown[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } }) as Page & { puts: unknown[] };
  page.puts = [];
  await page.route("**/api/v1/settings/role-models", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: get });
    const body = route.request().postDataJSON();
    page.puts.push(body);
    return route.fulfill(put ? put(body) : { status: 500, json: { ok: false, error: "x" } });
  });
  await page.goto(url);
  await page.getByTestId("role-model-settings").locator("[data-role]").first().waitFor();
  return page;
}
const noHScroll = (p: Page) => p.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const pickTier = (p: Page, tier: string) => p.getByLabel("task tier", { exact: true }).selectOption(tier);

test.skipIf(!enabled || !shotsDir)("截图：默认展示 1280 / 390（改前改后同一条）", async () => {
  mkdirSync(shotsDir!, { recursive: true });
  const phase = process.env.TIER_SETTINGS_PHASE ?? "after";
  const v = await fixtureView();
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const p = await pageWith(w, v);
    await p.setViewportSize({ width: w, height: h });
    await p.screenshot({ path: join(shotsDir!, `${phase}-table-${w}x${h}.png`), fullPage: true });
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("[验收线 1] 每个类型 × 角色 × 家族：显示的有效值与来源与 GET 回包一致；security 锁定、docs 模板未注册、项目读不到", async () => {
  const v = await fixtureView();
  expect(v.templates.docs).toBe(false); // 夹具前提：真注册表里 docs 没模板
  const p = await pageWith(1280, v);
  const projects = p.getByTestId("role-model-projects");
  expect(await projects.locator('[data-project="alpha"]').innerText()).toContain("启用");
  expect(await projects.locator('[data-project="beta"]').innerText()).toContain("只观察");
  expect(await projects.locator('[data-project="broken"]').innerText()).toContain("读不到");
  expect(await projects.innerText()).not.toContain("关闭");
  for (const tier of ["", ...TASK_TIERS]) {
    await pickTier(p, tier);
    const rows = v.effective[tier || "undeclared"] as { role: string; claude: { value: string | null; source: string }; codex: { value: string | null; source: string } }[];
    for (const row of rows) for (const family of ["claude", "codex"] as const) {
      const cell = p.locator(`[data-role="${row.role}"] [data-effective="${family}"]`);
      expect({ tier, role: row.role, family, value: await cell.getAttribute("data-value"), source: await cell.getAttribute("data-source") })
        .toEqual({ tier, role: row.role, family, value: row[family].value ?? "", source: row[family].source });
      const text = await cell.innerText();
      expect(text).toContain(row[family].value ?? "照 Codex 配置");
      expect(text).toContain(SOURCE[row[family].source]);
    }
    expect(await p.getByTestId("role-model-locked").count()).toBe(tier === "security" ? 1 : 0);
    expect(await p.getByTestId("role-model-no-template").count()).toBe(tier === "docs" ? 1 : 0);
  }
  // 抽查几格的来源确实覆盖到继承 / 覆盖 / 类型默认
  expect(v.effective.code.find((r: View) => r.role === "reviewer").claude).toEqual({ value: SONNET, source: "tier-settings" });
  expect(v.effective.ui.find((r: View) => r.role === "author").claude).toEqual({ value: OPUS, source: "role-settings" });
  expect(v.effective.ui.find((r: View) => r.role === "reviewer").codex).toEqual({ value: "xhigh", source: "role-settings" });
  expect(v.effective.docs.find((r: View) => r.role === "author").claude).toEqual({ value: HAIKU, source: "tier-default" });
  // 类型格的存值进选择框：code reviewer 覆盖、security reviewer 继承、没存的是缺省
  await pickTier(p, "code");
  expect(await p.getByLabel("reviewer claude", { exact: true }).inputValue()).toBe(SONNET);
  expect(await p.getByLabel("reviewer codex", { exact: true }).inputValue()).toBe("high");
  expect(await p.getByLabel("author claude", { exact: true }).inputValue()).toBe("default");
  await pickTier(p, "security");
  expect(await p.getByLabel("reviewer claude", { exact: true }).inputValue()).toBe("inherit");
  expect(await p.getByLabel("author codex", { exact: true }).locator('option[value="low"]').evaluate((o) => (o as unknown as { disabled: boolean }).disabled)).toBe(true);
  expect(await p.getByLabel("task tier", { exact: true }).locator('option[value="docs"]').innerText()).toContain("模板未注册");
  await p.screenshot({ path: resolve(out, "tier3g-security-1280.png"), fullPage: true });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("保存类型格：PUT 带 tier 与 rev，只带改了的格，按回包刷新", async () => {
  const v = await fixtureView();
  const saved = { ...v, rev: 4, tiers: { ...v.tiers, ui: { ...v.tiers.ui, reviewer: { claude: HAIKU } } } };
  const p = await pageWith(1280, v, () => ({ status: 200, json: saved }));
  await pickTier(p, "ui");
  await p.getByLabel("reviewer claude", { exact: true }).selectOption(HAIKU);
  await p.locator('[data-role="reviewer"]').getByRole("button", { name: "保存" }).click();
  await p.getByTestId("role-model-note").waitFor();
  expect(p.puts).toEqual([{ rev: 3, role: "reviewer", tier: "ui", claude: HAIKU }]);
  expect(await p.getByLabel("reviewer claude", { exact: true }).inputValue()).toBe(HAIKU);
  expect(await p.locator('[data-role="reviewer"] button').isDisabled()).toBe(true);
  await p.getByLabel("reviewer claude", { exact: true }).selectOption("default");
  expect(await p.locator('[data-role="reviewer"] button').isDisabled()).toBe(false);
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 2] 权限不足 / 400 校验失败：输入保留、原因可读", async () => {
  const v = await fixtureView();
  const cases: [Reply, string][] = [
    [{ status: 403, json: { ok: false, error: "only the owner's full-access device can view or change role model settings" } }, "没有改档位表的权限"],
    [{ status: 400, json: { ok: false, code: "invalid", error: "这次修改不符合档位约束，没有保存", reason: "security 的 author 不得低于 Opus（写的是 claude-sonnet-5-5）" } }, "不得低于 Opus"],
  ];
  for (const [reply, expected] of cases) {
    const p = await pageWith(1280, v, () => reply);
    await pickTier(p, "security");
    const row = p.locator('[data-role="author"]');
    await p.getByLabel("author claude", { exact: true }).selectOption(SONNET);
    await row.getByRole("button", { name: "保存" }).click();
    await row.getByRole("alert").waitFor();
    expect(await row.getByRole("alert").innerText()).toContain(expected);
    expect(await p.getByLabel("author claude", { exact: true }).inputValue()).toBe(SONNET);
    expect(await row.getByRole("button", { name: "保存" }).isDisabled()).toBe(false);
    expect(p.puts).toEqual([{ rev: 3, role: "author", tier: "security", claude: SONNET }]);
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("[验收线 2] 409：按现表刷新、提示可读，正在存的那一行输入保留并能按新 rev 再存", async () => {
  const v = await fixtureView();
  const current = { ...v, rev: 9, tiers: { ...v.tiers, code: { reviewer: { claude: OPUS, codex: "low" } } } };
  let n = 0;
  const p = await pageWith(1280, v, () => (n++ === 0
    ? { status: 409, json: { ok: false, code: "conflict", error: "这张表刚被别处改过，已刷新为最新值，请确认后再改", current } }
    : { status: 200, json: current }));
  await pickTier(p, "code");
  await p.getByLabel("reviewer claude", { exact: true }).selectOption(HAIKU);
  await p.locator('[data-role="reviewer"]').getByRole("button", { name: "保存" }).click();
  await p.getByTestId("role-model-note").waitFor();
  expect(await p.getByTestId("role-model-note").innerText()).toContain("别处改过");
  expect(await p.getByLabel("reviewer claude", { exact: true }).inputValue()).toBe(HAIKU); // 改过的格留草稿
  expect(await p.getByLabel("reviewer codex", { exact: true }).inputValue()).toBe("low"); // 没动的格跟现表
  await p.locator('[data-role="reviewer"]').getByRole("button", { name: "保存" }).click();
  await p.getByTestId("role-model-note").getByText("已保存").waitFor();
  expect(p.puts[1]).toEqual({ rev: 9, role: "reviewer", tier: "code", claude: HAIKU });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("[验收线 3] 390：类型选择、锁定提示、项目与有效值都不出横向滚动", async () => {
  const v = await fixtureView();
  v.projects = { ...v.projects, "a-very-long-project-identifier-without-any-breaks-at-all-0123456789": { mode: "observe" } };
  const p = await pageWith(390, v);
  for (const tier of ["", ...TASK_TIERS]) {
    await pickTier(p, tier);
    expect({ tier, ok: await noHScroll(p) }).toEqual({ tier, ok: true });
  }
  await pickTier(p, "security");
  await p.screenshot({ path: resolve(out, "tier3g-security-390.png"), fullPage: true });
  await p.close();
}, 30_000);

describe("直接调 API 被拒（隔离，不要浏览器）", () => {
  const at = "2026-10-01T00:00:00Z";
  const owner = effectivePrincipal({
    principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at },
    credential: { id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
      grant: { agents: ["*"], terminal: true, manage: true } },
  });
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "tier3g-api-"));
    dirs.push(dir);
    const path = join(dir, "roles.json");
    const api = makeRoleModelSettingsApi({ path, now: () => 42, log: () => undefined });
    const put = async (body: unknown, who = owner) => {
      const r = (await api(new Request("http://x/settings/role-models", { method: "PUT", body: JSON.stringify(body) }), "/settings/role-models", who))!;
      return { status: r.status, body: await r.json() as View };
    };
    return { path, put };
  }

  test("缩权设备 PUT 403 不写盘；security 低于 Opus 400 带原因不写盘；旧 rev 409 带现表", async () => {
    const s = setup();
    expect((await s.put({ rev: 0, role: "author", tier: "code", claude: SONNET }, { ...owner, manage: false })).status).toBe(403);
    expect(existsSync(s.path)).toBe(false);
    const bad = await s.put({ rev: 0, role: "author", tier: "security", claude: SONNET });
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid", reason: expect.stringContaining("不得低于 Opus") } });
    expect(existsSync(s.path)).toBe(false);
    expect((await s.put({ rev: 0, role: "author", tier: "code", claude: SONNET })).status).toBe(200);
    const stale = await s.put({ rev: 0, role: "author", tier: "ui", claude: HAIKU });
    expect(stale).toMatchObject({ status: 409, body: { code: "conflict", current: { rev: 1, tiers: { code: { author: { claude: SONNET } } } } } });
    expect(stale.body.current.effective.code.find((r: View) => r.role === "author").claude).toEqual({ value: SONNET, source: "tier-settings" });
  });
});
