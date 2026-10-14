/**
 * UXTERM1 A 段截图与 DOM 断言（opt-in，截图不进 git）：
 *   OWNER_WORDS_SHOTS_DIR=<仓库外目录> [OWNER_WORDS_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-owner-words-browser.test.ts
 * 页面是合成夹具，内联在本文件里、打包到截图目录：
 *   sidebar = 三个会话行（简化行 + 真 LpBadge），分别是 low-priority 开着、用完、额度用完在等；
 *   lend    = 真 LendPanel（设置 → 借出）：一条授权（Codex 同时 3 个、每天 50 个）、两条借出中的活、额度线处在提醒态。
 * 1280 与 390、浅色；中文各拍一张，英文只断言不拍。给了 OWNER_WORDS_BASE_REPO 就用同一份数据再拍一套「改前」（只断言改前的现状）。
 * 改后每页的 document.body.innerText 不含 BANNED_OWNER_WORDS，英文下不出现 LP / feature；shotIssues 为空。
 * 回环 Bun.serve，非回环请求一律拦掉并断言为 0。协作视图那几页属于 B 段（UXTERM2）。
 */
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BANNED_OWNER_WORDS } from "../web/lib/owner-words";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.OWNER_WORDS_SHOTS_DIR, baseRepo = process.env.OWNER_WORDS_BASE_REPO;
const NOW = Date.parse("2026-10-14T04:00:00Z");
const VIEWS = ["sidebar", "lend"] as const;
type View = (typeof VIEWS)[number];

/** 每页必须出现的词：改前是旧词，改后是词表里的新词 */
const EXPECT: Record<"before" | "after", Record<View, string[]>> = {
  before: { sidebar: ["LP→15:00", "LP 已用完", "撞墙中"], lend: ["借出中的单", "停接线", "codex 3 · 50/d", "该家族"] },
  after: { sidebar: ["排队→15:00", "低优先级用完", "额度用完，等重置"],
    lend: ["借出中的活", "不再接新活", "同时 Codex 3 个 · 每天 50 个", "能同时跑的数量减半"] },
};

const fam = (family: string, over: Record<string, unknown>) => ({ family, warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: NOW + 3 * 86_400_000,
  observedAt: NOW - 60_000, source: "live", freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 3, lineCap: 3,
  available: 3, slots: 3, ...over });
const order = (n: number, over: Record<string, unknown>) => ({ orderId: `order-${n}`, peer: "team-a", family: "codex", state: "running", repo: "acme/shop",
  pr: 40 + n, taskId: `i9-T${n}`, step: "write", agent: `agent-lend-${n}`, startedAt: NOW - n * 600_000, updatedAt: NOW - 60_000, reason: null,
  notices: { start: NOW - n * 600_000 }, live: true, ...over });
const API: Record<string, unknown> = {
  "/app-config.json": { mode: "direct", fp: "local", machineName: "fixture" },
  "/api/v1/lend/grants": { writeOpen: true, maxDays: 7, shellSentence: "", peers: [{ name: "team-a", fp: "a".repeat(16) }],
    grants: [{ peer: "team-a", repos: ["acme/shop"], roles: ["write", "review"], families: { codex: 3 }, ordersPerDay: 50,
      until: new Date(NOW + 6 * 86_400_000).toISOString(), grantedAt: new Date(NOW - 86_400_000).toISOString(), paused: null, problem: null }],
    orders: [order(1, {}), order(2, { step: "review" })] },
  "/api/v1/lend/quota-lines": { ok: true, config: { status: "ok", error: null, mode: "on" }, at: NOW,
    families: [fam("codex", { weekUsedPct: 74, state: "warn", limit: "half", wouldLimit: "half", lineCap: 1, available: 1, slots: 1 }), fam("claude", { granted: 0, slots: 0 })] },
  "/api/v1/lend/claude-token": { loggedIn: true, reason: null, legacyTokenFile: null, legacyTokenEnv: false },
};

