/**
 * team-parity-DRAG1：团队视图子 DAG 按住左键拖拽不选中图里的字、从标题 / 节点文字上按下也能真平移（opt-in，真 headless Chrome）：
 *   DRAG1_BROWSER=1 bun --no-env-file test tests/web-team-parity-drag-selection-browser.test.ts
 * 可选：DRAG1_SHOTS_DIR=<仓库外私密目录> 存前后 PNG；DRAG1_BASELINE=<sha> 指定「修前」源码（默认本卡基线 61f24b83）。
 * 数据走真来源：本机 = home-fixture-gen.ts 的 homeDagBoard，团队 = 同一份本机台账经真导出 → 真中心 → 真投影器（web-team-parity-browser-center.test.ts）
 * 再由 teamDagBoard 适配；页面里用真 layoutDag + DagCanvasView / MobileDag 画。只经回环 127.0.0.1 提供页面，非回环 HTTP / WebSocket 一律拦下判失败。
 * 「修前」用 git show 取基线的 use-viewport.ts / v4.module.css / dag-canvas.tsx 写成临时文件同场构建，同一组真鼠标操作：修前必须红、修后必须绿。
 * 断言只看真结果：world 的 transform（平移 / 缩放）、window.getSelection()、回调记账，不读 CSS 字符串。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateHomeFixture, homeDagBoard } from "@/features/collab/shared/home-fixture-gen";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const enabled = process.env.DRAG1_BROWSER === "1";
const shots = process.env.DRAG1_SHOTS_DIR;
const BASELINE = process.env.DRAG1_BASELINE ?? "61f24b83c2998e0f5aa75a34f8945eb28c73e146";
const web = resolve("web/features/collab");
type Variant = "before" | "after";
type Source = "home" | "team";
const servers: Partial<Record<Variant, ReturnType<typeof Bun.serve>>> = {};
let browser: Browser;

async function baseline(file: string) {
  const p = Bun.spawn(["git", "show", `${BASELINE}:web/features/collab/${file}`], { stdout: "pipe", stderr: "pipe" });
  const src = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return src.replaceAll('"../v4/use-viewport"', '"../v4/.drag1-before-viewport"').replaceAll('"../v4/v4.module.css"', '"../v4/.drag1-before.module.css"');
}

async function boards() {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const details = new Map(team.details.map((d) => [d.feature.id, d]));
  return { home: homeDagBoard(home), team: teamDagBoard(home.project, team.list, details, teamOverview(team.list, details, home.now)) };
}

function entry(v: Variant, data: string) {
  const can = v === "before" ? "./.drag1-before-canvas" : "./dag-canvas";
  return `import React from "react";import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import s from "../collab.module.css";
import { DagCanvasView } from "${can}";
import { MobileDag } from "./dag-mobile";
import { defaultOpen, drawable, layoutDag } from "./dag-layout";
const BOARDS = ${data};
const q = new URLSearchParams(location.search);
setLang("zh");
document.documentElement.dataset.theme = q.get("theme") || "dark";
const board = BOARDS[q.get("src")];
const features = drawable(board.features), open = defaultOpen(features), canvas = layoutDag(features, open, new Set());
const tr = (x) => x, rec = (x) => window.clicks.push(x);
window.clicks = [];
window.TEXT = { titles: canvas.groups.map((g) => g.feature.title || g.feature.id), nodes: canvas.groups.flatMap((g) => g.nodes).map((n) => n.node.oneLine) };
const look = () => ({ owner: null, act: "", now: board.now, hot: false, selected: false, flash: null });
function App() {
  if (innerWidth < 640) return <div className={s.tokens} style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    <MobileDag features={features} open={features.map((f) => f.id)} doneOpen={new Set()} look={look} onFeature={(id) => rec("f:" + id)} onFold={(id) => rec("d:" + id)}
      onVersions={(id) => rec("v:" + id)} onNode={(f, k) => rec("n:" + f + ":" + k)} onOwner={(a) => rec("o:" + a)} tr={tr} />
  </div>;
  return <div className={s.tokens} style={{ height: "100vh", display: "flex", background: "var(--bg)", color: "var(--text)" }}>
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <DagCanvasView canvas={canvas} shelf={features.filter((f) => !open.includes(f.id))} evicted={null} look={look} compare={null} focus={null}
        onNode={(f, k) => rec("n:" + f + ":" + k)} onOwner={(a) => rec("o:" + a)} onFold={(id) => rec("d:" + id)} onFeature={(id) => rec("f:" + id)}
        onVersions={(id) => rec("v:" + id)} onBackground={() => rec("bg")} tr={tr} />
    </div>
    <aside style={{ width: 260, padding: 16, borderLeft: "1px solid var(--line)" }}>
      <p id="detail" style={{ margin: "0 0 12px" }}>详情正文 detail body text that stays selectable</p>
      <textarea id="form" defaultValue="表单里的文字 form text" style={{ width: "100%", height: 60 }} />
    </aside>
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
window.ready = true;
`;
}

async function serve(v: Variant, data: string) {
  const tmp: string[] = [];
  const put = async (name: string, body: string) => { const p = join(web, name); tmp.push(p); await Bun.write(p, body); };
  try {
    if (v === "before") {
      await put("v4/.drag1-before-viewport.ts", await baseline("v4/use-viewport.ts"));
      await put("v4/.drag1-before.module.css", await baseline("v4/v4.module.css"));
      await put("dag/.drag1-before-canvas.tsx", await baseline("dag/dag-canvas.tsx"));
    }
    await put(`dag/.drag1-shot-${v}.tsx`, entry(v, data));
    const out = mkdtempSync(join(tmpdir(), `drag1-${v}-`));
    const build = Bun.spawn([process.execPath, "build", join(web, `dag/.drag1-shot-${v}.tsx`), "--target", "browser", "--outdir", out, "--tsconfig-override", "web/tsconfig.json"],
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
  const data = JSON.stringify(await boards());
  servers.before = await serve("before", data);
  servers.after = await serve("after", data);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 180_000);
afterAll(async () => { await browser?.close(); servers.before?.stop(true); servers.after?.stop(true); });

const LOOPBACK = /^(https?|wss?):\/\/127\.0\.0\.1(:\d+)?\//;
interface Opened { page: Page; blocked: string[]; logs: string[] }

async function open(v: Variant, src: Source, width: number, theme: "light" | "dark", touch = false): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 800 }, deviceScaleFactor: 2, colorScheme: theme,
    ...(touch ? { hasTouch: true, isMobile: width < 640 } : {}) });
  const blocked: string[] = [], logs: string[] = [];
  await ctx.route((u) => !LOOPBACK.test(u.toString()), (r) => { blocked.push(r.request().url()); return r.abort(); });
  await ctx.routeWebSocket((u) => !LOOPBACK.test(u.toString()), (ws) => { blocked.push(ws.url()); return ws.close(); });
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("websocket", (ws) => { if (!LOOPBACK.test(ws.url())) blocked.push(ws.url()); });
  await page.goto(`${servers[v]!.url}?src=${src}&theme=${theme}`);
  await page.waitForFunction("window.ready && document.querySelector('button')");
  await page.evaluate("document.fonts.ready");
  if (width >= 640) await page.waitForFunction(`${PROBE}\n  return !!world() && canvasEl().clientWidth > 0;\n})()`);
  await page.waitForTimeout(350); // 分组框的入场动画（dag.module.css .group enter 260ms）
  return { page, blocked, logs };
}

/** 页面里的探针：world = 带 translate 的那层，canvas = 它的父（.canvas，拖拽面） */
const PROBE = `(() => {
  const world = () => [...document.querySelectorAll("#root div")].find((e) => e.style.transform.startsWith("translate("));
  const canvasEl = () => world()?.parentElement;`;
