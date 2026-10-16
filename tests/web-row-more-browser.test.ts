/**
 * agents-ROWMORE1：会话行 / 项目组头常显 ⋯、组头线条文件夹、顶栏 ⋮ 的「立即打断」。真 Chrome（opt-in）：
 *   ROW_MORE_BROWSER=1 bun test tests/web-row-more-browser.test.ts
 * 可选：ROW_MORE_SHOTS_DIR=<目录> 存改前 / 改后 × 390 / 1280 的 PNG 和 manifest.json；ROW_MORE_BASE=<rev> 指定改前（缺省 origin/main）。
 * 页面是合成夹具：真 Sidebar + 真 TopBarActions（ChatStoreProvider + 真 Tailwind / daisyUI），接口由本文件的回环服务器答，
 * 非回环请求一律拦下并判失败。改前 = 同一个入口、同一份夹具，打包时把本卡改过的 web 文件换成 BASE 上的原文（Bun.build onLoad）。
 * 做法照 tests/web-sidebar-polish-browser.test.ts。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const enabled = process.env.ROW_MORE_BROWSER === "1";
const shots = process.env.ROW_MORE_SHOTS_DIR;
const BASE = process.env.ROW_MORE_BASE ?? "origin/main";
const web = resolve("web");
const comp = join(web, "features/chat/components");
/** 本卡改过、改前要换回 BASE 原文的 web 文件（新文件 row-more-button / interrupt-menu-item 在 BASE 上没人 import） */
const CHANGED = ["features/chat/components/agent-row.tsx", "features/chat/components/project-group.tsx", "features/chat/components/menu-gestures.ts",
  "features/chat/components/topbar-actions.tsx", "lib/i18n-dict.ts"];
type Variant = "before" | "after";
const work = mkdtempSync(join(tmpdir(), "rowmore1-"));
const bundles: Partial<Record<Variant, string>> = {};
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let style = "";
const manifest: { view: string; size: string; phase: Variant; file: string }[] = [];

const LONG = "网页改版侧栏常显更多按钮的超长会话名称";
function agents() {
  const now = Date.now();
  const ag = (name: string, minAgo: number, p: Record<string, unknown> = {}) =>
    ({ name, purpose: "", cwd: "/tmp/fixture", status: "active", lastActivityTs: now - minAgo * 60_000, ...p });
  return [
    ag("dev-alpha", 1, { busy: true, projectId: "web" }),
    ag("dev-bravo", 3, { projectId: "web" }),
    ag(LONG, 6, { projectId: "web" }),
    ag("review-charlie", 9, { projectId: "docs", busy: true }),
    ag("docs-writer", 30, { projectId: "docs" }),
    ag("solo-runner", 45),
  ];
}
/** 未读走 /unread 全局计数（lib/api/push.ts） */
const UNREAD = { "dev-bravo": 4, [LONG]: 12, "docs-writer": 2 };
const PROJECTS = [{ id: "web", name: "网页改版", emoji: "🚀", dirs: ["/tmp/web"] }, { id: "docs", name: "文档", dirs: ["/tmp/docs"] }];

const ENTRY = `import React, { useEffect } from "react"; import { createRoot } from "react-dom/client";
import { machines } from "@/lib/machines"; import { setLang } from "@/lib/i18n";
import { ChatStoreProvider, useChatStoreApi, useChatStore } from "../chat-store"; import { Sidebar } from "./sidebar"; import { TopBarActions } from "./topbar-actions";
document.documentElement.dataset.theme = "light"; setLang("zh");
const top = location.hash === "#top";
function Load() { const s = useChatStoreApi(); useEffect(() => { void Promise.all([s.loadAgents("action"), s.loadProjects()]).then(() => { window.loaded = true; }); }, [s]); return null; }
function Bar() { const a = useChatStore((s) => s.state.agents.find((x) => x.name === "dev-alpha"));
  return <header className="@container relative z-40 flex min-h-12 shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 sm:px-4">
    <span className="truncate text-sm font-medium">dev-alpha</span>{a && <TopBarActions agent={a} busy={false} onManage={() => {}} />}</header>; }
const App = () => <ChatStoreProvider><Load /><div className="flex h-screen w-full bg-base-100 text-base-content">
  {top ? <main className="flex min-w-0 flex-1 flex-col"><Bar /></main> : <><Sidebar onSelect={() => {}} /><main className="hidden min-w-0 flex-1 flex-col sm:flex"><Bar /></main></>}</div></ChatStoreProvider>;
void machines.add({ fp: "mac-a", name: "mac-a" }).then(() => machines.setCurrent("mac-a")).then(() => createRoot(document.getElementById("root")).render(<App />));
`;

