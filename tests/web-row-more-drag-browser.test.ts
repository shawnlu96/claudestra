/**
 * agents-MOREDRAG1：从会话行尾 ⋯ 按下再拖，不起整行拖拽、不发改项目请求；普通行拖放、点 ⋯、键盘开菜单、手机左滑不回归。
 * 真 Chrome（opt-in）、真鼠标手势（page.mouse 按下 → 移动过拖阈值 → 松开，由浏览器自己起 / 不起 HTML5 拖拽，不合成 dragstart）：
 *   MOREDRAG_BROWSER=1 bun test tests/web-row-more-drag-browser.test.ts
 * 可选：MOREDRAG_SHOTS_DIR=<目录> 存改前 / 改后 PNG、manifest.json 与 gestures.json（手势记录）；MOREDRAG_BASE=<rev> 指定改前（缺省 origin/main）。
 * 夹具照 tests/web-row-more-browser.test.ts：真 Sidebar（ChatStoreProvider + 真 Tailwind / daisyUI），接口由回环服务器答，
 * 非回环请求拦下判失败；改前 = 同一入口，打包时把本卡改过的 web 文件换成 BASE 原文。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.MOREDRAG_BROWSER === "1";
const shots = process.env.MOREDRAG_SHOTS_DIR;
const BASE = process.env.MOREDRAG_BASE ?? "origin/main";
const web = resolve("web");
const comp = join(web, "features/chat/components");
/** 本卡改过、改前要换回 BASE 原文的 web 文件（新文件 row-drag-origin.ts 在 BASE 上没人 import） */
const CHANGED = ["features/chat/components/agent-dnd.tsx", "features/chat/components/row-more-button.tsx"];
type Variant = "before" | "after";
const work = mkdtempSync(join(tmpdir(), "moredrag1-"));
const bundles: Partial<Record<Variant, string>> = {};
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let style = "";
const manifest: { view: string; size: string; phase: Variant; file: string }[] = [];
const gestures: Record<string, unknown> = {};
/** 改项目请求（POST /projects action=assign），按页面变体记 */
const assigns: { v: string; agent: string; id: string }[] = [];

function agents() {
  const now = Date.now();
  const ag = (name: string, minAgo: number, p: Record<string, unknown> = {}) =>
    ({ name, purpose: "", cwd: "/tmp/fixture", status: "active", lastActivityTs: now - minAgo * 60_000, ...p });
  return [
    ag("dev-alpha", 1, { projectId: "web" }),
    ag("dev-bravo", 3, { projectId: "web" }),
    ag("review-charlie", 9, { projectId: "docs" }),
    ag("docs-writer", 30, { projectId: "docs" }),
  ];
}
const PROJECTS = [{ id: "web", name: "网页改版", dirs: ["/tmp/web"] }, { id: "docs", name: "文档", dirs: ["/tmp/docs"] }];

const ENTRY = `import React, { useEffect } from "react"; import { createRoot } from "react-dom/client";
import { machines } from "@/lib/machines"; import { setLang } from "@/lib/i18n";
import { ChatStoreProvider, useChatStoreApi } from "../chat-store"; import { Sidebar } from "./sidebar";
document.documentElement.dataset.theme = "light"; setLang("zh");
function Load() { const s = useChatStoreApi(); useEffect(() => {
  s.produce((state) => { state.activeAgent = "dev-alpha"; });
  void Promise.all([s.loadAgents("action"), s.loadProjects()]).then(() => { window.loaded = true; });
}, [s]); return null; }
const App = () => <ChatStoreProvider><Load /><div className="flex h-screen w-full bg-base-100 text-base-content">
  <Sidebar onSelect={() => {}} /><main className="hidden min-w-0 flex-1 flex-col sm:flex" /></div></ChatStoreProvider>;
void machines.add({ fp: "mac-a", name: "mac-a" }).then(() => machines.setCurrent("mac-a")).then(() => createRoot(document.getElementById("root")).render(<App />));
`;

const BUILD = `
import { readFileSync } from "node:fs";
const [entry, outdir, swapFile] = process.argv.slice(-3);
const swap = swapFile === "-" ? {} : JSON.parse(readFileSync(swapFile, "utf8"));
const plugin = { name: "moredrag1-base", setup(b) {
  b.onLoad({ filter: /\\.(tsx|ts)$/ }, (a) => (a.path in swap ? { contents: swap[a.path], loader: a.path.endsWith("x") ? "tsx" : "ts" } : undefined));
} };
const r = await Bun.build({ entrypoints: [entry], target: "browser", outdir, plugins: [plugin], define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1); }
`;