const run = <T>(p: Page, body: string) => p.evaluate(`${PROBE}\n${body}\n})()`) as Promise<T>;

interface View { x: number; y: number; k: number }
const view = (p: Page) => run<View>(p, `const m = world().style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([-\\d.]+)\\)/);
  return { x: +m[1], y: +m[2], k: +m[3] };`);
const selection = (p: Page) => p.evaluate("String(window.getSelection())") as Promise<string>;

interface Target { kind: "title" | "node"; text: string; x: number; y: number }
/** 标题 / 节点文字上的一个点：文字 Range 的真实位置（落在字形上），且整段落在画布可视区内、没被别的元素盖住 */
const targets = (p: Page) => run<Target[]>(p, `const c = canvasEl().getBoundingClientRect(), out = [];
  const inside = (r) => r.width > 0 && r.left >= c.left + 4 && r.right <= c.right - 4 && r.top >= c.top + 4 && r.bottom <= c.bottom - 60;
  const pick = (kind, els) => { for (const el of els) {
    const rg = document.createRange(); rg.selectNodeContents(el); const r = rg.getBoundingClientRect();
    const x = r.left + Math.min(24, r.width / 2), y = r.top + r.height / 2;
    if (inside(r) && el.contains(document.elementFromPoint(x, y))) { out.push({ kind, text: el.textContent, x, y }); return; } } };
  pick("title", window.TEXT.titles.map((t) => canvasEl().querySelector("span[title=" + JSON.stringify(t) + "]")).filter(Boolean));
  pick("node", window.TEXT.nodes.map((t) => [...canvasEl().querySelectorAll("button[title=" + JSON.stringify(t) + "] span")].find((s) => s.textContent === t)).filter(Boolean));
  return out;`);

