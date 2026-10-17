/** CARD_MODEL_BROWSER=1 bun test tests/role-model-settings-browser.test.ts
 * Isolated settings pages, real production CSS, fake API data from the real resolver.
 * CARD_MODEL_BASE=1 runs the screenshot fixture against the origin/main worktree.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { makeRoleModelSettingsApi } from "../src/bridge/local-api/role-model-settings.js";
import { defaultRoleModels } from "../src/lib/role-model-settings.js";
import type { Principal } from "../src/lib/principals.js";

const enabled = process.env.CARD_MODEL_BROWSER === "1" || process.env.ROLE_MODEL_BROWSER === "1";
const base = process.env.CARD_MODEL_BASE === "1";
const out = resolve(process.env.CARD_MODEL_SHOTS ?? "ui-shots");
const scratch = resolve(".playwright-mcp/card-model");
let browser: Browser, server: Server, url: string;
const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-10-01", terminal: true };

async function view(mode: "on" | "off" | "observe" = "on", ultra = false) {
  const table = defaultRoleModels();
  table.rev = 2;
  table.roles.reviewer.codex = ultra ? "ultra" : "high";
  table.tiers = { code: { reviewer: { claude: "claude-sonnet-5-5" } } };
  const path = resolve(scratch, "test-settings.json");
  writeFileSync(path, JSON.stringify(table));
  const api = makeRoleModelSettingsApi({ path, policy: () => ({ mode, manualAfterMs: null, source: "config" }) });
  return (await (await api(new Request("http://x/settings/role-models"), "/settings/role-models", OWNER))!.json()) as Record<string, any>;
}
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPage } from "../../features/chat/components/settings/pages";
import { SettingsNav, settingsPagesFor } from "../../features/chat/components/settings/nav";
import { setLang } from "../../lib/i18n";
if (location.hash === "#en") setLang("en");
const modelOptions = [{ value: "claude-opus-5-5", label: "Opus 5.5" }, { value: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { value: "claude-haiku-5-5", label: "Haiku 5.5" }];
const defaults = { gModel: "claude-opus-5-5", setGModel() {}, gEffort: "high", setGEffort() {}, gLoaded: true, gMsg: "", saveGlobalDefault: async () => {} };
function App() {
 const [page, setPage] = useState(${JSON.stringify(base ? "claude" : "card-models")});
 return <main className="p-3"><div className="mb-3 text-base font-semibold">${base ? "设置" : "设置"}</div>
 <div className="flex min-w-0 flex-col sm:flex-row"><SettingsNav page={page} pages={settingsPagesFor(true)} onSelect={setPage} />
 <div className="min-w-0 flex-1 space-y-3 p-3"><SettingsPage page={page} s={{ full:true, modelOptions, defaults }} /></div></div></main>;
}
createRoot(document.getElementById("root")).render(<App />);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true }); mkdirSync(scratch, { recursive: true });
  const entry = resolve("web/.next/card-model-fixture/fixture.tsx");
  await Bun.write(entry, fixture);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--define", "process.env={}", "--outdir", scratch], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(build.stderr).text();
  if (await build.exited) throw new Error(error);
  unlinkSync(entry);
  // Compile the repository's actual Tailwind/daisyUI stylesheet, scanning actual sources.
  const cssRun = Bun.spawn([process.execPath, "-e", `import postcss from 'postcss'; import tailwind from '@tailwindcss/postcss';
    const p = process.cwd() + '/app/globals.css'; const css = await Bun.file(p).text();
    const out = await postcss([tailwind()]).process(css, { from:p }); await Bun.write(${JSON.stringify(resolve(scratch, "style.css"))}, out.css);`],
    { cwd: resolve("web"), stdout: "pipe", stderr: "pipe" });
  const cssError = await new Response(cssRun.stderr).text();
  if (await cssRun.exited) throw new Error(cssError);
  server = createServer(async (req, res) => {
    const file = req.url === "/fixture.js" ? "fixture.js" : req.url === "/style.css" ? "style.css" : null;
    if (file) { res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript"); return res.end(readFileSync(resolve(scratch, file))); }
    if (req.url === "/app-config.json") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ mode: "direct", fp: "test" })); }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>' +
      '<body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });

type Reply = { status: number; json: unknown };
async function pageWith(width: number, data: Record<string, any>, put?: (body: any) => Reply, hash = "", getStatus = 200) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
  page.on("pageerror", (error) => console.error("Fixture error:", error.message));
  const puts: unknown[] = [];
  await page.route("**/api/v1/settings/role-models", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: getStatus, json: data });
    const body = route.request().postDataJSON(); puts.push(body);
    return route.fulfill(put ? put(body) : { status: 500, json: { error: "保存失败" } });
  });
  await page.goto(url + hash);
  if (getStatus === 200) {
    await page.getByTestId(base ? "role-model-settings" : "card-model-settings").waitFor();
    await page.locator("select:visible").last().waitFor();
  } else if (getStatus === 403) {
    await page.getByTestId("card-model-settings").waitFor({ state: "detached" });
  } else await page.getByRole("alert").waitFor();
  return { page, puts };
}
const cell = (p: Page, key: string) => p.locator(`[data-cell="${key}"]:visible`);
const select = (p: Page, key: string) => cell(p, key).locator("select");
const save = (p: Page) => p.getByRole("button", { name: "保存", exact: true });