/** 手势记录：document 上冒泡阶段看事件（React 根容器之后），dragstart 记是否被取消 = 有没有真起拖拽会话 */
const RECORDER = `window.__g = [];
for (const t of ["pointerdown", "pointerup", "pointercancel", "dragstart", "dragend", "drop"]) document.addEventListener(t, (e) => {
  const el = e.target && e.target.closest ? e.target : null;
  window.__g.push({ t, prevented: e.defaultPrevented, on: el && el.closest("[data-row-more]") ? "more" : el && el.closest("[draggable=true]") ? "row" : "other" });
});`;
interface Ev { t: string; prevented: boolean; on: string }

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

async function css(baseDir: string) {
  const req = createRequire(join(web, "package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = join(web, "app/globals.css");
  const src = `${readFileSync(from, "utf8")}\n@source "${baseDir}";\n`;
  return (await postcss([tw({ base: web })]).process(src, { from })).css;
}

async function bundle(v: Variant, swap: Record<string, string>) {
  const entry = join(comp, `.moredrag1-shot-${v}.tsx`);
  const out = join(work, v);
  const swapFile = join(work, `${v}-swap.json`);
  writeFileSync(swapFile, JSON.stringify(swap));
  await Bun.write(entry, ENTRY);
  try {
    const p = Bun.spawn([process.execPath, "-e", BUILD, entry, out, v === "before" ? swapFile : "-"], { cwd: web, stdout: "pipe", stderr: "pipe" });
    if (await p.exited) throw new Error(await new Response(p.stderr).text());
  } finally { unlinkSync(entry); }
  return join(out, readdirSync(out).find((f) => f.endsWith(".js"))!);
}

beforeAll(async () => {
  if (!enabled) return;
  const baseSha = await git("rev-parse", "--verify", `${BASE}^{commit}`);
  const baseDir = join(work, "base-src");
  const swap: Record<string, string> = {};
  for (const f of CHANGED) {
    const body = await git("show", `${baseSha}:web/${f}`);
    swap[join(web, f)] = body;
    mkdirSync(join(baseDir, f, ".."), { recursive: true });
    writeFileSync(join(baseDir, f), body);
  }
  style = await css(baseDir);
  bundles.before = await bundle("before", swap);
  bundles.after = await bundle("after", {});
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const api = url.pathname.match(/^\/m\/mac-a\/api\/v1(\/.*)$/)?.[1];
    if (api === "/agents") return Response.json({ ok: true, agents: agents() });
    if (api === "/projects" && req.method === "POST") {
      const b = (await req.json()) as { action?: string; agent?: string; id?: string };
      if (b.action === "assign") assigns.push({ v: req.headers.get("referer")?.match(/\/(before|after)/)?.[1] ?? "?", agent: String(b.agent), id: String(b.id) });
      return Response.json({ ok: true });
    }
    if (api === "/projects") return Response.json({ ok: true, projects: PROJECTS });
    if (api === "/unread") return Response.json({ counts: {} });
    if (api === "/peers/contacts") return Response.json({ contacts: [] });
    if (api === "/shells") return Response.json({ shells: [], dirs: [{ dir: "/tmp" }], max: 4 });
    if (api) return Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
    if (url.pathname === "/app-config.json") return Response.json({ mode: "relay", relayBase: url.origin, version: "" });
    const v = url.pathname.match(/^\/(before|after)\.js$/)?.[1] as Variant | undefined;
    if (v) return new Response(Bun.file(bundles[v]!), { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname !== "/before" && url.pathname !== "/after") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head>
      <body><div id="root"></div><script>window.process = { env: {} };</script><script type="module" src="${url.pathname}.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  if (shots && manifest.length) {
    writeFileSync(join(shots, "manifest.json"), JSON.stringify({ v: 1,
      summary: "合成夹具侧栏：从会话行更多按钮按下拖到另一项目组头（改前起整行拖拽并高亮目标、改后不起），普通行拖放、点更多按钮开菜单、手机左滑", shots: manifest }, null, 2));
    writeFileSync(join(shots, "gestures.json"), JSON.stringify(gestures, null, 2));
  }
  rmSync(work, { recursive: true, force: true });
}, 30_000);

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;

async function open(v: Variant, width: number) {
  const mobile = width < 640;
  const height = mobile ? 844 : 800;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "light", ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const blocked: string[] = [], errors: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  await ctx.addInitScript("try { localStorage.setItem('cstra_push_prompt_dismissed', '1'); delete Navigator.prototype.registerProtocolHandler } catch {}");
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.url}${v}`);
  await page.waitForFunction(`window.loaded && document.body.innerText.includes("dev-bravo") && document.body.innerText.includes("文档")`, undefined, { timeout: 15_000 })
    .catch((e) => { throw new Error(`${e}\n${errors.join("\n")}\n${blocked.join("\n")}`); });
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(400);
  return { page, ctx, blocked, errors, size: `${width}x${height}` };
}

async function shot(p: Page, v: Variant, size: string, view: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const file = `${v}-${view}-${size}.png`;
  await p.screenshot({ path: join(shots, file) });
  manifest.push({ view, size, phase: v, file });
}

const row = (p: Page, name: string) => p.locator("aside li:not(:has(li))").filter({ has: p.locator("[data-row-name]", { hasText: name }) });
const more = (p: Page, name: string) => row(p, name).locator("[data-row-more]");
const docsHead = (p: Page) => p.locator("aside button:not([data-now-project])").filter({ has: p.getByText("文档", { exact: true }) });

async function center(p: Page, sel: ReturnType<Page["locator"]>) {
  const b = (await sel.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** 真鼠标手势：按下 → 分步移过拖阈值到目标 → （可选截图 / Esc）→ 松开 */
async function gesture(p: Page, from: { x: number; y: number }, to: { x: number; y: number }, mid?: () => Promise<void>) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(from.x + 12, from.y + 12, { steps: 4 });
  await p.mouse.move(to.x, to.y, { steps: 12 });
  await p.waitForTimeout(150);
  if (mid) await mid();
  await p.mouse.up();
  await p.waitForTimeout(300);
}
const events = (p: Page) => p.evaluate<Ev[]>("window.__g.splice(0)");
const sessions = (ev: Ev[]) => ev.filter((e) => e.t === "dragstart" && !e.prevented).length;
const assignCount = (v: Variant) => assigns.filter((a) => a.v === v).length;

async function moreDrag(v: Variant) {
  const s = await open(v, 1280);
  try {
    const n0 = assignCount(v);
    const target = await center(s.page, docsHead(s.page));
    let ring = false;
    await gesture(s.page, await center(s.page, more(s.page, "dev-bravo")), target, async () => {
      ring = await s.page.evaluate<boolean>(`!!document.querySelector("aside [class*=ring-primary]")`);
      await shot(s.page, v, s.size, "drag-from-more");
    });
    const ev = await events(s.page);
    gestures[`${v}:drag-from-more`] = ev;
    expect(s.blocked).toEqual([]);
    expect(s.errors).toEqual([]);
    return { sessions: sessions(ev), assigns: assignCount(v) - n0, ring, menuOpen: await s.page.locator('[role="menu"]').count() };
  } finally { await s.ctx.close(); }
}

test.skipIf(!enabled)("before (base)：从 ⋯ 按下拖到别的项目组头 → 起整行拖拽并改项目（复现）", async () => {
  const r = await moreDrag("before");
  expect(r.sessions).toBe(1);
  expect(r.ring).toBe(true);
  expect(r.assigns).toBe(1);
}, 180_000);

test.skipIf(!enabled)("after：从 ⋯ 按下移过拖阈值再放开 → 无行拖拽会话、无改项目请求", async () => {
  const r = await moreDrag("after");
  expect(r.sessions).toBe(0);
  expect(r.ring).toBe(false);
  expect(r.assigns).toBe(0);
}, 180_000);

test.skipIf(!enabled)("after：普通行拖放改项目一次；点 ⋯ / 取消手势 / ⋯ 起拖之后再拖行都只改一次", async () => {
  const s = await open("after", 1280);
  try {
    const p = s.page;
    const target = await center(p, docsHead(p));
    const name = () => center(p, row(p, "dev-bravo").locator("[data-row-name]"));
    const log: Record<string, unknown> = {};

    // 1) 普通行区域起拖
    let n0 = assignCount("after");
    await gesture(p, await name(), target);
    let ev = await events(p);
    log["row-drag"] = ev;
    expect([sessions(ev), assignCount("after") - n0]).toEqual([1, 1]);
    expect(assigns.at(-1)).toEqual({ v: "after", agent: "dev-bravo", id: "docs" });

    // 2) 点 ⋯ = 开菜单，不起拖、不改项目；关菜单后行拖放照常
    n0 = assignCount("after");
    await more(p, "dev-bravo").click();
    await p.locator('[role="menu"]').waitFor();
    expect(await p.locator('[role="menu"] [role="menuitem"]').count()).toBeGreaterThan(0);
    await p.mouse.click(1200, 780); // 点遮罩关菜单
    await p.locator('[role="menu"]').waitFor({ state: "detached" });
    await gesture(p, await name(), target);
    ev = await events(p);
    log["click-more-then-row-drag"] = ev;
    expect([sessions(ev), assignCount("after") - n0]).toEqual([1, 1]);

    // 3) 从 ⋯ 起拖、途中 Esc 取消再松开；随后从行重新拖 → 只改一次（标记已清）
    n0 = assignCount("after");
    await gesture(p, await center(p, more(p, "dev-bravo")), target, () => p.keyboard.press("Escape"));
    await p.keyboard.press("Escape"); // 若松开在 ⋯ 外仍弹了菜单，一并关掉
    await gesture(p, await name(), target);
    ev = await events(p);
    log["cancel-then-row-drag"] = ev;
    expect([sessions(ev), assignCount("after") - n0]).toEqual([1, 1]);

    // 4) 从 ⋯ 起拖（被拦）后紧接着从行拖 → 照常改一次
    n0 = assignCount("after");
    await gesture(p, await center(p, more(p, "dev-bravo")), target);
    await gesture(p, await name(), target);
    ev = await events(p);
    log["more-drag-then-row-drag"] = ev;
    expect([sessions(ev), assignCount("after") - n0]).toEqual([1, 1]);

    // 5) 键盘：Tab 到 ⋯ 回车开菜单（aria-haspopup=menu / aria-label），菜单项可达
    const btn = more(p, "dev-alpha");
    expect(await btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(await btn.getAttribute("aria-label")).toBe("更多操作");
    await btn.focus();
    await p.keyboard.press("Enter");
    await p.locator('[role="menu"]').waitFor();
    expect(await p.locator('[role="menu"] [role="menuitem"]').count()).toBeGreaterThan(0);
    gestures["after:desktop-regression"] = log;
    expect(s.blocked).toEqual([]);
    expect(s.errors).toEqual([]);
  } finally { await s.ctx.close(); }
}, 180_000);

/** 手机：切到「会话」页（首屏是「今天」），真触摸左滑 dev-bravo 行（CDP 触摸序列），返回是否露出「归档」 */
async function mobileSwipe(p: Page, ctx: import("playwright-core").BrowserContext) {
  const r = row(p, "dev-bravo");
  await p.getByRole("button", { name: "会话", exact: true }).click();
  await r.waitFor({ state: "visible" });
  const c = await center(p, r.locator("[data-row-name]"));
  const cdp = await ctx.newCDPSession(p);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: c.y, id: 1 }] });
  await touch("touchStart", c.x);
  for (let i = 1; i <= 15; i++) { await touch("touchMove", c.x - i * 12); await p.waitForTimeout(16); }
  await touch("touchEnd", c.x - 180);
  await p.waitForTimeout(400);
  return { draggable: await r.locator("[draggable=true]").count(), archive: await r.getByText("归档", { exact: true }).isVisible() };
}

test.skipIf(!enabled)("after 手机：行不可拖、左滑露出操作钮、点 ⋯ 开菜单", async () => {
  const s = await open("after", 390);
  try {
    const p = s.page;
    const n0 = assignCount("after");
    expect(await mobileSwipe(p, s.ctx)).toEqual({ draggable: 0, archive: true });
    await more(p, "dev-alpha").tap();
    await p.locator('[role="menu"]').waitFor();
    expect(await p.locator('[role="menu"] [role="menuitem"]').count()).toBeGreaterThan(0);
    const ev = await events(p);
    gestures["after:mobile"] = ev;
    expect([sessions(ev), assignCount("after") - n0]).toEqual([0, 0]);
    expect(s.blocked).toEqual([]);
    expect(s.errors).toEqual([]);
  } finally { await s.ctx.close(); }
}, 60_000);

/** 改前 / 改后同一状态成对截图：桌面行起拖途中、点 ⋯ 开菜单；手机左滑 */
test.skipIf(!enabled || !shots)("截图对照：行起拖 / 点 ⋯ 菜单 / 手机左滑（改前改后一致）", async () => {
  for (const v of ["before", "after"] as const) {
    const d = await open(v, 1280);
    try {
      const target = await center(d.page, docsHead(d.page));
      await gesture(d.page, await center(d.page, row(d.page, "dev-bravo").locator("[data-row-name]")), target, () => shot(d.page, v, d.size, "drag-from-row"));
      await more(d.page, "dev-bravo").click();
      await d.page.locator('[role="menu"]').waitFor();
      await shot(d.page, v, d.size, "more-click-menu");
    } finally { await d.ctx.close(); }
    const m = await open(v, 390);
    try {
      expect(await mobileSwipe(m.page, m.ctx)).toEqual({ draggable: 0, archive: true });
      await shot(m.page, v, m.size, "mobile-swipe");
    } finally { await m.ctx.close(); }
  }
}, 120_000);