/** 画布里一块空白（elementFromPoint 落在画布本身上） */
const blank = (p: Page) => run<{ x: number; y: number }>(p, `const c = canvasEl(), r = c.getBoundingClientRect();
  for (let y = r.bottom - 80; y > r.top + 20; y -= 17) for (let x = r.left + 20; x < r.right - 160; x += 23)
    if (document.elementFromPoint(x, y) === c) return { x, y };
  return null;`);

/** 标题 / 节点文字可见（不靠删字 / 隐藏回避） */
const visibleText = (p: Page) => run<string[]>(p, `const c = canvasEl();
  return [...c.querySelectorAll("span")].filter((s) => { const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    return !s.querySelector("span") && s.textContent.trim() && r.width > 0 && r.height > 0 && cs.visibility === "visible" && cs.opacity !== "0"; }).map((s) => s.textContent);`);

async function shot(p: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await p.screenshot({ path: join(shots, `${name}.png`) });
}

interface DragResult { kind: string; text: string; moved: { dx: number; dy: number }; selected: string; clicks: string[]; after: View; drifted: boolean }
const DX = 140, DY = 70;

/** 真鼠标：在目标上左键按下 → 分步移动 → 松开 → 再空移一段（看松手后还跟不跟） */
async function dragFrom(p: Page, t: { x: number; y: number }, kind: string, text: string): Promise<DragResult> {
  await p.evaluate("window.getSelection().removeAllRanges(); window.clicks.length = 0");
  const v0 = await view(p);
  await p.mouse.move(t.x, t.y);
  await p.mouse.down();
  await p.mouse.move(t.x + DX / 2, t.y + DY / 2, { steps: 6 });
  await p.mouse.move(t.x + DX, t.y + DY, { steps: 6 });
  const selected = await selection(p);
  const v1 = await view(p);
  await p.mouse.up();
  await p.mouse.move(t.x + DX + 80, t.y + DY + 40, { steps: 4 });
  const after = await view(p);
  return { kind, text, moved: { dx: v1.x - v0.x, dy: v1.y - v0.y }, selected, clicks: await p.evaluate("window.clicks.slice()") as string[], after,
    drifted: after.x !== v1.x || after.y !== v1.y };
}

const SOURCES = ["home", "team"] as const;
const THEMES = ["light", "dark"] as const;
const panned = (r: DragResult) => Math.abs(r.moved.dx - DX) <= 1 && Math.abs(r.moved.dy - DY) <= 1;

