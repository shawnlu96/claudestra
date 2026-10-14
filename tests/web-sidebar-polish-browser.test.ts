/**
 * team-project-UXSIDE1：侧栏「会话」标题不折行、芯片一句话解释（桌面 title + 手机图例卡）、长 agent 名不被截成几个字母。真 Chrome（opt-in）：
 *   SIDEBAR_POLISH_BROWSER=1 bun test tests/web-sidebar-polish-browser.test.ts
 * 可选：SIDEBAR_POLISH_SHOTS_DIR=<目录> 存改前 / 改后 × 1280 / 390 的 PNG 和 manifest.json（含 sha256）；SIDEBAR_POLISH_BASE=<rev> 指定改前（缺省 origin/main）。
 * 页面是合成夹具：真 Sidebar（ChatStoreProvider + 真 Tailwind / daisyUI），6 个合成会话，接口由本文件的回环服务器答（agents / shells / contacts），
 * 非回环请求一律拦下并判失败。改前 = 同一个入口、同一份夹具，打包时把本卡改过的 web 文件换成 BASE 上的原文（Bun.build onLoad）。
 * 顶栏按钮按 PM 补（10-14）维持现状：只核「全权 / 非全权」「shells 200 / 403」两组下改前改后的按钮集合一致。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { ctxChipWords, rowStateWords, stageChipWords } from "@/features/chat/chip-words";
import type { CtxBoundaryInfo } from "@/features/chat/ctx-boundary-view";

const enabled = process.env.SIDEBAR_POLISH_BROWSER === "1";
const shots = process.env.SIDEBAR_POLISH_SHOTS_DIR;
const BASE = process.env.SIDEBAR_POLISH_BASE ?? "origin/main";
const web = resolve("web");
const comp = join(web, "features/chat/components");
/** 本卡改过、改前要换回 BASE 原文的 web 文件（新文件 chip-legend / chip-words / sidebar-polish-i18n 在 BASE 上没人 import） */
const CHANGED = ["features/chat/components/sidebar.tsx", "features/chat/components/agent-row.tsx", "features/chat/components/ctx-boundary-chip.tsx",
  "features/chat/components/ledger-stage-chip.tsx", "features/chat/components/line-icons.tsx", "features/chat/components/sidebar-admin-buttons.tsx",
  "features/talk/workspace-switch.tsx"];
type Variant = "before" | "after";
const work = mkdtempSync(join(tmpdir(), "uxside1-"));
const bundles: Partial<Record<Variant, string>> = {};
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let style = "";
let baseSha = "";
const manifest: { file: string; variant: Variant; width: number; view: string; sha256: string; issues: ShotIssue[] }[] = [];

const LONG = "claudestra-sidebar-polish-runner";
const COORD: CtxBoundaryInfo = { policy: "coordinator", window: 200_000, hardCap: 250_000, remaining: 6_000, level: "ok" };
const EXEC: CtxBoundaryInfo = { policy: "executor", window: 200_000, hardCap: 250_000, remaining: 64_000, level: "ok" };
const LONG_TASK = { id: "T7", stage: "live", round: 0 };
/** 中文长名字（汉字一字一 em，比 ASCII 难留 8 个字）：一个是会话名本身，一个是显示名（后面跟「| 原名」） */
const LONG_ZH = "侧栏打磨执行会话超长名称";
const LABEL_ZH = "侧栏打磨执行会话超长";
/** 8 个会话：长名字挂阶段 + 上下文芯片、工作中、压缩中、协调类余量在压缩线附近、带显示名的审查返工、空闲；中文长名字 / 中文显示名各挂两芯片 */
function agents() {
  const now = Date.now();
  const ag = (name: string, minAgo: number, p: Record<string, unknown> = {}) =>
    ({ name: `agent-${name}`, purpose: "", cwd: "/tmp/fixture", status: "active", lastActivityTs: now - minAgo * 60_000, ...p });
  return [
    ag(LONG, 3, { ledgerTask: LONG_TASK, ctxBoundary: EXEC, contextTokens: 136_000 }),
    ag("dev-alpha", 1, { busy: true }),
    ag("dev-bravo", 2, { compacting: true }),
    ag("pm-coordinator", 5, { ctxBoundary: COORD, contextTokens: 194_000 }),
    ag("review-charlie-cross-model", 8, { label: "跨模型审查", ledgerTask: { id: "T9", stage: "fix", round: 2 } }),
    ag(LONG_ZH, 12, { ledgerTask: { id: "T11", stage: "review", round: 1 }, ctxBoundary: EXEC, contextTokens: 136_000 }),
    ag("uxside1-label-runner", 15, { label: LABEL_ZH, ledgerTask: { id: "T12", stage: "build", round: 0 }, ctxBoundary: COORD, contextTokens: 194_000 }),
    ag("docs-writer", 40),
  ];
}

