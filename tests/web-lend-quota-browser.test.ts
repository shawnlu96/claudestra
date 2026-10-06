/**
 * LEND_QUOTA_BROWSER=1 bun test tests/web-lend-quota-browser.test.ts — 额度线设置块的真实浏览器渲染（390px），隔离夹具、不连真 bridge。
 * 覆盖：停接 / 未知 / 上次读数的显示、保存成功以回包刷新、保存失败原因可见且输入保留、坏配置提示、403 整块不渲染、窄屏无横向滚动。
 * 截图写到 .playwright-mcp/qline1/（已 gitignore，只私存）。有 web/.next 构建时用生产 Tailwind 样式。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const enabled = process.env.LEND_QUOTA_BROWSER === "1";
const out = resolve(".playwright-mcp/qline1");
let browser: Browser, server: Server, url: string;
const RESET = Date.parse("2026-10-09T01:41:00Z");
const fam = (family: string, over: Record<string, unknown>) => ({ family, warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: RESET, readAt: RESET - 86_400_000,
  freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 2, slots: 2, ...over });
const view = (over: Record<string, unknown> = {}) => ({ ok: true, config: { status: "ok", error: null, mode: "on" }, warnZoneApproved: false, at: RESET - 1,
  families: [fam("codex", { weekUsedPct: 82, state: "stop", limit: "zero", wouldLimit: "zero", slots: 0 }),
    fam("claude", { weekUsedPct: null, resetAt: null, readAt: null, freshness: null, state: "unknown" })], ...over });
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { LendQuotaSettings } from "../../features/lend/lend-quota-settings";
createRoot(document.getElementById("root")).render(<div style={{ padding: 16 }}><section className="space-y-3 rounded-xl bg-base-200/60 p-4"><LendQuotaSettings /></section></div>);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/qline-fixture/fixture.tsx");
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
      const links = [...assets.keys()].filter((x) => x.endsWith(".css")).map((x) => `<link rel="stylesheet" href="${x}">`).join("");
      res.setHeader("Content-Type", "text/html");
      return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>${productionCss}</style></head>
        <body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
    }
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

async function pageWith(get: { status: number; json: unknown }, post?: (body: unknown) => { status: number; json: unknown }): Promise<Page & { posts: unknown[] }> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }) as Page & { posts: unknown[] };
  page.posts = [];
  await page.route("**/api/v1/lend/quota-lines", async (route) => {
    if (route.request().method() === "GET") return route.fulfill(get);
    const body = route.request().postDataJSON();
    page.posts.push(body);
    return route.fulfill(post ? post(body) : { status: 500, json: { ok: false, error: "x" } });
  });
  await page.goto(url);
  return page;
}
const noHScroll = (p: Page) => p.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth");

test.skipIf(!enabled)("停接 / 未知显示、窄屏不横滚", async () => {
  const p = await pageWith({ status: 200, json: view() });
  await p.getByTestId("lend-quota-settings").waitFor();
  expect(await p.locator('[data-family="codex"] [data-state="stop"]').innerText()).toBe("已停接");
  expect(await p.locator('[data-family="claude"] [data-state="unknown"]').innerText()).toBe("用量未知");
  expect(await p.locator('[data-family="claude"]').innerText()).toContain("未知");
  expect(await p.locator('[data-family="claude"]').innerText()).not.toContain("0%");
  expect(await noHScroll(p)).toBe(true);
  await p.screenshot({ path: resolve(out, "qline1-390-stop-unknown.png"), fullPage: true });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("保存成功：只带这一族，按回包刷新", async () => {
  const saved = view({ families: [fam("codex", { warnPct: 85, stopPct: 90, weekUsedPct: 82, state: "warn" }), fam("claude", {})] });
  const p = await pageWith({ status: 200, json: view() }, () => ({ status: 200, json: saved }));
  const row = p.locator('[data-family="codex"]');
  await row.locator("input").nth(0).fill("85");
  await row.locator("input").nth(1).fill("90");
  await row.getByRole("button", { name: "保存" }).click();
  await p.locator('[data-family="codex"] [data-state="warn"]').waitFor();
  expect(p.posts).toEqual([{ family: "codex", warnPct: 85, stopPct: 90 }]);
  await p.screenshot({ path: resolve(out, "qline1-390-saved.png"), fullPage: true });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("保存失败：原因可见、输入保留；非法输入不能提交", async () => {
  const p = await pageWith({ status: 200, json: view() }, () => ({ status: 503, json: { ok: false, error: "额度线配置正被别的请求修改，稍后再试" } }));
  const row = p.locator('[data-family="claude"]');
  await row.locator("input").nth(0).fill("90");
  expect(await row.getByRole("button", { name: "保存" }).isDisabled()).toBe(true);
  expect(await row.innerText()).toContain("提醒线要低于停接线");
  await row.locator("input").nth(0).fill("60");
  await row.getByRole("button", { name: "保存" }).click();
  await row.getByRole("alert").waitFor();
  expect(await row.getByRole("alert").innerText()).toContain("稍后再试");
  expect(await row.locator("input").nth(0).inputValue()).toBe("60");
  await p.screenshot({ path: resolve(out, "qline1-390-save-failed.png"), fullPage: true });
  await p.close();
}, 30_000);

test.skipIf(!enabled)("坏配置提示；403 整块不渲染；读失败可见", async () => {
  const bad = await pageWith({ status: 200, json: view({ config: { status: "invalid", error: "JSON 解析失败", mode: "on" } }) });
  await bad.getByTestId("lend-quota-settings").waitFor();
  expect(await bad.getByTestId("lend-quota-settings").innerText()).toContain("配置文件损坏");
  await bad.screenshot({ path: resolve(out, "qline1-390-invalid.png"), fullPage: true });
  await bad.close();
  const denied = await pageWith({ status: 403, json: { ok: false, error: "forbidden" } });
  await denied.waitForTimeout(500);
  expect(await denied.getByTestId("lend-quota-settings").count()).toBe(0);
  await denied.close();
  const down = await pageWith({ status: 500, json: { ok: false, error: "bridge 炸了" } });
  await down.getByRole("alert").waitFor();
  expect(await down.getByRole("alert").innerText()).toContain("加载失败");
  await down.close();
}, 30_000);
