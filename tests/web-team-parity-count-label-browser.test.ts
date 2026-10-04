/**
 * team-parity-Bc2：手机子 DAG 框头的未知计数（英文 Unknown / 中文 暂无）在真 Chrome 里完整可读（opt-in）：
 *   COUNT_LABEL_BROWSER=1 bun test tests/web-team-parity-count-label-browser.test.ts
 * 可选：COUNT_LABEL_SHOTS_DIR=<仓库外私密目录> 存前后 PNG；COUNT_LABEL_BASELINE=<sha> 指定「修前」源码（默认 cc74b627）。
 * 夹具全是合成 FeatureCard（activeUnknown=true / known 0 / 多位数），只经回环 127.0.0.1 提供页面，任何非回环 HTTP / WebSocket 都被拦下并判失败。
 * 「修前」用 git show 取基线的 dag-mobile.tsx / dag-canvas.tsx / dag.module.css 写成临时文件同场构建，同一组断言：修前必须红、修后必须绿。
 * 可见性按 DOM 文字 Range 的真实边界对每个裁切祖先（overflow 非 visible）比，不信 textContent。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.COUNT_LABEL_BROWSER === "1";
const shots = process.env.COUNT_LABEL_SHOTS_DIR;
const BASELINE = process.env.COUNT_LABEL_BASELINE ?? "cc74b627";
const dir = resolve("web/features/collab/dag");
type Variant = "before" | "after";
const servers: Partial<Record<Variant, ReturnType<typeof Bun.serve>>> = {};
let browser: Browser;

async function baseline(file: string) {
  const p = Bun.spawn(["git", "show", `${BASELINE}:web/features/collab/dag/${file}`], { stdout: "pipe", stderr: "pipe" });
  const src = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return src.replaceAll('"./dag-canvas"', '"./.bc2-before-canvas"').replaceAll('"./dag.module.css"', '"./.bc2-before.module.css"');
}

// 合成夹具：长标题 + 已知 0 / 多位数 + activeUnknown；不碰任何数据适配器
const fixture = `
const node = (key, phase) => ({ key, taskId: "T-" + key, oneLine: "do " + key, deps: [], estimate: "", inheritedFrom: null, status: phase === "done" ? "done" : "build",
  statusAtVersion: "build", title: "card " + key, satisfied: phase === "done", ready: false, missing: false, phase, round: null, handler: null, stepLine: null,
  since: null, pr: null, branch: null });
const feat = (id, title, counts, version) => ({ id, title, status: "active", ownerWords: "", currentVersion: version, version: null, pending: version > 9 ? { version: version + 1 } : null,
  counts: { total: 0, missing: 0, ...counts }, lastActivityAt: 1, nodes: [node(id + "-a", "active"), node(id + "-d", "done")] });
const FEATURES = [
  feat("long-unknown", "Team mirror feature with a deliberately long title that has to be truncated on phones", { done: 0, active: 0, idle: 0, activeUnknown: true }, 2),
  feat("many-unknown", "团队镜像里一个刻意很长很长的中文功能标题需要在手机上省略显示", { done: 12345, active: 0, idle: 0, activeUnknown: true }, 12),
  feat("known-zero", "Known zero", { done: 0, active: 0, idle: 0 }, 1),
  feat("known-many", "Local feature with many nodes and a long title", { done: 128, active: 4096, idle: 73215 }, 3),
  feat("short-unknown", "U", { done: 7, active: 0, idle: 0, activeUnknown: true }, 1),
];
`;

function entry(v: Variant) {
  const mob = v === "before" ? "./.bc2-before-mobile" : "./dag-mobile", can = v === "before" ? "./.bc2-before-canvas" : "./dag-canvas";
  return `import React from "react";import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import s from "../collab.module.css";
import { MobileDag } from "${mob}";
import { Shelf } from "${can}";
${fixture}
const q = new URLSearchParams(location.search);
setLang(q.get("lang") === "en" ? "en" : "zh");
document.documentElement.dataset.theme = q.get("theme") || "dark";
const tr = (x) => x, noop = () => {};
window.clicks = [];
const look = () => ({ owner: null, act: "", now: 1000, hot: false, selected: false, flash: null });
function App() {
  return <div className={s.tokens} style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    {innerWidth < 640
      ? <MobileDag features={FEATURES} open={["long-unknown"]} doneOpen={new Set()} look={look} onFeature={(id) => window.clicks.push("f:" + id)}
          onFold={noop} onVersions={(id) => window.clicks.push("v:" + id)} onNode={noop} onOwner={noop} tr={tr} />
      : <Shelf shelf={FEATURES} evicted={null} onFeature={(id) => window.clicks.push("f:" + id)} />}
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
window.ready = true;
`;
}

async function serve(v: Variant) {
  const tmp: string[] = [];
  const put = async (name: string, body: string) => { const p = join(dir, name); tmp.push(p); await Bun.write(p, body); };
  try {
    if (v === "before") {
      await put(".bc2-before-mobile.tsx", await baseline("dag-mobile.tsx"));
      await put(".bc2-before-canvas.tsx", await baseline("dag-canvas.tsx"));
      await put(".bc2-before.module.css", await baseline("dag.module.css"));
    }
    await put(`.bc2-shot-${v}.tsx`, entry(v));
    const out = mkdtempSync(join(tmpdir(), `bc2-${v}-`));
    const build = Bun.spawn([process.execPath, "build", join(dir, `.bc2-shot-${v}.tsx`), "--target", "browser", "--outdir", out, "--tsconfig-override", "web/tsconfig.json"],
      { stdout: "pipe", stderr: "pipe" });
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    const files = readdirSync(out);
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(join(out, path.slice(1)))) : new Response(null, { status: 404 });
      return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
        <style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif}button{font:inherit;border:0;background:none;padding:0;color:inherit}</style></head>
        <body><div id="root"></div><script src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
  } finally { for (const p of tmp) unlinkSync(p); }
}

beforeAll(async () => {
  if (!enabled) return;
  servers.before = await serve("before");
  servers.after = await serve("after");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);
afterAll(async () => { await browser?.close(); servers.before?.stop(true); servers.after?.stop(true); });

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;
interface Opened { page: Page; blocked: string[]; logs: string[] }

async function open(v: Variant, width: number, lang: "en" | "zh", theme: "light" | "dark"): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, colorScheme: theme });
  const blocked: string[] = [], logs: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  await ctx.routeWebSocket((u) => !LOOPBACK.test(u.toString()), (ws) => { blocked.push(ws.url()); return ws.close(); });
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("websocket", (ws) => { if (!LOOPBACK.test(ws.url())) blocked.push(ws.url()); });
  await page.goto(`${servers[v]!.url}?lang=${lang}&theme=${theme}`);
  await page.waitForFunction("window.ready && document.querySelector('button')");
  await page.evaluate("document.fonts.ready");
  return { page, blocked, logs };
}

export interface LabelBox { feature: string; text: string; textW: number; visibleW: number; inHead: number; clipped: boolean; overlap: boolean; fontPx: number }
export interface Measure {
  labels: LabelBox[]; counts: string[][]; pageOverflow: boolean;
  titles: { text: string; ellipsis: boolean; truncated: boolean; visibleW: number }[];
  targets: { label: string; w: number; h: number }[];
}

/** 对每个计数：文字 Range 的真实宽度 vs. 被所有裁切祖先截剩的宽度；同一行里计数和别的计数 / 版本按钮 / 标题有没有交叠 */
const MEASURE = `(() => {
  const clipW = (el, r) => { let L = r.left, R = r.right;
    for (let a = el; a; a = a.parentElement) { const s = getComputedStyle(a);
      if (s.overflowX !== "visible" || s.overflow !== "visible") { const b = a.getBoundingClientRect(); L = Math.max(L, b.left); R = Math.min(R, b.right); } }
    return { L, R: Math.min(R, innerWidth), w: Math.max(0, Math.min(R, innerWidth) - Math.max(L, 0)) }; };
  const rows = [...document.querySelectorAll("section > div:first-child, #root > div > div > button")];
  const labels = [], counts = [], titles = [], targets = [];
  for (const row of rows) {
    const head = row.tagName === "BUTTON" ? row : row.querySelector("button");
    const title = [...head.querySelectorAll("span")].find((e) => !e.querySelector("svg, span"));
    const nums = [...head.querySelectorAll("span")].filter((e) => e.querySelector(":scope > svg"));
    counts.push(nums.map((n) => n.textContent));
    const tr = title.getBoundingClientRect(), ts = getComputedStyle(title);
    titles.push({ text: title.textContent, ellipsis: ts.textOverflow === "ellipsis", truncated: title.scrollWidth > title.clientWidth + 0.5, visibleW: tr.width });
    const others = [title, ...nums, ...row.querySelectorAll(":scope > button + button")];
    for (const n of nums) {
      const t = [...n.childNodes].find((c) => c.nodeType === 3);
      const rg = document.createRange(); rg.selectNodeContents(t); const r = rg.getBoundingClientRect();
      const c = clipW(n, r);
      const hit = (b) => b.left < r.right - 0.5 && b.right > r.left + 0.5 && b.top < r.bottom - 0.5 && b.bottom > r.top + 0.5;
      const overlap = others.some((o) => o !== n && hit(o.getBoundingClientRect()));
      const hb = head.getBoundingClientRect();
      labels.push({ feature: title.textContent, text: t.textContent, textW: r.width, visibleW: c.w,
        inHead: Math.max(0, Math.min(r.right, hb.right) - Math.max(r.left, hb.left)),
        clipped: c.w + 0.5 < r.width || n.scrollWidth > n.clientWidth + 0.5, overlap,
        fontPx: parseFloat(getComputedStyle(n).fontSize) });
    }
    for (const b of row.tagName === "BUTTON" ? [] : row.querySelectorAll(":scope > button")) { const r = b.getBoundingClientRect(); targets.push({ label: b.textContent, w: r.width, h: r.height }); }
  }
  return { labels, counts, titles, targets, pageOverflow: document.documentElement.scrollWidth > innerWidth };
})()`;