const ENTRY = `import React, { useEffect } from "react"; import { createRoot } from "react-dom/client";
import { machines } from "@/lib/machines"; import { setLang } from "@/lib/i18n";
import { ChatStoreProvider, useChatStoreApi } from "../chat-store"; import { Sidebar } from "./sidebar";
document.documentElement.dataset.theme = "light"; setLang("zh");
function Load() { const s = useChatStoreApi(); useEffect(() => { void s.loadAgents("action").then(() => { window.loaded = true; }); }, [s]); return null; }
const App = () => <ChatStoreProvider><Load /><div className="flex h-screen w-full bg-base-100 text-base-content">
  <Sidebar onSelect={() => {}} /><main className="hidden min-w-0 flex-1 sm:block" /></div></ChatStoreProvider>;
void machines.add({ fp: "mac-a", name: "mac-a" }).then(() => machines.setCurrent("mac-a")).then(() => createRoot(document.getElementById("root")).render(<App />));
`;

/** 子进程里跑 Bun.build（bun test 进程内带插件构建时相对路径解析不到）；before 用 onLoad 把 CHANGED 换成 BASE 原文 */
const BUILD = `
import { readFileSync } from "node:fs";
const [entry, outdir, swapFile] = process.argv.slice(-3);
const swap = swapFile === "-" ? {} : JSON.parse(readFileSync(swapFile, "utf8"));
const plugin = { name: "uxside1-base", setup(b) {
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

/** 真 Tailwind：扫 web/ 之外再 @source 一份 BASE 原文，改前独有的类名也编进来 */
async function css(baseDir: string) {
  const req = createRequire(join(web, "package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = join(web, "app/globals.css");
  const src = `${readFileSync(from, "utf8")}\n@source "${baseDir}";\n`;
  return (await postcss([tw({ base: web })]).process(src, { from })).css;
}

async function bundle(v: Variant, swap: Record<string, string>) {
  const entry = join(comp, `.uxside1-shot-${v}.tsx`);
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
  baseSha = await git("rev-parse", "--verify", `${BASE}^{commit}`);
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
    const q = url.searchParams;
    const api = url.pathname.match(/^\/m\/mac-a\/api\/v1(\/.*)$/)?.[1];
    if (api === "/agents") return Response.json({ ok: true, agents: agents() });
    if (api === "/peers/contacts") return q.get("full") === "0" ? Response.json({ error: "scope" }, { status: 403 }) : Response.json({ contacts: [] });
    if (api === "/shells") return q.get("shells") === "403" ? Response.json({ error: "no" }, { status: 403 }) : Response.json({ shells: [], dirs: [{ dir: "/tmp" }], max: 4 });
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
    writeFileSync(join(shots, "manifest.json"), JSON.stringify({ card: "team-project-UXSIDE1", fixture: "synthetic sidebar, not a production page",
      before: { base: BASE, commit: baseSha, files: CHANGED }, after: { commit: await git("rev-parse", "HEAD"), dirty: (await git("status", "--porcelain", "--", "web")) !== "" },
      shots: manifest }, null, 2));
  }
  rmSync(work, { recursive: true, force: true });
}, 30_000);

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;

async function open(v: Variant, width: number, o: { narrow?: boolean; full?: boolean; shells?: 200 | 403 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 800 }, deviceScaleFactor: 2, colorScheme: "light" });
  const blocked: string[] = [], errors: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  // 侧栏拖到最窄 = 200px（sidebar.tsx startResize 的下限），走它自己读的 localStorage 键
  if (o.narrow) await ctx.addInitScript("try { localStorage.setItem('cstra_sbw', '200') } catch {}");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const qs = `?full=${o.full === false ? 0 : 1}&shells=${o.shells ?? 200}`;
  await page.route(/\/m\/mac-a\/api\/v1\//, (r) => {
    const u = new URL(r.request().url());
    return r.continue({ url: `${u.origin}${u.pathname}${u.search ? `${u.search}&` : "?"}${qs.slice(1)}` });
  });
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(`${server.url}${v}`);
  await page.waitForFunction(`window.loaded && document.body.innerText.includes(${JSON.stringify(LONG)})`, undefined, { timeout: 15_000 })
    .catch(async (e) => { throw new Error(`${e}\n${errors.join("\n")}\n${blocked.join("\n")}\n${logs.slice(0, 20).join("\n")}`); });
  if (o.shells !== 403) await page.waitForSelector('button[aria-label="新终端"]', { timeout: 10_000 });
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(400); // contacts / shells 的回包让按钮落定
  return { page, ctx, blocked, errors };
}

async function shot(p: Page, v: Variant, width: number, view: string) {
  const issues = await shotIssues(p);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    const file = `${v}-${width}-${view}.png`;
    await p.screenshot({ path: join(shots, file) });
    manifest.push({ file, variant: v, width, view, sha256: createHash("sha256").update(readFileSync(join(shots, file))).digest("hex"), issues });
  }
  return issues;
}

/** 浏览器里量：「会话」标题行数、长名字可见几个字、各芯片的可见文字和 title、行 title、顶栏可见按钮 */
const MEASURE = `(({ names }) => {
  const lines = (el) => el ? Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) : -1;
  const title = [...document.querySelectorAll("aside span")].find((s) => s.textContent === "会话");
  const nameAt = (long) => {
    const node = [...document.querySelectorAll("aside span")].flatMap((s) => [...s.childNodes]).find((n) => n.nodeType === 3 && n.data === long);
    if (!node) return { visible: -1, rowTitle: null };
    let clip = node.parentElement;
    while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const right = clip.getBoundingClientRect().right - 8; // 省略号约一个字宽
    const r = document.createRange();
    let visible = 0;
    for (let i = 0; i < node.data.length; i++) { r.setStart(node, i); r.setEnd(node, i + 1); if (r.getBoundingClientRect().right <= right) visible++; else break; }
    return { visible, rowTitle: node.parentElement.closest("button").getAttribute("title") };
  };
  const named = Object.fromEntries(names.map((n) => [n, nameAt(n)]));
  const { visible, rowTitle } = named[names[0]];
  const text = (el) => (el?.innerText ?? "").trim();
  const chips = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.closest("#cstra-chip-legend"))
    .map((el) => ({ text: text(el), title: el.getAttribute("title"), aria: el.getAttribute("aria-label") }));
  const header = title?.closest("div");
  const buttons = header ? [...header.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map((b) => b.getAttribute("aria-label")) : [];
  const termTitles = [...document.querySelectorAll("aside [title]")].filter((el) => /压缩线|硬上限|上下文边界/.test(el.getAttribute("title"))).length;
  const aside = document.querySelector("aside")?.getBoundingClientRect();
  const headerOverflow = header && aside ? Math.max(...[...header.querySelectorAll("button")].filter((b) => b.offsetParent !== null)
    .map((b) => b.getBoundingClientRect().right)) - aside.right : 0;
  const rowOverflow = Math.max(0, ...[...document.querySelectorAll("aside li button")].map((b) =>
    Math.max(...[...b.children].map((c) => c.getBoundingClientRect().right)) - b.getBoundingClientRect().right));
  return { titleLines: lines(title), visible, named, termTitles, headerOverflow, rowOverflow, rowTitle, buttons,
    stage: chips("[data-ledger-stage]"), ctx: chips("[data-chip=ctx]"), busy: chips("[data-chip=busy]"), compacting: chips("[data-chip=compacting]") };
})`;
interface Chip { text: string; title: string | null; aria: string | null }
interface Measure {
  titleLines: number; visible: number; named: Record<string, { visible: number; rowTitle: string | null }>; termTitles: number;
  headerOverflow: number; rowOverflow: number; rowTitle: string | null; buttons: string[];
  stage: Chip[]; ctx: Chip[]; busy: Chip[]; compacting: Chip[];
}
const NAMES = [LONG, LONG_ZH, LABEL_ZH];
const measure = (p: Page) => p.evaluate<Measure>(`${MEASURE}(${JSON.stringify({ names: NAMES })})`);

const TERMS = /压缩线|硬上限|上下文边界/;
const LEGEND = 'button[aria-controls="cstra-chip-legend"]';
const vis = (p: Page) => p.evaluate<string>(`getComputedStyle(document.getElementById("cstra-chip-legend")).visibility`);

/** 一份变体的三个视图 + 手机图例；返回量到的东西，截图随手拍 */
async function runViews(v: Variant) {
  const out: Record<string, { m: Measure; issues: ShotIssue[]; blocked: string[]; errors: string[] }> = {};
  for (const [width, view, narrow] of [[1280, "default", false], [1280, "narrowest", true], [390, "default", false]] as const) {
    const s = await open(v, width, { narrow });
    const m = await measure(s.page);
    out[`${width}-${view}`] = { m, issues: await shot(s.page, v, width, view), blocked: s.blocked, errors: s.errors };
    if (width === 390) {
      // 改前没有图例图标：同一状态再拍一张作对照
      if (v === "after") {
        await s.page.click(LEGEND);
        await s.page.waitForTimeout(300);
      }
      out["390-legend"] = { m, issues: await shot(s.page, v, width, "legend"), blocked: s.blocked, errors: s.errors };
    }
    await s.ctx.close();
  }
  return out;
}

test.skipIf(!enabled)("before (base): 「会话」在 1280 折成两行、长名字只剩几个字母、芯片 title 是术语", async () => {
  const r = await runViews("before");
  for (const k of Object.keys(r)) {
    expect(r[k].blocked).toEqual([]);
    expect(r[k].errors).toEqual([]);
  }
  expect(r["1280-default"].m.titleLines).toBe(2);
  expect(r["1280-default"].m.visible).toBeLessThan(8);
  expect(r["1280-default"].m.termTitles).toBeGreaterThan(0);
}, 120_000);

test.skipIf(!enabled)("after: 标题一行、长名字 ≥ 8 个字、窄时芯片先缩、title 是一句话、截图无问题", async () => {
  const r = await runViews("after");
  for (const k of Object.keys(r)) {
    expect(r[k].blocked).toEqual([]);
    expect(r[k].errors).toEqual([]);
    expect([k, r[k].issues]).toEqual([k, []]);
    expect(r[k].m.titleLines).toBe(1);
    expect(r[k].m.rowTitle).toBe(LONG);
    expect(r[k].m.termTitles).toBe(0);
    // 顶栏按钮不伸出侧栏、行尾（时间）不被挤出行外
    expect([k, r[k].m.headerOverflow <= 0.5, r[k].m.rowOverflow <= 0.5]).toEqual([k, true, true]);
  }
  const d = r["1280-default"].m;
  // ASCII 长名字、中文长名字、中文显示名（后跟「| 原名」）都至少露 8 个字：1280 默认侧栏和 390 手机
  for (const k of ["1280-default", "390-default"]) for (const n of NAMES) expect([k, n, r[k].m.named[n].visible >= 8]).toEqual([k, n, true]);
  expect(d.named[LONG_ZH].rowTitle).toBe(LONG_ZH);
  expect(d.named[LABEL_ZH].rowTitle).toBe(`${LABEL_ZH} | uxside1-label-runner`);
  // 桌面 title / aria-label = 词表那句话，不含术语
  expect(d.ctx.map((c) => c.title).sort()).toEqual([EXEC, COORD, EXEC, COORD].map((b) => ctxChipWords(b, "zh")).sort());
  expect(d.stage.map((c) => c.title)).toEqual([LONG_TASK, { id: "T9", stage: "fix", round: 2 }, { id: "T11", stage: "review", round: 1 }, { id: "T12", stage: "build", round: 0 }]
    .map((t) => stageChipWords(t, "zh")));
  for (const c of [...d.ctx, ...d.stage, ...d.busy, ...d.compacting]) {
    expect(c.title).toBe(c.aria);
    expect(TERMS.test(c.title ?? "")).toBe(false);
  }
  expect(d.busy.map((c) => c.title)).toEqual([rowStateWords("busy", "zh")]);
  expect(d.compacting.map((c) => c.title)).toEqual([rowStateWords("compacting", "zh")]);
  // 拖到最窄（200px）：阶段只剩图标、上下文只剩数字、工作中 / 压缩中只剩状态点；名字后缩，仍认得出开头（改前这里一个字都不剩）
  const n = r["1280-narrowest"].m;
  expect(n.stage.every((c) => c.text === "")).toBe(true);
  expect(n.ctx.every((c) => /^-?\d+k$/.test(c.text))).toBe(true);
  expect([...n.busy, ...n.compacting].every((c) => c.text === "")).toBe(true);
  for (const name of NAMES) expect([name, n.named[name].visible >= 3]).toEqual([name, true]);
}, 120_000);

test.skipIf(!enabled)("after 390: 点图例图标出卡片，逐行真实芯片 + 同一句话；再点收起", async () => {
  const s = await open("after", 390);
  expect(await vis(s.page)).toBe("hidden");
  await s.page.click(LEGEND);
  await s.page.waitForTimeout(300);
  expect(await vis(s.page)).toBe("visible");
  const rows = await s.page.evaluate<{ chip: boolean; text: string }[]>(`[...document.querySelectorAll("#cstra-chip-legend [data-legend-row]")]
    .map((el) => ({ chip: !!el.querySelector("[data-chip],[data-ledger-stage]"), text: el.lastElementChild.innerText }))`);
  expect(rows.length).toBe(11);
  expect(rows.every((x) => x.chip && x.text.length > 4)).toBe(true);
  expect(rows.map((x) => x.text)).toContain(rowStateWords("busy", "zh"));
  expect(rows.map((x) => x.text)).toContain(ctxChipWords({ policy: "coordinator", window: 200_000, hardCap: 250_000, remaining: 77_000, level: "ok" }, "zh"));
  await s.page.click(LEGEND);
  await s.page.waitForTimeout(300);
  expect(await vis(s.page)).toBe("hidden");
  expect(s.blocked).toEqual([]);
  expect(s.errors).toEqual([]);
  await s.ctx.close();
}, 60_000);

test.skipIf(!enabled)("顶栏按钮与 BASE 一致：全权 + shells 200 / 非全权 + shells 403", async () => {
  for (const o of [{ full: true, shells: 200 as const }, { full: false, shells: 403 as const }]) {
    const got: Record<Variant, string[]> = { before: [], after: [] };
    for (const v of ["before", "after"] as const) {
      const s = await open(v, 1280, o);
      got[v] = (await measure(s.page)).buttons;
      await s.ctx.close();
    }
    expect(got.after).toEqual(got.before);
    expect(got.after.includes("新终端")).toBe(o.shells === 200);
    expect(got.after.includes("项目管理")).toBe(o.full);
  }
}, 120_000);

test("sidebar.tsx 变短、设置图标不再内联", () => {
  const src = readFileSync(join(comp, "sidebar.tsx"), "utf8");
  const limit = JSON.parse(readFileSync(resolve("scripts/guard/baseline.json"), "utf8")).limits["size:web/features/chat/components/sidebar.tsx"] as number;
  expect(src.split("\n").length).toBeLessThan(limit);
  expect(src).not.toContain("M12.22 2h-.44");
});