async function drags(v: Variant, src: Source, theme: "light" | "dark") {
  const res: DragResult[] = [];
  // 每种起点一张新页（上一次拖动挪过视口，旧坐标会落到别处）
  for (const kind of ["title", "node"] as const) {
    const o = await open(v, src, 1200, theme);
    if (kind === "title") await shot(o.page, `${v}-1200-${src}-${theme}`);
    const t = (await targets(o.page)).find((x) => x.kind === kind);
    expect([kind, !!t]).toEqual([kind, true]);
    res.push(await dragFrom(o.page, t!, kind, t!.text));
    await shot(o.page, `${v}-1200-${src}-${theme}-after-${kind}-drag`);
    expect(o.blocked).toEqual([]);
    await o.page.context().close();
  }
  const o = await open(v, src, 1200, theme);
  // 右键按下拖：不应平移
  const b = await blank(o.page);
  await o.page.evaluate("window.getSelection().removeAllRanges()");
  const r0 = await view(o.page);
  await o.page.mouse.move(b!.x, b!.y);
  await o.page.mouse.down({ button: "right" });
  await o.page.mouse.move(b!.x + DX, b!.y + DY, { steps: 8 });
  await o.page.mouse.up({ button: "right" });
  await o.page.keyboard.press("Escape");
  const r1 = await view(o.page);
  const right = { dx: r1.x - r0.x, dy: r1.y - r0.y };
  expect(o.blocked).toEqual([]);
  return { o, res, right };
}

const fmt = (r: DragResult) => `${r.kind}「${r.text.slice(0, 18)}」 pan=(${r.moved.dx.toFixed(0)},${r.moved.dy.toFixed(0)}) selection=${JSON.stringify(r.selected.slice(0, 40))} drift=${r.drifted}`;

test.skipIf(!enabled)("old red: on the baseline, a left drag from a group title selects its text and a drag from node text neither pans nor stays unselected; right drag pans", async () => {
  const red: string[] = [];
  for (const src of SOURCES) for (const theme of THEMES) {
    const { o, res, right } = await drags("before", src, theme);
    for (const r of res) console.log(`[drag1] before ${src}/${theme} ${fmt(r)}`);
    console.log(`[drag1] before ${src}/${theme} right-drag pan=(${right.dx},${right.dy})`);
    for (const r of res) if (!panned(r) || r.selected !== "") red.push(`${src}/${theme} ${r.kind}`);
    if (right.dx || right.dy) red.push(`${src}/${theme} right`);
    await o.page.context().close();
  }
  console.log(`[drag1] before failures (${red.length}): ${red.join(", ")}`);
  // 每个来源 × 主题：标题拖了选中字、节点文字上拖不动（或选中字）、右键也平移，三样都红
  for (const src of SOURCES) for (const theme of THEMES) for (const k of ["title", "node", "right"]) expect(red).toContain(`${src}/${theme} ${k}`);
}, 180_000);

test.skipIf(!enabled)("new green: home / team × light / dark — left drag from title / node text pans and selects nothing; release stops; right drag does not pan", async () => {
  for (const src of SOURCES) for (const theme of THEMES) {
    const { o, res, right } = await drags("after", src, theme);
    for (const r of res) console.log(`[drag1] after ${src}/${theme} ${fmt(r)}`);
    console.log(`[drag1] after ${src}/${theme} right-drag pan=(${right.dx},${right.dy})`);
    for (const r of res) {
      expect([src, theme, r.kind, panned(r), r.selected, r.drifted]).toEqual([src, theme, r.kind, true, "", false]);
      // 拖完松手不算点了节点 / 点了空白
      expect([src, theme, r.kind, r.clicks]).toEqual([src, theme, r.kind, []]);
    }
    expect([src, theme, right]).toEqual([src, theme, { dx: 0, dy: 0 }]);
    expect(o.logs.filter((l) => l.startsWith("pageerror"))).toEqual([]);
    await o.page.context().close();
  }
}, 180_000);

