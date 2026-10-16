/**
 * QWARN1_BROWSER=1 bun test tests/web-quota-warning-browser.test.ts — 顶部额度卡里「提醒线 / 不再接新活」两种行的真实浏览器渲染（390px + 桌面），隔离夹具、不连真 bridge。
 * 页面骨架模拟聊天页（56px 顶栏 + 对话 + 底部输入框），挂的是真组件 QuotaNotice（QUOTA1 起额度提醒条并进这张卡），GET /api/v1/lend/quota-lines 由路由按场景回，
 * /quota/wall 一律 404（闸那一行见 tests/web-dom-quota-notice.test.ts）。
 * 覆盖：不再接新活 + 提醒两族同一张卡、unknown 不出、403 / 404 不出且不再拉、只读（零写请求）、关掉后刷新不再出、升级（提醒→不再接新活）再出、
 * 跨 tab 同步关掉、英文、移动端不遮输入框；存储写不进时关掉仍在本页生效、portal 到 body（401 清空、回包乱序在 tests/web-dom-quota-notice.test.ts）。
 * 关掉按「族 + 严重度 + 重置时刻」记（QUOTA1），改线 / 改模式不再算新的一代（旧 dismiss-memory-1 / settings-return-1 的情形由新规则替代）。
 * 截图写到 .playwright-mcp/qwarn1/（已 gitignore，只私存）；有 web/.next 构建时用生产样式。
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
import { QuotaNotice } from "../../features/quota/quota-notice";
const msgs = Array.from({ length: 30 }, (_, i) => i);
createRoot(document.getElementById("root")).render(
  <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <I18nInit />
    <header style={{ height: 56, flexShrink: 0 }} className="flex items-center border-b border-base-300 px-4 font-semibold">chat</header>
    <main style={{ flex: 1, overflow: "auto" }} className="space-y-2 p-4">{msgs.map((i) => <div key={i} className="rounded-xl bg-base-200 p-3 text-sm">message {i}</div>)}</main>
    <footer data-testid="input" style={{ flexShrink: 0 }} className="border-t border-base-300 p-3"><textarea className="textarea textarea-bordered w-full" rows={2} defaultValue="" /></footer>
    <QuotaNotice />
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

/** 页面时钟钉在重置前两天（夹具的重置时刻是固定日期；已过重置的读数按规则不出） */
const pin = (p: Page) => p.clock.setFixedTime(new Date(RESET - 2 * 86_400_000));
/** 一个浏览器上下文 = 一台设备（localStorage 共享）；reply 可在测试中途换（模拟 bridge 状态变化），gets / writes 计数 */
interface Device { ctx: BrowserContext; reply: { status: number; json: unknown }; hold: Promise<void> | null; gets: number; writes: string[]; open: () => Promise<Page> }
async function device(reply: Device["reply"], opts: { width?: number; height?: number; locale?: string; timezoneId?: string } = {}): Promise<Device> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 390, height: opts.height ?? 844 }, locale: opts.locale ?? "zh-CN", timezoneId: opts.timezoneId ?? "Asia/Shanghai" });
  const d: Device = { ctx, reply, hold: null, gets: 0, writes: [], open: async () => { const p = await ctx.newPage(); await pin(p); await p.goto(url); return p; } };
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
const bar = (p: Page, family: string) => p.locator(`[data-quota-notice-row="${family}"]`);
const card = (p: Page) => p.getByTestId("quota-notice");
const close = (p: Page) => p.locator('[data-quota-notice] button[aria-label="关闭"]').click();
const settle = (p: Page) => p.waitForTimeout(600);
const visible = (p: Page) => p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
/** 轮询周期是 60 秒：「下一轮」靠刷新页面模拟（模块级读数源随页面重建） */
const nextRead = async (p: Page) => { await p.reload(); await settle(p); };

