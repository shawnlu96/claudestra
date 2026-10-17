/**
 * ROLE_MODEL_BROWSER=1 bun test tests/role-model-settings-browser.test.ts — 模型档位表设置块的真实浏览器渲染，隔离夹具、假 bridge（只拦
 * /api/v1/settings/role-models 与 /api/v1/settings/claude-defaults），不连真服务，浅色。
 * 覆盖：1280 角色 × 家族表与当前值、390 无横向滚动、保存成功按回包刷新（只带改了的格 + rev）、保存失败原因可见且草稿保留、409 按现表刷新、
 * 坏配置提示、403 整块不渲染。改前图 = 同一页只有「Claude 全局默认」一节。截图写到 .playwright-mcp/tier1/（已 gitignore，只私存）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const enabled = process.env.ROLE_MODEL_BROWSER === "1";
const out = resolve(".playwright-mcp/tier1");
let browser: Browser, server: Server, url: string;
const ROLES = ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const view = (over: Record<string, unknown> = {}, rows: Record<string, { claude?: string; codex?: string | null }> = {}) => ({
  ok: true, config: { status: "missing", error: null }, rev: 0, families: ["claude", "codex"], codexEfforts: EFFORTS,
  roles: ROLES.map((role) => ({ role, claude: "claude-opus-5-5", codex: null, ...rows[role] })), ...over });
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ClaudeDefaultsSection } from "../../features/chat/components/settings/claude-defaults-section";
import { RoleModelSettingsSection } from "../../features/chat/components/settings/role-model-settings-section";
const models = [{ value: "claude-opus-5-5", label: "Opus 5.5" }, { value: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { value: "claude-haiku-5-5", label: "Haiku 5.5" }];
const defaults = { gModel: "claude-opus-5-5", setGModel() {}, gEffort: "high", setGEffort() {}, gLoaded: true, gMsg: "", saveGlobalDefault: async () => {} };
const after = location.hash !== "#before";
createRoot(document.getElementById("root")).render(<div className="space-y-3 px-5 pb-5 pt-3">
  <ClaudeDefaultsSection defaults={defaults} modelOptions={models} />{after && <RoleModelSettingsSection modelOptions={models} />}</div>);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/tier1-fixture/fixture.tsx");
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
      // 生产样式走 <link>：整段内联进 <style> 时浏览器只解析了前面一部分规则（sm: 断点等全丢）
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
async function pageWith(width: number, get: Reply, put?: (body: unknown) => Reply, hash = ""): Promise<Page & { puts: unknown[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } }) as Page & { puts: unknown[] };
  page.puts = [];
  await page.route("**/api/v1/settings/role-models", async (route) => {
    if (route.request().method() === "GET") return route.fulfill(get);
    const body = route.request().postDataJSON();
    page.puts.push(body);
    return route.fulfill(put ? put(body) : { status: 500, json: { ok: false, error: "x" } });
  });
  await page.goto(url + hash);
  return page;
}
const noHScroll = (p: Page) => p.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const shot = (p: Page, name: string) => p.screenshot({ path: resolve(out, name), fullPage: true });

test.skipIf(!enabled)("改前：同一页只有 Claude 全局默认（1280 / 390）", async () => {
  for (const w of [1280, 390]) {
    const p = await pageWith(w, { status: 200, json: view() }, undefined, "#before");
    await p.getByText("Claude 全局默认").waitFor();
    expect(await p.getByTestId("role-model-settings").count()).toBe(0);
    await shot(p, `tier1-before-${w}.png`);
    await p.close();
  }
}, 30_000);

test.skipIf(!enabled)("1280：角色 × 家族表与当前值", async () => {
  const p = await pageWith(1280, { status: 200, json: view({ rev: 2 }, { reviewer: { codex: "xhigh" } }) });
  await p.getByTestId("role-model-settings").waitFor();
  expect(await p.locator("[data-role]").count()).toBe(4);
  expect(await p.locator('[data-role="author"] select').nth(0).inputValue()).toBe("claude-opus-5-5");
  expect(await p.locator('[data-role="reviewer"] select').nth(1).inputValue()).toBe("xhigh");
  expect(await p.locator('[data-role="author"] select').nth(1).inputValue()).toBe("");
  expect(await p.getByTestId("role-model-settings").innerText()).toContain("照 Codex 配置");
  for (const r of ROLES) expect(await p.locator(`[data-role="${r}"] button`).isDisabled()).toBe(true); // 没改不能存
  await shot(p, "tier1-after-1280.png");
  await p.close();
}, 30_000);

