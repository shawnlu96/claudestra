/**
 * list-recovery-AGL2：会话列表首拉失败 / 刷新失败在真 Chrome 里的样子，修前修后对照（opt-in）：
 *   AGENT_LIST_BROWSER=1 bun test tests/web-agent-list-recovery-browser.test.ts
 * 可选：AGENT_LIST_SHOTS_DIR=<仓库外私密目录> 存 1200 / 390 × 浅 / 深 × 中 / 英 的前后 PNG 和 manifest.json（含 sha256）；
 * AGENT_LIST_BASELINE=<sha> 指定「修前」（默认 031ea3fc = 开卡时的 main）。
 * 对照基准（manifest.basis 原样写出）：before = BASELINE 的 web/（git archive 导出到临时目录，共用本仓 web/node_modules）；
 * after = 当前工作区；同输入 = 同一入口（真 ChatStoreProvider + 真 Sidebar + 真 Splash，接线同 chat.tsx）+ 同一份合成 API + 同视口 / DPR。
 * 页面只经回环 127.0.0.1 提供，合成 API 也在这个回环服务里（GET /api/v1/agents 由测试切换 ok / 503），非回环请求一律拦下并判失败。
 * 构建时换成空壳的只有 build-info（构建期才生成，跟本卡无关）；其余 /api/v1/* 由回环夹具答 404。
 * 场景 A 首拉一直 503：修前 Splash 退场后侧栏写「暂无会话」（误报），修后启动页说明失败 + 重试 / 先进入，进入后侧栏仍是失败态。
 * 场景 B 拿到列表后刷新 503：修前修后列表都保留；修后顶部多一条「列表刷新失败，显示的是上次的结果」。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.AGENT_LIST_BROWSER === "1";
const shots = process.env.AGENT_LIST_SHOTS_DIR;
const BASELINE = process.env.AGENT_LIST_BASELINE ?? "031ea3fc";
const web = resolve("web");
type Variant = "before" | "after";
const WIDTHS = [1200, 390] as const;
const THEMES = ["light", "dark"] as const;
const LANGS = ["zh", "en"] as const;
const VIEWPORT = { height: 844, deviceScaleFactor: 2 };
const STEPS = ["A1-first-load-failing", "A2-after-enter", "B1-refresh-failed"] as const;
const servers: Partial<Record<Variant, ReturnType<typeof Bun.serve>>> = {};
const manifest: { file: string; variant: Variant; width: number; theme: string; lang: string; step: string; sha256: string; source: string; fixture: true }[] = [];
const cleanup: string[] = [];
let browser: Browser;
let basis: Record<string, unknown> | undefined;
/** 合成 API 的当前答法 */
let apiMode: "fail" | "ok" = "fail";

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

/** 合成会话（同一份给前后两版）：一个 project 下 lead→kid，另有 dev 与一个停掉的 old */
const fixture = JSON.stringify([
  { name: "agent-lead", status: "active", projectId: "demo", lastActivityTs: 1_800_000_000_000, purpose: "fixture lead" },
  { name: "agent-kid", status: "active", projectId: "demo", parent: "lead", lastActivityTs: 1_799_999_000_000, purpose: "fixture child" },
  { name: "agent-dev", status: "active", lastActivityTs: 1_799_998_000_000, purpose: "fixture dev" },
  { name: "agent-old", status: "stopped", lastActivityTs: 1_799_000_000_000, purpose: "fixture stopped" },
]);

/** 入口：与 chat.tsx 同接线（有 startAgentList 就挂上；修前没有），window.__store 供测试触发一次刷新 */
const ENTRY = `import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import { ChatStoreProvider, useChatStoreApi } from "../chat-store";
import { Sidebar } from "./sidebar";
import { Splash } from "./splash";
const q = new URLSearchParams(location.search);
setLang(q.get("lang") === "en" ? "en" : "zh");
document.documentElement.dataset.theme = q.get("theme") || "light";
function Wire() {
  const store = useChatStoreApi();
  useEffect(() => {
    window.__store = store;
    const stop = typeof store.startAgentList === "function" ? store.startAgentList() : () => {};
    void store.loadAgents();
    return stop;
  }, [store]);
  return null;
}
createRoot(document.getElementById("root")).render(
  <ChatStoreProvider><Wire />
    <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content">
      <div className="bg-warning px-3 py-1 text-xs font-semibold text-black">合成夹具 · 非生产页面 · AGL2 __VARIANT__</div>
      <div className="flex min-h-0 flex-1"><Sidebar onSelect={() => {}} /></div>
    </div>
    <Splash />
  </ChatStoreProvider>);
window.ready = true;
`;