test.skipIf(!enabled)("1440 / 390：真实设置页前后截图，无手机横向溢出", async () => {
  const data = await view("observe");
  for (const width of [1440, 390]) {
    const { page } = await pageWith(width, data);
    if (!base) {
      expect(await cell(page, "docs:author:claude").innerText()).toContain("Haiku 5.5");
      expect(await cell(page, "docs:author:claude").innerText()).toContain("产品默认");
      expect(await cell(page, "code:reviewer:claude").innerText()).toContain("本页设置");
      expect(await page.getByTestId("card-model-switches").innerText()).toContain("只记录，不改启动参数");
    }
    if (width === 390) expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await page.screenshot({ path: resolve(out, `${base ? "before" : "after"}-settings-${width}x${width === 390 ? 844 : 900}.png`), fullPage: true });
    await page.close();
  }
}, 30_000);

test.skipIf(!enabled || base)("新页导航、Claude 页移除、无角色英文 id、英文完整", async () => {
  const { page } = await pageWith(1440, await view());
  expect(await page.getByRole("button", { name: "卡片模型", exact: true }).getAttribute("aria-current")).toBe("page");
  const text = await page.getByTestId("card-model-settings").innerText();
  for (const id of ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"]) expect(text).not.toContain(id);
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  expect(await page.getByTestId("card-model-settings").count()).toBe(0);
  expect(await page.getByTestId("role-model-settings").count()).toBe(0);
  await page.close();
  const en = (await pageWith(390, await view("observe"), undefined, "#en")).page;
  expect(await en.getByRole("button", { name: "Card models", exact: true }).count()).toBe(1);
  expect(await en.getByTestId("card-model-settings").innerText()).not.toMatch(/\p{Script=Han}/u);
  await en.close();
}, 30_000);

test.skipIf(!enabled || base)("全页一次批量保存；失败保留草稿；409 按现表刷新", async () => {
  const data = await view();
  const { page, puts } = await pageWith(1440, data, () => ({ status: 200, json: { ...data, rev: 3 } }));
  await select(page, "docs:author:claude").selectOption("claude-opus-5-5");
  await select(page, "ui:reviewer:codex").selectOption("xhigh");
  await select(page, "undeclared:author:codex").selectOption("high");
  expect(await save(page).count()).toBe(1);
  await save(page).click(); await page.getByTestId("card-model-note").waitFor();
  expect(puts).toEqual([{ rev: 2, changes: [
    { role: "reviewer", tier: "ui", codex: "xhigh" }, { role: "author", tier: "docs", claude: "claude-opus-5-5" }, { role: "author", codex: "high" },
  ] }]);
  expect(await save(page).isDisabled()).toBe(true); await page.close();
  for (const conflict of [false, true]) {
    const current = await view(); current.roles[0].codex = "max"; current.rev = 8;
    const { page } = await pageWith(390, data, () => conflict ? { status: 409, json: { current } } : { status: 400, json: { reason: "security 的作者不得低于 Opus" } });
    await select(page, "security:author:claude").selectOption("claude-haiku-5-5");
    expect(await page.getByText("安全下限：Claude 至少 Opus；Codex 只能跟随原档。").count()).toBe(1);
    await save(page).click();
    if (conflict) {
      await page.getByTestId("card-model-note").waitFor();
      expect(await page.getByTestId("card-model-note").innerText()).toContain("别处先改了");
      expect(await select(page, "undeclared:author:codex").inputValue()).toBe("max");
    } else {
      await page.getByRole("alert").waitFor();
      expect(await select(page, "security:author:claude").inputValue()).toBe("claude-haiku-5-5");
    }
    await page.close();
  }
}, 30_000);

test.skipIf(!enabled || base)("off 格置灰禁用；ultra 只显示现存值与警示，不提供选项", async () => {
  const { page } = await pageWith(390, await view("off", true));
  expect(await select(page, "docs:author:claude").isDisabled()).toBe(true);
  expect(await cell(page, "docs:author:claude").locator("..").getAttribute("class")).toContain("opacity-50");
  expect(await select(page, "undeclared:reviewer:codex").isDisabled()).toBe(true);
  expect(await page.locator('select option[value="ultra"]').count()).toBe(0);
  expect(await cell(page, "undeclared:reviewer:codex").innerText()).toContain("会自动派子 agent");
  await page.close();
}, 30_000);


test.skipIf(!enabled || base)("坏配置提示、403 隐藏、加载失败；英文校验错误不泄露角色 id", async () => {
  const data = await view();
  const bad = (await pageWith(390, { ...data, config: { status: "invalid", error: "config_invalid" } })).page;
  expect(await bad.getByRole("alert").innerText()).toContain("内容不合法"); await bad.close();
  const denied = (await pageWith(390, {}, undefined, "", 403)).page;
  expect(await denied.getByTestId("card-model-settings").count()).toBe(0); await denied.close();
  const down = (await pageWith(390, {}, undefined, "", 500)).page;
  expect(await down.getByRole("alert").innerText()).toContain("加载失败"); await down.close();
  const en = (await pageWith(390, data, () => ({ status: 400, json: { reason: "合并后的表不合法：security 的 adversarial-reviewer 不得低于 Opus" } }), "#en")).page;
  await select(en, "security:adversarial-reviewer:claude").selectOption("claude-haiku-5-5");
  await en.getByRole("button", { name: "Save", exact: true }).click();
  await en.getByRole("alert").waitFor();
  const text = await en.getByRole("alert").innerText();
  expect(text).toContain("Security"); expect(text).toContain("Adversarial reviewer");
  expect(text).not.toMatch(/\p{Script=Han}/u); expect(text).not.toContain("adversarial-reviewer");
  await en.close();
}, 30_000);
