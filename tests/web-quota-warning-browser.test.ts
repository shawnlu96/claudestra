/**
 * QWARN1_BROWSER=1 bun test tests/web-quota-warning-browser.test.ts — 顶部额度提醒条的真实浏览器渲染（390px + 桌面），隔离夹具、不连真 bridge。
 * 页面骨架模拟聊天页（56px 顶栏 + 对话 + 底部输入框），挂的是真组件 QuotaWarningBanner，GET /api/v1/lend/quota-lines 由路由按场景回。
 * 覆盖：停接 + 提醒两族同时、unknown 不出、403 / 404 不出且不再拉、只读（零写请求）、关掉后刷新不再出、跨新线（提醒→停接）再出、
 * 跨 tab 同步关掉、英文与本地时区、移动端不遮输入框；读到后 401 清空、存储写不进时两族先后关掉都生效、慢的旧回包不覆盖新状态、portal 到 body。截图写到 .playwright-mcp/qwarn1/（已 gitignore，只私存）；有 web/.next 构建时用生产样式。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const enabled = process.env.QWARN1_BROWSER === "1";
const out = resolve(".playwright-mcp/qwarn1");
let browser: Browser, server: Server, url: string;
const RESET = Date.parse("2026-10-09T01:41:00Z");
const fam = (family: string, over: Record<string, unknown>) => ({ family, warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: RESET, observedAt: RESET - 86_400_000,
  source: "live", freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2, ...over });
const UNKNOWN = { weekUsedPct: null, resetAt: null, observedAt: null, source: null, freshness: null, state: "unknown", available: null, slots: null };
const STOP = { weekUsedPct: 82, state: "stop", limit: "zero", wouldLimit: "zero", slots: 0 };
const WARN = { weekUsedPct: 74, state: "warn", limit: "half", wouldLimit: "half", slots: 1 };
const view = (codex: Record<string, unknown>, claude: Record<string, unknown>, mode = "on") =>
  ({ ok: true, config: { status: "ok", error: null, mode }, at: RESET - 2 * 86_400_000, families: [fam("codex", codex), fam("claude", claude)] });

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nInit } from "../../lib/i18n";
import { QuotaWarningBanner } from "../../features/lend/quota-warning-banner";
const msgs = Array.from({ length: 30 }, (_, i) => i);
createRoot(document.getElementById("root")).render(
  <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <I18nInit />
    <header style={{ height: 56, flexShrink: 0 }} className="flex items-center border-b border-base-300 px-4 font-semibold">chat</header>
    <main style={{ flex: 1, overflow: "auto" }} className="space-y-2 p-4">{msgs.map((i) => <div key={i} className="rounded-xl bg-base-200 p-3 text-sm">message {i}</div>)}</main>
    <footer data-testid="input" style={{ flexShrink: 0 }} className="border-t border-base-300 p-3"><textarea className="textarea textarea-bordered w-full" rows={2} defaultValue="" /></footer>
    <QuotaWarningBanner />
  </div>);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/qwarn-fixture/fixture.tsx");
  await Bun.write(entry, fixture);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]); unlinkSync(entry);
  if (code) throw new Error(error);
  const assets = new Map(readdirSync(out).filter((name) => /\.(js|css)$/.test(name)).map((name) => ["/" + name, Bun.file(resolve(out, name))]));
  let productionCss = "";
  for (const dir of ["web/.next/static/css", "web/.next/static/chunks"]) { // Next 版本不同，CSS 落在 css/ 或 chunks/
    try { for (const name of readdirSync(resolve(dir))) if (name.endsWith(".css")) productionCss += await Bun.file(resolve(dir, name)).text(); }
    catch { /* 没有 Next 构建时只缺样式，功能断言照跑 */ }
  }
  server = createServer(async (req, res) => {
    if (req.url === "/") {
      const links = [...assets.keys()].filter((x) => x.endsWith(".css")).map((x) => `<link rel="stylesheet" href="${x}">`).join("");
      res.setHeader("Content-Type", "text/html");
      return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>${productionCss}</style></head>
        <body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
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
}, 120_000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });

/** 一个浏览器上下文 = 一台设备（localStorage 共享）；reply 可在测试中途换（模拟 bridge 状态变化），gets / writes 计数 */
interface Device { ctx: BrowserContext; reply: { status: number; json: unknown }; hold: Promise<void> | null; gets: number; writes: string[]; open: () => Promise<Page> }
async function device(reply: Device["reply"], opts: { width?: number; height?: number; locale?: string; timezoneId?: string } = {}): Promise<Device> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 390, height: opts.height ?? 844 }, locale: opts.locale ?? "zh-CN", timezoneId: opts.timezoneId ?? "Asia/Shanghai" });
  const d: Device = { ctx, reply, hold: null, gets: 0, writes: [], open: async () => { const p = await ctx.newPage(); await p.goto(url); return p; } };
  await ctx.route("**/api/v1/**", async (route) => {
    const r = route.request();
    if (r.method() !== "GET") { d.writes.push(`${r.method()} ${r.url()}`); return route.fulfill({ status: 500, json: {} }); }
    if (r.url().endsWith("/api/v1/lend/quota-lines")) {
      d.gets++;
      const reply = d.reply, hold = d.hold; // 发出时的回包；hold 在时先暂挂（模拟慢请求）
      if (hold) await hold;
      return route.fulfill(reply);
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return d;
}
const bar = (p: Page, family: string) => p.locator(`[data-quota-warning="${family}"]`);
const settle = (p: Page) => p.waitForTimeout(600);

test.skipIf(!enabled)("停接 + 提醒两族同时、只读、移动端不遮输入框", async () => {
  const d = await device({ status: 200, json: view(STOP, WARN) });
  const p = await d.open();
  await bar(p, "codex").waitFor();
  const codex = await bar(p, "codex").innerText();
  expect(codex).toContain("Codex 本周已用 82%，达到停接线");
  expect(codex).toContain("已停止接新单，在跑的单照常做完");
  expect(codex).toContain("重置 10/9 09:41"); // Asia/Shanghai 本地时区
  expect(await bar(p, "codex").getAttribute("data-level")).toBe("stop");
  const claude = await bar(p, "claude").innerText();
  expect(claude).toContain("Claude 本周已用 74%，达到提醒线");
  expect(claude).toContain("未停接，新单名额已减半");
  const banner = (await p.getByTestId("quota-warning").boundingBox())!;
  const input = (await p.getByTestId("input").boundingBox())!;
  expect(banner.y).toBeGreaterThanOrEqual(56); // 顶栏下方
  expect(banner.y + banner.height).toBeLessThan(input.y); // 不遮输入框
  expect(await p.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
  await p.screenshot({ path: resolve(out, "qwarn1-390-stop-warn.png") });
  expect(d.writes).toEqual([]);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("unknown 不出肯定提醒；另一族照出", async () => {
  const d = await device({ status: 200, json: view(UNKNOWN, STOP) });
  const p = await d.open();
  await bar(p, "claude").waitFor();
  expect(await bar(p, "codex").count()).toBe(0);
  expect(await p.getByTestId("quota-warning").innerText()).not.toContain("0%");
  await p.screenshot({ path: resolve(out, "qwarn1-390-unknown-codex.png") });
  d.reply = { status: 200, json: view(UNKNOWN, UNKNOWN) };
  await p.reload(); await settle(p);
  expect(await p.getByTestId("quota-warning").count()).toBe(0);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("403 / 404（缩权 / 老 bridge）：不显示，且这页不再拉", async () => {
  for (const status of [403, 404]) {
    const d = await device({ status, json: { ok: false, error: "forbidden" } });
    const p = await d.open(); await settle(p);
    expect(await p.getByTestId("quota-warning").count()).toBe(0);
    const gets = d.gets;
    await p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`); await settle(p);
    expect(d.gets).toBe(gets);
    await d.ctx.close();
  }
}, 30_000);

test.skipIf(!enabled)("关掉：刷新后同一条线不再出；跨新线（提醒→停接）再出；跨 tab 同步", async () => {
  const d = await device({ status: 200, json: view({}, WARN) });
  const a = await d.open();
  const b = await d.open();
  await bar(a, "claude").waitFor(); await bar(b, "claude").waitFor();
  await bar(a, "claude").getByRole("button", { name: "关闭" }).click();
  expect(await bar(a, "claude").count()).toBe(0);
  await bar(b, "claude").waitFor({ state: "detached" }); // 另一个 tab 经 storage 事件收起
  d.reply = { status: 200, json: view({}, { ...WARN, weekUsedPct: 78 }) }; // 仍在提醒区
  await a.reload(); await settle(a);
  expect(await bar(a, "claude").count()).toBe(0);
  await a.screenshot({ path: resolve(out, "qwarn1-390-dismissed.png") });
  d.reply = { status: 200, json: view({}, { ...STOP, weekUsedPct: 81 }) }; // 跨过停接线
  await a.reload();
  await bar(a, "claude").waitFor();
  expect(await bar(a, "claude").innerText()).toContain("已停止接新单");
  await a.screenshot({ path: resolve(out, "qwarn1-390-dismiss-then-stop.png") });
  expect(d.writes).toEqual([]);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("桌面 + 英文 + 只观察 + 上次读数", async () => {
  const observe = view({ ...STOP, limit: "none", mode: "observe", freshness: "last_known", source: "live_stale" }, { ...WARN, limit: "none", mode: "observe" }, "observe");
  const d = await device({ status: 200, json: observe }, { width: 1280, height: 800, locale: "en-US", timezoneId: "America/New_York" });
  const p = await d.ctx.newPage();
  await p.addInitScript('localStorage.setItem("cstra_lang", "en")');
  await p.goto(url);
  await bar(p, "codex").waitFor();
  await p.waitForFunction(`document.querySelector('[data-quota-warning="codex"]')?.textContent?.includes("this week")`);
  const codex = await bar(p, "codex").innerText();
  expect(codex).toContain("Codex used 82% this week — stop line reached");
  expect(codex).toContain("Observe only: still accepting new orders");
  expect(codex).toContain("Last known reading");
  expect(codex).toMatch(/Resets 10\/8,? 21:41/); // America/New_York 本地时区
  expect(await bar(p, "claude").innerText()).toContain("Observe only: still accepting, slots unchanged");
  await p.screenshot({ path: resolve(out, "qwarn1-desktop-en-observe.png") });
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("桌面 · 中文两族", async () => {
  const d = await device({ status: 200, json: view(STOP, WARN) }, { width: 1280, height: 800 });
  const p = await d.open();
  await bar(p, "claude").waitFor();
  await p.screenshot({ path: resolve(out, "qwarn1-desktop-stop-warn.png") });
  await d.ctx.close();
}, 30_000);

const visible = (p: Page) => p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);

test.skipIf(!enabled)("先读到提醒、再 401（凭据失效）：已显示的读数清掉，且不再拉；横幅 portal 在 body 下", async () => {
  const d = await device({ status: 200, json: view(STOP, WARN) });
  const p = await d.open();
  await bar(p, "codex").waitFor();
  expect(await p.evaluate<boolean>(`document.querySelector('[data-testid="quota-warning"]').parentElement === document.body`)).toBe(true);
  d.reply = { status: 401, json: { ok: false, error: "unauthorized" } };
  await visible(p); await settle(p);
  expect(await p.getByTestId("quota-warning").count()).toBe(0);
  const gets = d.gets;
  d.reply = { status: 200, json: view(STOP, WARN) };
  await visible(p); await settle(p);
  expect(d.gets).toBe(gets);
  expect(await p.getByTestId("quota-warning").count()).toBe(0);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("存储写不进（QuotaExceeded）：两族先后关掉，前一族不会被后一次关掉抹回来", async () => {
  const d = await device({ status: 200, json: view(WARN, WARN) });
  await d.ctx.addInitScript(`{ const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "cstra_quota_warning_dismissed") throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); }; }`);
  const p = await d.open();
  await bar(p, "codex").waitFor(); await bar(p, "claude").waitFor();
  await bar(p, "codex").getByRole("button", { name: "关闭" }).click();
  expect(await bar(p, "codex").count()).toBe(0);
  await bar(p, "claude").getByRole("button", { name: "关闭" }).click();
  expect(await bar(p, "claude").count()).toBe(0);
  expect(await bar(p, "codex").count()).toBe(0);
  await visible(p); await settle(p); // 同一条线再读一次也不再出
  expect(await p.getByTestId("quota-warning").count()).toBe(0);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("回包乱序：慢的旧 GET（提醒）晚到，不覆盖已显示的新状态（停接）", async () => {
  const d = await device({ status: 200, json: view({}, WARN) });
  const p = await d.open();
  await bar(p, "claude").waitFor();
  let release!: () => void;
  d.hold = new Promise<void>((done) => { release = done; });
  await visible(p); // 旧请求：回提醒，暂挂
  await p.waitForTimeout(200);
  d.hold = null;
  d.reply = { status: 200, json: view({}, { ...STOP, weekUsedPct: 81 }) };
  await visible(p); // 新请求：回停接
  await p.waitForFunction(`document.querySelector('[data-quota-warning="claude"]')?.dataset.level === "stop"`);
  release(); await settle(p);
  expect(await bar(p, "claude").getAttribute("data-level")).toBe("stop");
  expect(await bar(p, "claude").innerText()).toContain("已停止接新单");
  await d.ctx.close();
}, 30_000);