const BUILD = `
import { readFileSync } from "node:fs";
const [entry, outdir, swapFile] = process.argv.slice(-3);
const swap = swapFile === "-" ? {} : JSON.parse(readFileSync(swapFile, "utf8"));
const plugin = { name: "rowmore1-base", setup(b) {
  b.onLoad({ filter: /\\.(tsx|ts)$/ }, (a) => (a.path in swap ? { contents: swap[a.path], loader: a.path.endsWith("x") ? "tsx" : "ts" } : undefined));
} };
const r = await Bun.build({ entrypoints: [entry], target: "browser", outdir, plugins: [plugin], define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1); }
`;

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
  const entry = join(comp, `.rowmore1-shot-${v}.tsx`);
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
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    const api = url.pathname.match(/^\/m\/mac-a\/api\/v1(\/.*)$/)?.[1];
    if (api === "/agents") return Response.json({ ok: true, agents: agents() });
    if (api === "/projects") return Response.json({ ok: true, projects: PROJECTS });
    if (api === "/unread") return Response.json({ counts: UNREAD });
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
      summary: "合成夹具侧栏与顶栏：会话行与项目组头常显更多按钮、组头线条文件夹图标、顶栏菜单立即打断（改前 / 改后同屏）", shots: manifest }, null, 2));
  }
  rmSync(work, { recursive: true, force: true });
}, 30_000);

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;