/** 子进程里跑 Bun.build（bun test 进程内带插件构建时相对路径解析不到） */
const BUILD = `
const map = {
  "build-info": "export const CLIENT_COMMIT = ''; export const CLIENT_WEB_COMMIT = ''; export const CLIENT_VERSION = '';",
};
const stubs = { name: "agl2-stubs", setup(b) {
  b.onResolve({ filter: /(^|\\/)build-info$/ }, (a) => ({ path: a.path.split("/").pop(), namespace: "agl2-stub" }));
  b.onLoad({ filter: /.*/, namespace: "agl2-stub" }, (a) => ({ contents: map[a.path], loader: "js" }));
} };
const [entry, outdir] = process.argv.slice(-2);
const r = await Bun.build({ entrypoints: [entry], target: "browser", outdir, plugins: [stubs], define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1); }
`;

async function css(root: string) {
  const req = createRequire(join(web, "package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = join(root, "app/globals.css");
  return (await postcss([tw({ base: root })]).process(readFileSync(from, "utf8"), { from })).css;
}

/** 修前：git archive 导出 BASELINE 的 web/ 到临时目录，node_modules 软链到本仓 */
async function beforeRoot(commit: string) {
  const dir = mkdtempSync(join(tmpdir(), "agl2-before-"));
  cleanup.push(dir);
  const tar = Bun.spawn(["sh", "-c", `git archive ${commit} web | tar -x -C ${dir}`], { stderr: "pipe" });
  if (await tar.exited) throw new Error(await new Response(tar.stderr).text());
  symlinkSync(join(web, "node_modules"), join(dir, "web/node_modules"));
  return join(dir, "web");
}

async function serve(v: Variant, root: string) {
  const entry = join(root, "features/chat/components", `.agl2-shot-${v}.tsx`);
  await Bun.write(entry, ENTRY.replace("__VARIANT__", v));
  let js: string, out: string;
  try {
    out = mkdtempSync(join(tmpdir(), `agl2-${v}-out-`));
    cleanup.push(out);
    const build = Bun.spawn([process.execPath, "-e", BUILD, entry, out], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    js = readdirSync(out).find((f) => f.endsWith(".js"))!;
  } finally { unlinkSync(entry); }
  const style = await css(root);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === `/${js}`) return new Response(Bun.file(join(out, js)));
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === "/api/v1/agents") return apiMode === "ok" ? json({ ok: true, agents: JSON.parse(fixture) }) : json({ ok: false, error: "fixture 503" }, 503);
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head>
      <body><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } };</script>
      <script type="module" src="/${js}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
}

beforeAll(async () => {
  if (!enabled) return;
  const before = await git("rev-parse", "--verify", `${BASELINE}^{commit}`);
  // 基点必须真是旧行为：失败也置 agentsReady（Splash 退场 → 侧栏「暂无会话」），否则对照不成立
  const oldStore = await git("show", `${before}:web/features/chat/chat-store.ts`);
  if (!/s\.agentsReady = true; \/\/ 失败也算入场结束/.test(oldStore)) throw new Error(`baseline ${before} is not the pre-AGL2 list loader`);
  basis = {
    before: { commit: before, source: "git archive of web/", note: "main at card start; failed first load sets agentsReady=true" },
    after: { commit: await git("rev-parse", "HEAD"), source: "working tree" },
    sameInput: { fixture: "synthetic, not a production page", fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
      entrySha256: createHash("sha256").update(ENTRY).digest("hex"), steps: STEPS, viewport: VIEWPORT },
    scope: { widths: WIDTHS, themes: THEMES, langs: LANGS, variants: ["before", "after"] },
  };
  servers.before = await serve("before", await beforeRoot(before));
  servers.after = await serve("after", web);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 180_000);

afterAll(async () => {
  await browser?.close(); servers.before?.stop(true); servers.after?.stop(true);
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  if (!shots || !manifest.length) return;
  writeFileSync(join(shots, "manifest.json"), JSON.stringify({ card: "list-recovery-AGL2", fixture: "synthetic, not a production page",
    basis, afterDirty: (await git("status", "--porcelain", "--", "web", "tests")) !== "", shots: manifest }, null, 2));
});

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;

async function shot(p: Page, v: Variant, width: number, theme: string, lang: string, step: (typeof STEPS)[number]) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const file = `${v}-${width}-${theme}-${lang}-${step}.png`;
  await p.screenshot({ path: join(shots, file) });
  manifest.push({ file, variant: v, width, theme, lang, step, sha256: createHash("sha256").update(readFileSync(join(shots, file))).digest("hex"),
    source: v === "before" ? (basis?.before as { commit: string }).commit : "working tree", fixture: true });
}