const measure = (p: Page) => p.evaluate(MEASURE) as Promise<Measure>;
const UNKNOWN = { en: "Unknown", zh: "暂无" } as const;

async function shot(p: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await p.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

function phoneFailures(m: Measure, lang: "en" | "zh") {
  const bad: string[] = [];
  if (m.pageOverflow) bad.push("page scrolls horizontally");
  for (const l of m.labels) if (l.clipped || l.overlap) bad.push(`${l.feature.slice(0, 12)}:${l.text} textW=${l.textW.toFixed(1)} visibleW=${l.visibleW.toFixed(1)}${l.overlap ? " overlap" : ""}`);
  if (m.labels.filter((l) => l.text === UNKNOWN[lang]).length !== 6) bad.push("expected 6 unknown labels");
  return bad;
}

const PHONE = [390, 320] as const;
const THEMES = ["light", "dark"] as const;
const LANGS = ["en", "zh"] as const;

test.skipIf(!enabled)("old red: the baseline phone header clips the unknown count (real text range narrower than the word)", async () => {
  const red: string[] = [];
  for (const width of PHONE) for (const lang of LANGS) for (const theme of THEMES) {
    const o = await open("before", width, lang, theme);
    const m = await measure(o.page);
    await shot(o.page, `before-${width}-${lang}-${theme}`);
    expect(o.blocked).toEqual([]);
    red.push(...phoneFailures(m, lang).map((x) => `${width}/${lang}/${theme} ${x}`));
    await o.page.context().close();
  }
  console.log(`[bc2] before failures (${red.length}):\n  ${red.join("\n  ")}`);
  // 英文 390 的长标题行正是 PM 看到的「Unk」
  expect(red.some((x) => x.startsWith("390/en/") && x.includes(":Unknown"))).toBe(true);
}, 120_000);

test.skipIf(!enabled)("new green: 390 / 320 × en / zh × light / dark keep every Unknown / 暂无 fully readable, titles still ellipsize, targets ≥ 44px", async () => {
  for (const width of PHONE) for (const lang of LANGS) for (const theme of THEMES) {
    const o = await open("after", width, lang, theme);
    const m = await measure(o.page);
    await shot(o.page, `after-${width}-${lang}-${theme}`);
    expect(o.blocked).toEqual([]);
    expect([width, lang, theme, phoneFailures(m, lang)]).toEqual([width, lang, theme, []]);
    // 不靠缩字号：计数字号与基线同（.mft 的 --fs-2 = 12.5px），也不是缩写
    for (const l of m.labels) expect([l.text, l.fontPx]).toEqual([l.text, 12.5]);
    expect(m.labels.some((l) => /^Unk$/.test(l.text))).toBe(false);
    // 长标题仍省略、仍看得见一截
    for (const t of m.titles.filter((t) => t.text.length > 30)) expect([t.text, t.ellipsis, t.truncated, t.visibleW > 24]).toEqual([t.text, true, true, true]);
    // 计数原样：known 0 仍 0、未知仍 Unknown/暂无、done 数不变
    const u = UNKNOWN[lang];
    expect(m.counts).toEqual([["0", u, u], ["12345", u, u], ["0", "0", "0"], ["128", "4096", "73215"], ["7", u, u]]);
    for (const t of m.targets) expect([t.label, t.w >= 44, t.h >= 44]).toEqual([t.label, true, true]);
    // 展开和版本按钮还能点（真点击，不是 dispatch）
    await o.page.getByRole("button", { name: /^v12/ }).click();
    await o.page.getByRole("button", { name: /Known zero/ }).click();
    expect(await o.page.evaluate("window.clicks") as string[]).toEqual(["v:many-unknown", "f:known-zero"]);
    await o.page.context().close();
  }
}, 120_000);

test.skipIf(!enabled)("desktop 1200 Shelf: same counts, nothing clipped, before and after identical", async () => {
  for (const lang of LANGS) for (const theme of THEMES) {
    const res: Record<string, Measure> = {};
    for (const v of ["before", "after"] as const) {
      const o = await open(v, 1200, lang, theme);
      res[v] = await measure(o.page);
      await shot(o.page, `${v}-1200-${lang}-${theme}`);
      expect(o.blocked).toEqual([]);
      await o.page.context().close();
    }
    const u = UNKNOWN[lang];
    expect(res.after!.counts).toEqual([["0", u, u], ["12345", u, u], ["0", "0", "0"], ["128", "4096", "73215"], ["7", u, u]]);
    // Shelf 本身横向滚动（超出视口的小片属正常），这里只看每个计数在自己小片里有没有被截 / 交叠
    expect(res.after!.labels.filter((l) => l.overlap || l.inHead + 0.5 < l.textW)).toEqual([]);
    expect(res.after!.labels.map((l) => [l.text, l.textW, l.fontPx])).toEqual(res.before!.labels.map((l) => [l.text, l.textW, l.fontPx]));
    expect(res.after!.titles).toEqual(res.before!.titles);
  }
}, 120_000);

test.skipIf(!enabled)("the loopback guard really blocks: a non-loopback fetch and WebSocket are recorded and fail", async () => {
  const o = await open("after", 390, "en", "dark");
  const r = await o.page.evaluate(`(async () => {
    const http = await fetch("https://example.com/x").then(() => "ok", () => "blocked");
    const ws = await new Promise((res) => {
      const w = new WebSocket("wss://example.com/ws");
      w.onopen = () => res("open"); w.onclose = w.onerror = () => res("blocked"); setTimeout(() => res("timeout"), 3000);
    });
    return { http, ws };
  })()`) as { http: string; ws: string };
  expect(r.http).toBe("blocked");
  expect(r.ws).not.toBe("open");
  expect(o.blocked.some((u) => u.startsWith("https://example.com/x"))).toBe(true);
  expect(o.blocked.some((u) => u.startsWith("wss://example.com/ws"))).toBe(true);
  await o.page.context().close();
}, 60_000);