/** 入口放在仓库外（截图目录）：react 按 web/node_modules 里的路径引，不写 JSX；改前 / 改后同一份入口，只换仓库 */
async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { setLang } from ${from("web/lib/i18n.tsx")};
import { LpBadge } from ${from("web/features/fleet/lp-badge.tsx")};
import { LendPanel } from ${from("web/features/lend/lend-panel.tsx")};
import { ChatStoreProvider } from ${from("web/features/chat/chat-store.ts")};
const q = new URLSearchParams(location.search);
setLang(q.get("lang") === "en" ? "en" : "zh");
const lp = (over) => ({ lowPriority: "off", walled: false, offer: false, at: 0, ...over });
const SESSIONS = [["checkout-api", lp({ lowPriority: "on", resetsAt: "15:00", allowancePct: 40 })],
  ["search-index", lp({ lowPriority: "exhausted" })], ["billing-sync", lp({ walled: true, resetsAt: "15:00" })]];
const row = ([name, state]) => h("li", { key: name, className: "flex items-center gap-2 rounded-lg bg-base-100 px-3 py-2 text-sm" },
  h("span", { className: "min-w-0 flex-1 truncate" }, name), h(LpBadge, { lp: state }));
const sidebar = h("aside", { className: "w-72 max-w-full space-y-1 rounded-xl bg-base-200/60 p-2" }, h("ul", { className: "space-y-1" }, SESSIONS.map(row)));
const lend = h(ChatStoreProvider, null, h("div", { className: "mx-auto max-w-2xl" }, h(LendPanel)));
createRoot(document.getElementById("root")).render(h("main", { className: "min-h-screen bg-base-100 p-4 text-base-content" },
  h("p", { className: "pb-2 text-[11px] text-base-content/40" }, "synthetic fixture"), q.get("view") === "lend" ? lend : sidebar));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"),
    "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 生产的 Tailwind 样式表（web/app/globals.css） */
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

function serve(dist: string, tw: string) {
  const files = readdirSync(dist), links = files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("");
  const page = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css">${links}</head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (files.includes(path.slice(1))) return new Response(Bun.file(resolve(dist, path.slice(1))));
    return Object.hasOwn(API, path) ? Response.json(API[path]) : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  } });
}

test.skipIf(!out)("UXTERM1 A 段：侧栏 low-priority 徽章与借出页，1280 与 390 改前改后，改后不含禁用词", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before" as const, repo: resolve(baseRepo) }] : []), { label: "after" as const, repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {}, texts: Record<string, string> = {};
  try {
    for (const { label, repo } of sides) {
      const server = serve(await bundle(repo, resolve(out, `bundle-${label}`)), await tailwindCss(repo));
      try {
        for (const width of [1280, 390]) for (const view of VIEWS) for (const lang of ["zh", "en"] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.install({ time: NOW });
          await g.page.goto(`${server.url}?view=${view}&lang=${lang}`);
          await (view === "lend" ? g.page.getByTestId("lend-quota-settings") : g.page.locator("li").nth(2)).waitFor();
          if (view === "lend") await g.page.locator(".font-mono", { hasText: "acme/shop#42" }).first().waitFor();
          await g.page.evaluate("document.fonts.ready");
          const name = `${label}-${view}-${width}${lang === "en" ? "-en" : ""}`, text = await g.page.evaluate<string>("document.body.innerText");
          texts[name] = text;
          requests[name] = { external: [...g.external], errors: [...g.errors] };
          if (lang === "zh") {
            await g.page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
            issues[name] = await shotIssues(g.page);
            expect({ name, missing: EXPECT[label][view].filter((w) => !text.includes(w)) }).toEqual({ name, missing: [] });
          }
          if (label === "after") {
            expect({ name, banned: BANNED_OWNER_WORDS.filter((w) => text.includes(w)) }).toEqual({ name, banned: [] });
            if (lang === "en") expect({ name, hit: text.match(/\bLP\b|feature/i)?.[0] ?? null }).toEqual({ name, hit: null });
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, "inner-text.json"), JSON.stringify(texts, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