test.skipIf(!enabled)("still works: buttons click, wheel zooms, blank click → background, touch cancel stops; detail / form selectable; titles and node text visible", async () => {
  for (const src of SOURCES) {
    const texts: Record<string, string[]> = {};
    for (const v of ["before", "after"] as const) { const o = await open(v, src, 1200, "dark"); texts[v] = await visibleText(o.page); await o.page.context().close(); }
    expect(texts.after!.length).toBeGreaterThan(5);
    expect(texts.after).toEqual(texts.before!);

    const o = await open("after", src, 1200, "dark", true), p = o.page;
    const clicks = () => p.evaluate("window.clicks.splice(0)") as Promise<string[]>;
    const [, node] = await targets(p);
    await p.mouse.click(node!.x, node!.y);
    expect((await clicks()).filter((c) => c.startsWith("n:")).length).toBe(1);
    await p.getByRole("button", { name: "版本" }).first().click();
    expect((await clicks())[0]).toMatch(/^v:/);
    // 空白处拖一段（真平移），「适配全部」再摆回打开时的适配视图
    const v0 = await view(p), b0 = (await blank(p))!;
    await p.mouse.move(b0.x, b0.y);
    await p.mouse.down();
    await p.mouse.move(b0.x - 100, b0.y - 50, { steps: 8 });
    await p.mouse.up();
    expect(await view(p)).toEqual({ ...v0, x: v0.x - 100, y: v0.y - 50 });
    expect(await clicks()).toEqual([]);
    await p.getByRole("button", { name: "适配全部" }).click();
    await p.waitForTimeout(400);
    expect(await clicks()).toEqual([]);
    const fit = await view(p);
    expect(fit).toEqual(v0);
    // 滚轮缩放：以指针为中心放大一档
    const b = (await blank(p))!;
    await p.mouse.move(b.x, b.y);
    await p.mouse.wheel(0, -100);
    await p.waitForFunction(`${PROBE}\n  return !world().style.transform.endsWith("scale(${fit.k})");\n})()`, undefined, { timeout: 3000 }).catch(() => {});
    const z = await view(p);
    expect(z.k).toBeCloseTo(Math.min(2, fit.k * 1.1), 3);
    // 点空白：一次 onBackground，视口不动
    const b2 = (await blank(p))!;
    await p.mouse.click(b2.x, b2.y);
    expect(await clicks()).toEqual(["bg"]);
    expect(await view(p)).toEqual(z);
    // 触摸拖到一半被取消（真 CDP 触摸输入 → pointercancel）：取消后再移鼠标不跟着走，也不算点空白
    const cdp = await p.context().newCDPSession(p);
    const touch = (type: "touchStart" | "touchMove" | "touchCancel", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchCancel" ? [] : [{ x, y, id: 1 }] });
    await touch("touchStart", b2.x, b2.y);
    for (let i = 1; i <= 6; i++) { await touch("touchMove", b2.x + i * 10, b2.y + i * 5); await p.waitForTimeout(30); }
    await p.waitForTimeout(200);
    const mid = await view(p);
    expect([Math.round(mid.x - z.x), Math.round(mid.y - z.y)]).toEqual([60, 30]);
    await touch("touchCancel", 0, 0);
    await p.mouse.move(b2.x + 200, b2.y + 100, { steps: 4 });
    expect(await view(p)).toEqual(mid);
    expect(await clicks()).toEqual([]);
    await p.getByRole("button", { name: "收起" }).first().click();
    expect((await clicks())[0]).toMatch(/^f:/);
    // 画布外的详情正文、表单照常能用鼠标选
    const d = await p.evaluate(`(() => { const rg = document.createRange(); rg.selectNodeContents(document.getElementById("detail")); const rs = [...rg.getClientRects()];
      const a = rs[0], z = rs[rs.length - 1]; return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 }; })()`) as
      { x0: number; y0: number; x1: number; y1: number };
    await p.mouse.move(d.x0, d.y0);
    await p.mouse.down();
    await p.mouse.move(d.x1, d.y1, { steps: 6 });
    await p.mouse.up();
    expect(await selection(p)).toContain("详情正文");
    const f = (await p.locator("#form").boundingBox())!;
    await p.mouse.move(f.x + 6, f.y + 12);
    await p.mouse.down();
    await p.mouse.move(f.x + f.width - 6, f.y + 12, { steps: 6 });
    await p.mouse.up();
    expect(await p.evaluate("(() => { const t = document.getElementById('form'); return t.selectionEnd - t.selectionStart; })()")).toBeGreaterThan(3);
    expect(o.blocked).toEqual([]);
    await p.context().close();
  }
}, 180_000);

test.skipIf(!enabled)("phone 390: touch scroll of the DAG list and tapping buttons unchanged before / after (light / dark)", async () => {
  for (const src of SOURCES) for (const theme of THEMES) {
    const res: Record<string, unknown> = {};
    for (const v of ["before", "after"] as const) {
      const o = await open(v, src, 390, theme, true), p = o.page;
      await shot(p, `${v}-390-${src}-${theme}`);
      // 先点（列表顶上的版本按钮），再触摸滚
      await p.getByRole("button", { name: /^v\d+$/ }).first().tap();
      const tapped = await p.evaluate("window.clicks.slice()") as string[];
      const cdp = await p.context().newCDPSession(p);
      const list = await p.evaluate(`(() => { const l = [...document.querySelectorAll("#root div")].find((e) => getComputedStyle(e).overflowY === "auto"); const r = l.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height * 0.7, max: l.scrollHeight - l.clientHeight }; })()`) as { x: number; y: number; max: number };
      expect(list.max).toBeGreaterThan(40);
      await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(list.x), y: Math.round(list.y), yDistance: -200, gestureSourceType: "touch", speed: 800 });
      await p.waitForTimeout(300);
      const top = await p.evaluate(`[...document.querySelectorAll("#root div")].find((e) => getComputedStyle(e).overflowY === "auto").scrollTop`) as number;
      res[v] = { scrolled: top > 30, tapped: tapped.map((c) => c.split(":")[0]), overflow: await p.evaluate("document.documentElement.scrollWidth > innerWidth") };
      expect(o.blocked).toEqual([]);
      await p.context().close();
    }
    console.log(`[drag1] 390 ${src}/${theme} before=${JSON.stringify(res.before)} after=${JSON.stringify(res.after)}`);
    expect(res.after).toEqual({ scrolled: true, tapped: ["v"], overflow: false });
    expect(res.after).toEqual(res.before);
  }
}, 180_000);

