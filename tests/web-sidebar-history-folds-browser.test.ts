/**
 * followup-reliability-SBH2：活 / 历史目录折叠偏好分开保存，在真 Chrome 里点 + 刷新（opt-in）：
 *   SIDEBAR_HISTORY_BROWSER=1 bun test tests/web-sidebar-history-folds-browser.test.ts
 * 可选：SIDEBAR_HISTORY_SHOTS_DIR=<仓库外私密目录> 存 1200 / 390 × 浅 / 深的前后 PNG 和 manifest.json（含 sha256）；
 * SIDEBAR_HISTORY_BASELINE=<sha> 指定「修前」的 sidebar-history.ts/.tsx（默认是本卡把旧接线原样抽成 SidebarDirectory 的那次提交）。
 * 对照基准（manifest.basis 原样写出，供 PM 认可 / 核对）：
 *   before = BASELINE 解析出的完整 sha，其父提交即开卡时的 main；该提交只把 sidebar.tsx 里的旧接线原样抽出，历史仍用活目录的
 *            cstra_proj_collapsed / cstra_team_collapsed（beforeAll 里核实，不是就判失败——基点不能悄悄换成别的东西）；
 *   after  = 当前 HEAD 的工作区；
 *   同输入 = 同一份合成夹具（manifest 记 sha256）+ 同一组操作 + 同视口 / DPR；对照范围 = 1200 / 390 × 浅 / 深 × 三步。
 *   main 上旧代码没有 SidebarDirectory，夹具挂不上，所以基点取这次「原样抽出」而不是 main 本身。
 * 页面是合成夹具（顶部标「合成夹具 · 非生产页面」），真组件 SidebarDirectory + ProjectGroup + TeamGroup + HistoryFold + 真 Tailwind/daisyUI 样式；
 * 行是简化行（不是 AgentRow），拖拽 / 菜单 / 本机探测 / 协作入口在构建时换成空壳；只经回环 127.0.0.1 提供页面，非回环请求一律拦下并判失败。
 * 同一组操作：打开历史 → 折叠历史里的 project p → 刷新。修前必须红（活组跟着收起），修后必须绿（活组仍展开、历史组仍收起）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.SIDEBAR_HISTORY_BROWSER === "1";
const shots = process.env.SIDEBAR_HISTORY_SHOTS_DIR;
const BASELINE = process.env.SIDEBAR_HISTORY_BASELINE ?? "dd1f99b4";
const web = resolve("web");
const dir = join(web, "features/chat/components");
type Variant = "before" | "after";
const servers: Partial<Record<Variant, ReturnType<typeof Bun.serve>>> = {};
const manifest: { file: string; variant: Variant; width: number; theme: string; step: string; sha256: string; source: string; fixture: true }[] = [];
let browser: Browser;
let basis: Record<string, unknown> | undefined;
const STEPS = ["1-history-open", "2-history-p-collapsed", "3-after-reload"] as const;
const VIEWPORT = { height: 844, deviceScaleFactor: 2 };
const WIDTHS = [1200, 390] as const;
const THEMES = ["light", "dark"] as const;

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

// 合成夹具：同一个 project p 既有活的（lead→kid、dev）也有停掉的（old→oldkid、olddev），另有 creating 的 fresh
const fixture = `
const ag = (name, p = {}) => ({ name, displayName: name, purpose: "", status: "active", lastActivityTs: 1000, projectId: "p", ...p });
const AGENTS = [ag("lead"), ag("kid", { parent: "lead" }), ag("dev"), ag("fresh", { status: "creating", lastActivityTs: null }),
  ag("old", { status: "stopped" }), ag("oldkid", { status: "stopped", parent: "old" }), ag("olddev", { status: "stopped" })];
const META = new Map([["p", { id: "p", name: "Same project", emoji: "", dirs: [] }]]);
`;

function entry(v: Variant) {
  const ui = v === "before" ? "./.sbh2-before-ui" : "./sidebar-history";
  const logic = v === "before" ? "./.sbh2-before-logic" : "../sidebar-history";
  return `import React from "react";import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import { SidebarDirectory, useDirectoryFolds } from "${ui}";
import { buildSidebarDirectory } from "${logic}";
import { ProjectGroup } from "./project-group";
import { TeamGroup } from "./team-group";
${fixture}
setLang("zh");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "dark";
const row = (a, s) => <li key={a.name} data-agent={a.name}>
  <div className="flex items-center gap-2 rounded-lg bg-base-100/60 px-2 py-1.5 text-sm text-base-content">
    {s?.lead}{a.name}<span className="ml-auto text-[11px] text-base-content/40">{a.status}</span>
  </div>
</li>;
function App() {
  const activeFolds = useDirectoryFolds("active");
  const d = buildSidebarDirectory(AGENTS, META);
  // 修前的 folds 只有 teams / toggleTeam；修后（WKV1）换成 team(name, kids)
  const tf = (n, f) => f.team ? f.team(n.a.name, n.children) : { collapsed: f.teams.has(n.a.name), toggle: () => f.toggleTeam(n.a.name) };
  const team = (n, f) => <TeamGroup key={"t:" + n.a.name} node={n} collapsed={tf(n, f).collapsed} busy={false} onToggle={tf(n, f).toggle} row={row} />;
  const renderEntry = (e, f) => e.kind === "row" ? team(e, f)
    : <ProjectGroup key={"g:" + e.id} e={e} collapsed={f.projects.has(e.id)} groupBusy={false} onToggle={() => f.toggleProject(e.id)}>{e.nodes.map((n) => team(n, f))}</ProjectGroup>;
  return <div className="min-h-screen bg-base-100 text-base-content">
    <div className="bg-warning px-3 py-1 text-xs font-semibold text-black">合成夹具 · 非生产页面 · SBH2 ${v}</div>
    <aside className="flex w-full flex-col bg-base-200 px-3 py-3 sm:w-64">
      <SidebarDirectory activeEntries={d.activeEntries} historyEntries={d.historyEntries} historyCount={d.historyCount} activeFolds={activeFolds} renderEntry={renderEntry} />
    </aside>
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
window.ready = true;
`;
}

/**
 * 构建时换成空壳：拖拽放置、本机探测、manage 判定、协作入口跟本卡无关，且会出网。
 * 放子进程里跑 Bun.build——在 bun test 进程内带插件构建时相对路径解析不到。
 */