async function open(v: Variant, width: number, hash = "") {
  const height = width < 640 ? 844 : 800;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "light" });
  const blocked: string[] = [], errors: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  // 夹具噪音：推送提示与「登记邀请链接」浮条不进截图（各自的已关闭 / 不支持分支）
  await ctx.addInitScript("try { localStorage.setItem('cstra_push_prompt_dismissed', '1'); delete Navigator.prototype.registerProtocolHandler } catch {}");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.url}${v}${hash}`);
  await page.waitForFunction(`window.loaded && document.body.innerText.includes("dev-alpha")`, undefined, { timeout: 15_000 })
    .catch((e) => { throw new Error(`${e}\n${errors.join("\n")}\n${blocked.join("\n")}`); });
  if (!hash) await page.waitForFunction(`document.body.innerText.includes("网页改版")`, undefined, { timeout: 10_000 });
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(400);
  return { page, ctx, blocked, errors, size: `${width}x${height}` };
}

async function shot(p: Page, v: Variant, size: string, view: string) {
  const issues = await shotIssues(p);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    const file = `${v}-${view}-${size}.png`;
    await p.screenshot({ path: join(shots, file) });
    manifest.push({ view, size, phase: v, file });
  }
  return issues;
}

/** 侧栏量：会话行数 / ⋯ 数、组头 emoji、⋯ 是否压到行内的未读 / 忙闲 / 名字（行按钮右缘 ≤ ⋯ 左缘且 ⋯ 在行内） */
const MEASURE = `(() => {
  const aside = document.querySelector("aside");
  const rows = [...aside.querySelectorAll("[data-row-name]")];
  const groupHeads = [...aside.querySelectorAll("li > div > button[aria-expanded], li > button")].filter((b) => /(网页改版|文档)\\n\\d+/.test(b.innerText));
  const dots = [...aside.querySelectorAll("[data-row-more]")];
  const bad = dots.filter((d) => {
    const r = d.getBoundingClientRect();
    const sib = d.previousElementSibling?.getBoundingClientRect();
    const box = d.parentElement.getBoundingClientRect();
    return r.width < 20 || r.right > box.right + 0.5 || (sib && sib.right > r.left + 0.5);
  }).length;
  const unread = [...aside.querySelectorAll("li button")].filter((b) => /^(4|12|2)$/m.test(b.innerText)).length;
  return { rows: rows.length, dots: dots.length, bad, unread, headText: groupHeads.map((b) => b.innerText), headEmoji: groupHeads.some((b) => /🚀|📁|📂/u.test(b.textContent)) };
})()`;
interface Measure { rows: number; dots: number; bad: number; unread: number; headText: string[]; headEmoji: boolean }

const sidebarSeen: Partial<Record<Variant, Promise<Record<string, { m: Measure; issues: ShotIssue[] }>>>> = {};
/** 每个变体只跑一遍（after 用例要拿改前的未读计数对照，不重复截图） */
const sidebarViews = (v: Variant) => (sidebarSeen[v] ??= sidebarViewsOnce(v));
async function sidebarViewsOnce(v: Variant) {
  const out: Record<string, { m: Measure; issues: ShotIssue[] }> = {};
  for (const width of [390, 1280]) {
    const s = await open(v, width);
    out[`expanded-${width}`] = { m: await s.page.evaluate<Measure>(MEASURE), issues: await shot(s.page, v, s.size, "sidebar-expanded") };
    await s.page.evaluate(`[...document.querySelectorAll("aside li button")].find((b) => b.innerText.trim().startsWith("网页改版")).click()`);
    await s.page.waitForTimeout(300);
    out[`collapsed-${width}`] = { m: await s.page.evaluate<Measure>(MEASURE), issues: await shot(s.page, v, s.size, "sidebar-collapsed") };
    expect(s.blocked).toEqual([]);
    expect(s.errors).toEqual([]);
    await s.ctx.close();
  }
  return out;
}

async function topbarView(v: Variant) {
  const out: Record<string, { items: string[]; menus: number; issues: ShotIssue[] }> = {};
  for (const [width, hash] of [[390, "#top"], [1280, ""]] as const) {
    const s = await open(v, width, hash);
    const dots = s.page.locator('header [aria-label="更多操作"]:visible');
    const menus = await dots.count();
    await dots.first().click();
    await s.page.waitForTimeout(300);
    const items = await s.page.locator("header .dropdown-content li:visible").allInnerTexts();
    out[String(width)] = { items: items.map((x) => x.trim()).filter(Boolean), menus, issues: await shot(s.page, v, s.size, "topbar-menu") };
    expect(s.blocked).toEqual([]);
    expect(s.errors).toEqual([]);
    await s.ctx.close();
  }
  return out;
}

test.skipIf(!enabled)("before (base)：会话行无 ⋯、组头是 emoji、顶栏 ⋮ 里没有「立即打断」", async () => {
  const sb = await sidebarViews("before");
  for (const k of Object.keys(sb)) {
    expect([k, sb[k].m.dots]).toEqual([k, 0]);
    expect([k, sb[k].m.headEmoji]).toEqual([k, true]);
  }
  const tb = await topbarView("before");
  for (const k of Object.keys(tb)) expect(tb[k].items.some((x) => x.includes("立即打断"))).toBe(false);
}, 180_000);

test.skipIf(!enabled)("after：每个会话行与组头都有 ⋯，不压未读 / 忙闲 / 名字；组头无 emoji；宽窄顶栏只一个 ⋮ 且有「立即打断」；截图无问题", async () => {
  const before = await sidebarViews("before");
  const sb = await sidebarViews("after");
  for (const k of Object.keys(sb)) {
    const m = sb[k].m;
    expect([k, sb[k].issues]).toEqual([k, []]);
    expect([k, m.headEmoji, m.bad]).toEqual([k, false, 0]);
    // 组头（2 个）+ 可见会话行，各一个 ⋯
    expect([k, m.headText.length]).toEqual([k, 2]);
    expect([k, m.dots]).toEqual([k, m.rows + m.headText.length]);
    // 未读 / 名字与改前同样可见
    expect([k, m.unread]).toEqual([k, before[k].m.unread]);
  }
  const tb = await topbarView("after");
  for (const k of Object.keys(tb)) {
    expect([k, tb[k].menus, tb[k].issues]).toEqual([k, 1, []]);
    expect([k, tb[k].items.filter((x) => x.includes("立即打断")).length]).toEqual([k, 1]);
  }
}, 240_000);