const asideText = (p: Page) => p.evaluate("document.querySelector('aside')?.innerText ?? ''") as Promise<string>;
const splashUp = (p: Page) => p.evaluate("!!document.querySelector('.fixed.inset-0.z-\\\\[60\\\\]')") as Promise<boolean>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(v: Variant, width: number, theme: "light" | "dark", lang: "zh" | "en") {
  const ctx = await browser.newContext({ viewport: { width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.deviceScaleFactor, colorScheme: theme });
  const blocked: string[] = [], errors: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const consoleErrors: string[] = []; // 合成 API 的 503 / 404 会在这里出现，只在加载超时时用来定位
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const url = `${servers[v]!.url}?theme=${theme}&lang=${lang}`;
  // A：首拉一直失败
  apiMode = "fail";
  await page.goto(url);
  await page.waitForFunction("window.ready", undefined, { timeout: 15_000 }).catch((e) => { throw new Error(`${e}\n${[...errors, ...consoleErrors].join("\n")}`); });
  await wait(4_000);
  const a1 = { splash: await splashUp(page), text: (await page.evaluate("document.body.innerText")) as string };
  await shot(page, v, width, theme, lang, STEPS[0]);
  const enter = page.getByRole("button", { name: lang === "en" ? "Continue anyway" : "先进入" });
  if (await enter.count()) await enter.click();
  await wait(1_300);
  const a2 = { splash: await splashUp(page), aside: await asideText(page) };
  await shot(page, v, width, theme, lang, STEPS[1]);
  // B：拿到列表后刷新失败
  apiMode = "ok";
  await page.goto(url);
  await page.waitForFunction("document.querySelector('aside')?.innerText.includes('lead')");
  await wait(1_300);
  apiMode = "fail";
  await page.evaluate("window.__store.refreshAgents('poll')");
  await wait(400);
  const b1 = { aside: await asideText(page), overflow: await page.evaluate("document.documentElement.scrollWidth > innerWidth") };
  await shot(page, v, width, theme, lang, STEPS[2]);
  await ctx.close();
  return { a1, a2, b1, blocked, errors };
}

const EMPTY = { zh: "暂无会话", en: "No sessions" };

test.skipIf(!enabled)("old red: a failed first load drops the splash and claims there are no sessions", async () => {
  for (const width of WIDTHS) for (const theme of THEMES) for (const lang of LANGS) {
    const r = await run("before", width, theme, lang);
    expect(r.blocked).toEqual([]);
    expect(r.a1.splash).toBe(false);
    expect(r.a2.aside).toContain(EMPTY[lang]);
    expect(r.b1.aside).toContain("lead"); // 刷新失败本来就保留列表，只是没有任何提示
  }
}, 300_000);

test.skipIf(!enabled)("new green: failing first load is explained, can be entered without faking success; failed refresh keeps the list with a notice", async () => {
  for (const width of WIDTHS) for (const theme of THEMES) for (const lang of LANGS) {
    const r = await run("after", width, theme, lang);
    expect(r.blocked).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.a1.splash).toBe(true);
    expect(r.a1.text).toContain(lang === "en" ? "Couldn't load the session list" : "会话列表加载失败");
    expect(r.a2.splash).toBe(false);
    expect(r.a2.aside).not.toContain(EMPTY[lang]);
    expect(r.a2.aside).toContain(lang === "en" ? "Couldn't load the session list" : "会话列表加载失败");
    expect(r.b1.aside).toContain("lead");
    expect(r.b1.aside).toContain(lang === "en" ? "Refresh failed — showing the last loaded list" : "列表刷新失败，显示的是上次的结果");
    expect(r.b1.overflow).toBe(false);
  }
}, 300_000);