const BUILD = `
const map = {
  "agent-dnd": "export const useAgentDrop = () => ({ over: false, handlers: {} });",
  "host-info": "export const useHostInfo = () => ({ local: false, platform: 'darwin', openers: [] }); export const openLocal = async () => ({ ok: true });",
  "contacts-data": "export const useFullScope = () => false;",
  "collab-entry": "export const CollabEntry = () => null;",
};
const stubs = { name: "sbh2-stubs", setup(b) {
  b.onResolve({ filter: /(^|\\/)(agent-dnd|host-info|contacts-data|collab-entry)$/ }, (a) => ({ path: a.path.split("/").pop(), namespace: "sbh2-stub" }));
  b.onLoad({ filter: /.*/, namespace: "sbh2-stub" }, (a) => ({ contents: map[a.path], loader: "js" }));
} };
const [entry, outdir] = process.argv.slice(-2);
const r = await Bun.build({ entrypoints: [entry], target: "browser", outdir, plugins: [stubs], define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1); }
`;

async function css() {
  const req = createRequire(join(web, "package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = join(web, "app/globals.css");
  return (await postcss([tw({ base: web })]).process(readFileSync(from, "utf8"), { from })).css;
}

async function serve(v: Variant) {
  const tmp: string[] = [];
  const put = async (name: string, body: string) => { const p = join(dir, name); tmp.push(p); await Bun.write(p, body); };
  try {
    if (v === "before") {
      await put(".sbh2-before-ui.tsx", (await git("show", `${BASELINE}:web/features/chat/components/sidebar-history.tsx`))
        .replaceAll('"../sidebar-history"', '"./.sbh2-before-logic"'));
      await put(".sbh2-before-logic.ts", (await git("show", `${BASELINE}:web/features/chat/sidebar-history.ts`)).replaceAll('"./', '"../'));
    }
    await put(`.sbh2-shot-${v}.tsx`, entry(v));
    const style = await css();
    const out = mkdtempSync(join(tmpdir(), `sbh2-${v}-`));
    const build = Bun.spawn([process.execPath, "-e", BUILD, join(dir, `.sbh2-shot-${v}.tsx`), out], { cwd: web, stdout: "pipe", stderr: "pipe" });
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    const js = readdirSync(out).find((f) => f.endsWith(".js"))!;
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/${js}`) return new Response(Bun.file(join(out, js)));
      if (path !== "/") return new Response(null, { status: 404 });
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head>
        <body><div id="root"></div><script src="/${js}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
  } finally { for (const p of tmp) unlinkSync(p); }
}

/** 核实「修前」基点确实是旧的共用 key 接线、「修后」确实是独立命名空间，并写出对照基准 */
async function resolveBasis() {
  const before = await git("rev-parse", "--verify", `${BASELINE}^{commit}`);
  const keys = (src: string) => /history:\s*\{\s*projects:\s*"([^"]+)",\s*teams:\s*"([^"]+)"/.exec(src)?.slice(1);
  const beforeKeys = keys(await git("show", `${before}:web/features/chat/sidebar-history.ts`));
  const afterKeys = keys(readFileSync(join(web, "features/chat/sidebar-history.ts"), "utf8"));
  if (beforeKeys?.join() !== "cstra_proj_collapsed,cstra_team_collapsed")
    throw new Error(`baseline ${before} is not the shared-key wiring: history keys = ${beforeKeys}`);
  if (afterKeys?.join() !== "cstra_history_proj_collapsed,cstra_history_team_collapsed")
    throw new Error(`working tree history keys = ${afterKeys}`);
  return {
    approval: "proposed by executor; spec specRev 1 has no '## 对照基准' — PM to accept or replace",
    before: { commit: before, parent: await git("rev-parse", `${before}^`), historyKeys: beforeKeys,
      note: "old sidebar.tsx wiring extracted verbatim into SidebarDirectory; history shares the active fold keys" },
    after: { commit: await git("rev-parse", "HEAD"), source: "working tree", historyKeys: afterKeys },
    sameInput: { fixture: "synthetic, not a production page", fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
      steps: STEPS, viewport: VIEWPORT },
    scope: { widths: WIDTHS, themes: THEMES, variants: ["before", "after"] },
  };
}

beforeAll(async () => {
  if (!enabled) return;
  basis = await resolveBasis();
  servers.before = await serve("before");
  servers.after = await serve("after");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);
afterAll(async () => {
  await browser?.close(); servers.before?.stop(true); servers.after?.stop(true);
  if (!shots || !manifest.length) return;
  writeFileSync(join(shots, "manifest.json"), JSON.stringify({ card: "followup-reliability-SBH2", fixture: "synthetic, not a production page",
    basis, afterDirty: (await git("status", "--porcelain", "--", "web")) !== "", shots: manifest }, null, 2));
});

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;

async function shot(p: Page, v: Variant, width: number, theme: string, step: (typeof STEPS)[number]) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const file = `${v}-${width}-${theme}-${step}.png`;
  await p.screenshot({ path: join(shots, file), fullPage: true });
  manifest.push({ file, variant: v, width, theme, step, sha256: createHash("sha256").update(readFileSync(join(shots, file))).digest("hex"),
    source: v === "before" ? (basis?.before as { commit: string }).commit : "working tree", fixture: true });
}

const shown = (p: Page) => p.$$eval("[data-agent]", (els) => els.map((e) => e.getAttribute("data-agent")));
const heads = (p: Page) => p.locator("button", { hasText: "Same project" });

/** 打开历史 → 折叠历史里的 p → 刷新；返回刷新前后可见的会话 */
async function run(v: Variant, width: number, theme: "light" | "dark") {
  const ctx = await browser.newContext({ viewport: { width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.deviceScaleFactor, colorScheme: theme });
  const blocked: string[] = [], errors: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const load = async () => { await page.waitForFunction("window.ready && document.querySelector('button[aria-expanded]')"); await page.evaluate("document.fonts.ready"); };
  await page.goto(`${servers[v]!.url}?theme=${theme}`);
  await load();
  const initial = await shown(page);
  await page.getByRole("button", { name: /历史/ }).click();
  await shot(page, v, width, theme, STEPS[0]);
  await heads(page).nth(1).click();
  const afterClick = await shown(page);
  await shot(page, v, width, theme, STEPS[1]);
  await page.reload();
  await load();
  const afterReload = await shown(page);
  const headCount = await heads(page).count();
  await shot(page, v, width, theme, STEPS[2]);
  const overflow = await page.evaluate("document.documentElement.scrollWidth > innerWidth");
  await ctx.close();
  return { initial, afterClick, afterReload, headCount, overflow, blocked, errors };
}

const LIVE = ["lead", "kid", "dev", "fresh"];

test.skipIf(!enabled)("old red: collapsing p in history also collapses the live p group (shared fold key)", async () => {
  for (const width of WIDTHS) for (const theme of THEMES) {
    const r = await run("before", width, theme);
    expect(r.blocked).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.initial).toEqual(LIVE);
    // 修前：点历史组头，活组也一起收起——两组都只剩组头
    expect(r.afterClick).toEqual([]);
    expect(r.afterReload).toEqual([]);
  }
}, 120_000);

test.skipIf(!enabled)("new green: live and history groups of the same project fold independently and survive reload", async () => {
  for (const width of WIDTHS) for (const theme of THEMES) {
    const r = await run("after", width, theme);
    expect(r.blocked).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.overflow).toBe(false);
    expect(r.initial).toEqual(LIVE); // active / creating 默认可达，历史默认收起
    expect(r.afterClick).toEqual(LIVE);
    expect(r.afterReload).toEqual(LIVE); // 刷新：历史仍打开、历史 p 仍收起，活 p 仍展开
    expect(r.headCount).toBe(2);
  }
}, 120_000);