test.skipIf(!enabled)("the loopback guard really blocks: a non-loopback fetch and WebSocket are recorded and fail", async () => {
  const o = await open("after", "team", 1200, "dark");
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

// A cancelled touch has no derived pointer click; keyboard activation must work on its first attempt.
test.skipIf(!enabled)("cancel-click: home / team — cancelled drag allows first Enter / Space activation", async () => {
  const results: unknown[] = [];
  for (const src of SOURCES) for (const key of ["Enter", "Space"]) {
    const o = await open("after", src, 1200, "dark", true), p = o.page;
    const b = (await blank(p))!, initial = await view(p);
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...b, id: 1 }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: b.x + i * 10, y: b.y + i * 5, id: 1 }] });
      await p.waitForTimeout(30);
    }
    await p.waitForTimeout(200);
    const moved = await view(p);
    expect([Math.round(moved.x - initial.x), Math.round(moved.y - initial.y)]).toEqual([60, 30]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await p.mouse.move(b.x + 200, b.y + 100, { steps: 4 });
    expect(await view(p)).toEqual(moved);
    expect(await p.evaluate("window.clicks.splice(0)") as string[]).toEqual([]);
    await p.getByRole("button", { name: "版本" }).first().focus();
    await p.keyboard.press(key);
    const first = await p.evaluate("window.clicks.splice(0)") as string[];
    console.log(`[drag1] cancel-click ${src}/${key} first=${JSON.stringify(first)}`);
    await shot(p, `cancel-click-${src}-${key}`);
    results.push([src, key, first.length, first[0]?.startsWith("v:")]);
    expect(o.blocked).toEqual([]);
    expect(o.logs.filter((l) => l.startsWith("pageerror"))).toEqual([]);
    await p.context().close();
  }
  expect(results).toEqual(SOURCES.flatMap((src) => ["Enter", "Space"].map((key) => [src, key, 1, true])));
}, 60_000);