test.skipIf(!enabled)("不再接新活 + 提醒两族同一张卡、只读、移动端不遮输入框", async () => {
  const d = await device({ status: 200, json: view(STOP, WARN) });
  const p = await d.open();
  await bar(p, "codex").waitFor();
  expect(await p.locator("[data-quota-notice]").count()).toBe(1);
  const codex = await bar(p, "codex").innerText();
  expect(codex).toContain("Codex 本周已用 82%，不再接新活");
  expect(codex).toContain("已不再接新活，在跑的活照常做完");
  expect(codex).toContain("10/9 09:41 重置"); // Asia/Shanghai 本地时区
  expect(await bar(p, "codex").getAttribute("data-level")).toBe("stop");
  const claude = await bar(p, "claude").innerText();
  expect(claude).toContain("Claude 本周已用 74%，到提醒线了");
  expect(claude).toContain("仍在接新活，能同时跑的数量已减半");
  const banner = (await card(p).boundingBox())!;
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
  expect(await card(p).innerText()).not.toContain("0%");
  d.reply = { status: 200, json: view(UNKNOWN, UNKNOWN) };
  await nextRead(p);
  expect(await card(p).count()).toBe(0);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("403 / 404（缩权 / 老 bridge）：不显示，且这页不再拉", async () => {
  for (const status of [403, 404]) {
    const d = await device({ status, json: { ok: false, error: "forbidden" } });
    const p = await d.open(); await settle(p);
    expect(await card(p).count()).toBe(0);
    const gets = d.gets;
    await visible(p); await settle(p);
    expect(d.gets).toBe(gets);
    await d.ctx.close();
  }
}, 30_000);

test.skipIf(!enabled)("关掉：刷新后同级不再出；升级（提醒→不再接新活）再出；跨 tab 同步", async () => {
  const d = await device({ status: 200, json: view({}, WARN) });
  const a = await d.open();
  const b = await d.open();
  await bar(a, "claude").waitFor(); await bar(b, "claude").waitFor();
  await close(a);
  await bar(a, "claude").waitFor({ state: "detached" });
  await bar(b, "claude").waitFor({ state: "detached" }); // 另一个 tab 经 storage 事件收起
  d.reply = { status: 200, json: view({}, { ...WARN, weekUsedPct: 78 }) }; // 仍在提醒区
  await nextRead(a);
  expect(await bar(a, "claude").count()).toBe(0);
  d.reply = { status: 200, json: view({}, { ...STOP, weekUsedPct: 81 }) }; // 跨过不再接新活的线
  await a.reload();
  await bar(a, "claude").waitFor();
  expect(await bar(a, "claude").innerText()).toContain("已不再接新活");
  await a.screenshot({ path: resolve(out, "qwarn1-390-dismiss-then-stop.png") });
  expect(d.writes).toEqual([]);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("桌面 + 英文 + 只观察 + 上次读数", async () => {
  const observe = view({ ...STOP, limit: "none", mode: "observe", freshness: "last_known", source: "live_stale" }, { ...WARN, limit: "none", mode: "observe" }, "observe");
  const d = await device({ status: 200, json: observe }, { width: 1280, height: 800, locale: "en-US", timezoneId: "America/New_York" });
  const p = await d.ctx.newPage();
  await pin(p);
  await p.addInitScript('localStorage.setItem("cstra_lang", "en")');
  await p.goto(url);
  await bar(p, "codex").waitFor();
  await p.waitForFunction(`document.querySelector('[data-quota-notice-row="codex"]')?.textContent?.includes("this week")`);
  const codex = await bar(p, "codex").innerText();
  expect(codex).toContain("Codex used 82% this week — taking no new work");
  expect(codex).toContain("Observe only: still accepting new work");
  expect(codex).toContain("last known reading");
  expect(codex).toContain("resets 10/8 21:41"); // America/New_York 本地时区
  expect(await bar(p, "claude").innerText()).toContain("Observe only: still accepting, concurrent runs unchanged");
  await p.screenshot({ path: resolve(out, "qwarn1-desktop-en-observe.png") });
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("独立展示时卡片 portal 在 body 下（401 清空见 tests/web-dom-quota-notice.test.ts）", async () => {
  const d = await device({ status: 200, json: view(STOP, WARN) });
  const p = await d.open();
  await bar(p, "codex").waitFor();
  expect(await p.evaluate<boolean>(`document.querySelector('[data-testid="quota-notice"]').parentElement === document.body`)).toBe(true);
  await d.ctx.close();
}, 30_000);

test.skipIf(!enabled)("存储写不进（QuotaExceeded）：关掉仍在本页生效，同一份读数再判也不再出", async () => {
  const d = await device({ status: 200, json: view(WARN, WARN) });
  await d.ctx.addInitScript(`{ const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "cstra_quota_notice_dismissed") throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); }; }`);
  const p = await d.open();
  await bar(p, "codex").waitFor(); await bar(p, "claude").waitFor();
  await close(p);
  await card(p).waitFor({ state: "detached" });
  await visible(p); await settle(p);
  expect(await card(p).count()).toBe(0);
  await d.ctx.close();
}, 30_000);