test.skipIf(!enabled)("390：没有横向滚动", async () => {
  const p = await pageWith(390, { status: 200, json: view() });
  await p.getByTestId("role-model-settings").waitFor();
  expect(await noHScroll(p)).toBe(true);
  await shot(p, "tier1-after-390.png");
  await p.close();
}, 30_000);

test.skipIf(!enabled)("保存成功：只带改了的格和 rev，按回包刷新", async () => {
  const saved = view({ rev: 1 }, { author: { claude: "claude-sonnet-5-5" } });
  const p = await pageWith(1280, { status: 200, json: view() }, () => ({ status: 200, json: saved }));
  const row = p.locator('[data-role="author"]');
  await row.locator("select").nth(0).selectOption("claude-sonnet-5-5");
  await row.getByRole("button", { name: "保存" }).click();
  await p.getByTestId("role-model-note").waitFor();
  expect(p.puts).toEqual([{ rev: 0, role: "author", claude: "claude-sonnet-5-5" }]);
  expect(await p.getByTestId("role-model-note").innerText()).toContain("已保存");
  expect(await p.locator('[data-role="author"] select').nth(0).inputValue()).toBe("claude-sonnet-5-5");
  expect(await p.locator('[data-role="author"] button').isDisabled()).toBe(true);
  await shot(p, "tier1-after-1280-saved.png");
  await p.close();
}, 30_000);

test.skipIf(!enabled)("保存失败：原因可见、草稿保留", async () => {
  const p = await pageWith(1280, { status: 200, json: view() },
    () => ({ status: 503, json: { ok: false, code: "busy", error: "模型档位表正被别的请求修改，稍后再试" } }));
  const row = p.locator('[data-role="pm-reviewer"]');
  await row.locator("select").nth(1).selectOption("high");
  await row.getByRole("button", { name: "保存" }).click();
  await row.getByRole("alert").waitFor();
  expect(await row.getByRole("alert").innerText()).toContain("稍后再试");
  expect(await row.locator("select").nth(1).inputValue()).toBe("high");
  expect(p.puts).toEqual([{ rev: 0, role: "pm-reviewer", codex: "high" }]);
  await shot(p, "tier1-after-1280-save-failed.png");
  await p.close();
}, 30_000);

test.skipIf(!enabled)("409：按回包里的现表刷新并提示，改过的格留草稿（TIER3g）", async () => {
  const current = view({ rev: 5 }, { reviewer: { claude: "claude-haiku-5-5" } });
  const p = await pageWith(1280, { status: 200, json: view() },
    () => ({ status: 409, json: { ok: false, code: "conflict", error: "这张表刚被别处改过，已刷新为最新值，请确认后再改", current } }));
  await p.locator('[data-role="reviewer"] select').nth(1).selectOption("low");
  await p.locator('[data-role="reviewer"]').getByRole("button", { name: "保存" }).click();
  await p.getByTestId("role-model-note").waitFor();
  expect(await p.getByTestId("role-model-note").innerText()).toContain("别处改过");
  expect(await p.locator('[data-role="reviewer"] select').nth(0).inputValue()).toBe("claude-haiku-5-5");
  expect(await p.locator('[data-role="reviewer"] select').nth(1).inputValue()).toBe("low"); // 改过的格留草稿，没动的 Claude 列跟现表
  await p.close();
}, 30_000);

test.skipIf(!enabled)("坏配置提示；guest / 403 整块不渲染；读失败可见", async () => {
  const bad = await pageWith(390, { status: 200, json: view({ config: { status: "invalid", error: "config_invalid" } }) });
  await bad.getByTestId("role-model-settings").waitFor();
  expect(await bad.getByTestId("role-model-settings").innerText()).toContain("内容不合法");
  await bad.close();
  const denied = await pageWith(390, { status: 403, json: { ok: false, error: "forbidden" } });
  await denied.getByText("Claude 全局默认").waitFor();
  await denied.waitForTimeout(500);
  expect(await denied.getByTestId("role-model-settings").count()).toBe(0);
  expect(await denied.getByText("角色模型档位").count()).toBe(0);
  await denied.close();
  const down = await pageWith(390, { status: 500, json: { ok: false, error: "bridge 炸了" } });
  await down.getByRole("alert").waitFor();
  expect(await down.getByRole("alert").innerText()).toContain("加载失败");
  await down.close();
}, 30_000);
