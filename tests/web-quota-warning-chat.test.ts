/** QWARN1_REAL_CHAT=1: final Next static /chat export, synthetic GETs and fresh storage only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const enabled = process.env.QWARN1_REAL_CHAT === "1";
const out = resolve(process.env.QWARN1_CHAT_OUT ?? `.playwright-mcp/qwarn1-chat/run-${Date.now()}`);
const staticRoot = resolve("web/out");
const RESET = Date.parse("2026-10-09T01:41:00Z");
let server: ReturnType<typeof Bun.serve>, browser: Browser, origin: string;
const staticRequests: string[] = [];

/** 心跳保持真 Chat 的只读 SSE 活着；立即结束的假流会触发重连/历史重拉，污染滚动取证。 */
function syntheticEvents(req: Request): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  const end = () => { ended = true; clearInterval(timer); };
  const bytes = new TextEncoder().encode(": isolated heartbeat\n\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = () => { if (!ended) controller.enqueue(bytes); };
      beat(); timer = setInterval(beat, 1000);
      req.signal.addEventListener("abort", end, { once: true });
    },
    cancel: end,
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

beforeAll(async () => {
  if (!enabled) return;
  if (!await Bun.file(join(staticRoot, "chat.html")).exists()) throw new Error("Build final-head web static export before capture");
  mkdirSync(out, { recursive: true });
  console.log("[real Chat artifacts]", out);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    staticRequests.push(`${req.method} ${path}`);
    if (req.method !== "GET" || path.includes("..")) return new Response("isolated", { status: 405 });
    if (path === "/api/v1/events") return syntheticEvents(req);
    if (path.startsWith("/api/")) return new Response("isolated", { status: 405 });
    for (const name of [path, `${path}.html`, `${path}/index.html`]) {
      const file = Bun.file(join(staticRoot, name));
      if (await file.exists()) return new Response(file);
    }
    return new Response("", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);
afterAll(async () => {
  await browser?.close(); server?.stop(true);
  if (enabled) expect(staticRequests.every((r) => r.startsWith("GET ")
    && (!r.startsWith("GET /api/") || r === "GET /api/v1/events"))).toBe(true);
});

const line = (family: string, state: string, warnPct: number) => ({ family, warnPct, stopPct: 80,
  weekUsedPct: state === "unknown" ? null : state === "stop" ? 82 : 74, resetAt: state === "unknown" ? null : RESET,
  observedAt: Date.now(), source: "live", freshness: "fresh", state, mode: "on", limit: state === "stop" ? "zero" : "half",
  wouldLimit: state === "stop" ? "zero" : "half", granted: 2, lineCap: 1, available: 1, slots: 1 });
const messages = Array.from({ length: 24 }, (_, i) => ({ seq: i + 1, ts: new Date(Date.now() - (24 - i) * 60000).toISOString(),
  role: i % 2 ? "assistant" : "user", text: `Synthetic message ${i + 1}: real Chat layout evidence.\nSecond line for bubble sizing.`,
  ...(i % 2 ? { replyText: `Synthetic reply ${i + 1}: real Chat layout evidence.\nSecond line for bubble sizing.` } : {}), fromId: "api:owner:self" }));
interface Device {
  ctx: BrowserContext; page: Page; wall: boolean; crash: boolean; codex: string; claude: string; warnPct: number;
  requests: string[]; forbidden: string[]; errors: string[];
}
const task = () => ({ id: "quota-task", title: "QWARN task", kind: "code", stage: "build", round: 0,
  agent: "agent-qwarn-evidence", pm: "agent-qwarn-helper", updatedAt: Date.now(), metrics: {} });

async function device(width: number, wall = false, list = false): Promise<Device> {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, locale: "zh-CN",
    timezoneId: "Asia/Shanghai", hasTouch: width === 390, serviceWorkers: "block" });
  await ctx.addInitScript(`(() => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("cstra_invite_handler", "confirmed"); localStorage.setItem("cstra_lang", "zh");
    ${list ? "" : 'localStorage.setItem("cstra_last_agent", "qwarn-evidence");'}
    const raw = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET") return Promise.resolve(new Response("{}", { status: 405 }));
      return raw(input, init);
    };
    navigator.sendBeacon = () => false;
    window.WebSocket = class { constructor() { throw new Error("Isolated capture refuses WebSockets"); } };
  })()`);
  const d: Device = { ctx, page: await ctx.newPage(), wall, crash: false, codex: "stop", claude: "warn", warnPct: 70, requests: [], forbidden: [], errors: [] };
  d.page.setDefaultTimeout(10_000);
  d.page.on("pageerror", (error) => d.errors.push(error.message));
  await ctx.route("**/*", async (route) => {
    const r = route.request(), u = new URL(r.url());
    d.requests.push(`${r.method()} ${u.pathname}${u.search}`);
    if (r.method() !== "GET" || u.origin !== origin) { d.forbidden.push(r.url()); return route.abort(); }
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (u.pathname === "/app-config.json") return json({ mode: "direct", fp: "synthetic-qwarn", machineName: "Isolated evidence" });
    if (!u.pathname.startsWith("/api/v1/")) return route.continue();
    const path = u.pathname.slice("/api/v1".length);
    if (path === "/whoami") return json({ ok: true, role: "owner", principalId: "owner:self", tokenId: "owner:self",
      ownerIds: [], agents: ["*"], grant: { agents: ["*"], manage: true, terminal: false }, manage: true });
    if (path === "/agents") return json({ ok: true, agents: ["qwarn-evidence", "qwarn-helper"].map(name => ({
      name: `agent-${name}`, status: "active", purpose: "Synthetic evidence", cwd: "", projectId: "synthetic",
      busy: false, runtime: "claude-code", lastActivityTs: Date.now(),
      ...(d.crash && name === "qwarn-evidence" ? { effort: { invalid: "synthetic render fault" } } : {}) })) });
    if (path === "/projects") return json({ ok: true, projects: [{ id: "synthetic", name: "Isolated evidence", dirs: [] }] });
    if (path === "/ledger/synthetic") return json({ ok: true, exists: true, now: Date.now(),
      meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, tasks: [task()], items: [], deps: [] });
    if (path === "/ledger/synthetic/tasks/quota-task") return json({ task: task(), events: [], timeline: [], now: Date.now() });
    if (path === "/lend/quota-lines") return json({ ok: true, config: { status: "ok", error: null, mode: "on" }, at: Date.now(),
      families: [line("codex", d.codex, d.warnPct), line("claude", d.claude, d.warnPct)] });
    if (path === "/quota/wall") return json(d.wall ? { active: true, queued: 3, wall: { kind: "weekly", resetsAt: RESET, enteredAt: 1 } } : { active: false });
    if (path.endsWith("/history")) return json({ sessions: [{ sessionId: "synthetic-session" }] });
    if (path.endsWith("/history/synthetic-session")) return json({ messages: u.searchParams.has("after") || u.searchParams.has("before") ? [] : messages });
    if (path.endsWith("/hidden")) return json({ ranges: [] });
    if (path.endsWith("/pending")) return json({ question: null, thinking: false });
    if (path.endsWith("/bg-tasks")) return json({ tasks: [] });
    if (path === "/events") return route.continue();
    return json({ error: "isolated_unconfigured" }, 404);
  });
  await d.page.goto(`${origin}/chat${list ? "" : "?agent=qwarn-evidence#chat"}`);
  if (!list) await d.page.locator("[data-mid]").first().waitFor();
  await d.page.locator('[data-quota-warning="codex"]').waitFor({ state: "attached" });
  await d.page.waitForTimeout(800);
  return d;
}

const scroller = (p: Page) => p.locator("div.touch-pan-y.overflow-y-auto").filter({ has: p.locator("[data-mid]") }).first();
const poll = async (p: Page) => { await p.evaluate('document.dispatchEvent(new Event("visibilitychange"))'); await p.waitForTimeout(800); };

/** Malformed effort data makes TopBar's actual ClaudeSwitcher render throw; no React internals or production test switch. */
async function chatFallback(d: Device) {
  d.crash = true;
  await d.page.waitForTimeout(5200); // Chat throttles foreground roster refreshes for five seconds.
  await d.page.evaluate('window.dispatchEvent(new Event("focus"))');
  await d.page.getByRole("alert").filter({ hasText: "这部分出错了" }).waitFor();
  expect(await d.page.locator("main [role=alert]").innerText()).toMatch(/Minified React error #31|Objects are not valid/);
}

async function captureSurface(d: Device, label: string) {
  const p = d.page;
  const measurement = await p.evaluate(`(() => {
    const warnings = [...document.querySelectorAll("[data-quota-warning]")];
    const walls = [...document.querySelectorAll('[role="status"]')].filter(e => e.textContent.includes("Claude Code 周额度已用完"));
    return [...warnings, ...walls].map(e => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent, rect: r.toJSON(), visible: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        hit: e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    });
  })()`) as { text: string; rect: { bottom: number; top: number }; visible: boolean; hit: boolean }[];
  await p.screenshot({ path: join(out, `${label}.png`) });
  await Bun.write(join(out, `${label}.json`), JSON.stringify({ measurement, requests: d.requests, errors: d.errors, forbidden: d.forbidden }, null, 2));
  expect(d.errors).toEqual([]); expect(d.forbidden).toEqual([]);
  expect(measurement).toHaveLength(3);
  expect(await p.locator('[data-quota-warning="codex"]').count()).toBe(1);
  expect(await p.locator('[data-quota-warning="claude"]').count()).toBe(1);
  expect(measurement.every(m => m.visible && m.hit)).toBe(true);
  for (let i = 1; i < measurement.length; i++) {
    const a = measurement[i - 1].rect, b = measurement[i].rect;
    expect(a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  }
}

for (const width of [390, 1280]) {
  for (const surface of ["列表页", "协作视图", "兜底页"]) {
    test.skipIf(!enabled)(`真实Chat ${width}：${surface}两族提醒和旧墙唯一且可读`, async () => {
      const d = await device(width, true, surface !== "兜底页");
      try {
        if (surface === "协作视图") {
          await d.page.getByRole("button", { name: "协作视图", exact: true }).click();
          await d.page.getByText("QWARN task", { exact: true }).first().waitFor();
        } else if (surface === "兜底页") await chatFallback(d);
        await d.page.waitForTimeout(800);
        await captureSurface(d, `${width}-${surface}`);
        // Switching surfaces must keep the same mounted readers; no remount/poll replay.
        expect(d.requests.filter(r => r.includes("/lend/quota-lines"))).toHaveLength(1);
        expect(d.requests.filter(r => r.endsWith("/quota/wall"))).toHaveLength(1);
        for (const family of ["codex", "claude"]) await d.page.locator(`[data-quota-warning="${family}"] button`).click();
        await d.page.getByRole("status").filter({ hasText: "Claude Code 周额度已用完" }).getByRole("button", { name: "关闭", exact: true }).click();
        expect((await d.page.locator("#cstra-shell > div.absolute > div.shrink-0").boundingBox())!.height).toBe(0);
        await d.page.screenshot({ path: join(out, `${width}-${surface}-dismissed.png`) });
      } finally { await d.ctx.close(); }
    }, 30_000);
  }
}

for (const sheet of ["任务", "团队", "待你处理"]) {
  test.skipIf(!enabled)(`collab-sheet-cover：390 有台账${sheet}页保留唯一通知及动态文流`, async () => {
    const d = await device(390, true, true);
    try {
      await d.page.getByRole("button", { name: "协作视图", exact: true }).click();
      await d.page.getByText("QWARN task", { exact: true }).waitFor();
      if (sheet === "任务") await d.page.getByRole("button").filter({ hasText: "QWARN task" }).click();
      else await d.page.locator("main").getByRole("button", { name: new RegExp(`^${sheet}`) }).click();
      // CSS module names are hashed; identify the body portal by its actual fixed positioning.
      await d.page.waitForFunction(`Array.from(document.body.children).some(e => e.id !== "cstra-shell"
        && getComputedStyle(e).position === "fixed" && e.querySelector('aside,button'))`);
      await d.page.waitForTimeout(500);
      await captureSurface(d, `390-sheet-${sheet}`);
      const panelTop = () => d.page.evaluate<number>(`Math.min(...Array.from(document.body.children)
        .filter(e => getComputedStyle(e).position === "fixed" && e.id !== "cstra-shell" && e.querySelector('button'))
        .map(e => e.getBoundingClientRect().top))`);
      const before = await panelTop();
      await d.page.locator('[data-quota-warning="codex"] button').click();
      await settleSheet(d.page);
      expect(await panelTop()).toBeLessThan(before);
      await d.page.setViewportSize({ width: 320, height: 844 });
      await settleSheet(d.page);
      await captureSurfaceAfterDismiss(d, `320-sheet-${sheet}`);
      await d.page.locator('[data-quota-warning="claude"] button').click();
      await d.page.getByRole("status").filter({ hasText: "Claude Code 周额度已用完" }).getByRole("button", { name: "关闭", exact: true }).click();
      await settleSheet(d.page);
      expect(await panelTop()).toBe(0);
    } finally { await d.ctx.close(); }
  }, 30_000);
}

async function settleSheet(p: Page) {
  await p.waitForFunction(`(() => {
    const row = document.querySelector("#cstra-shell > div.absolute > div.shrink-0").getBoundingClientRect();
    const top = Math.min(...Array.from(document.body.children)
      .filter(e => getComputedStyle(e).position === "fixed" && e.id !== "cstra-shell" && e.querySelector('button'))
      .map(e => e.getBoundingClientRect().top));
    return Math.abs(top - row.bottom) < 0.5;
  })()`);
}

async function captureSurfaceAfterDismiss(d: Device, label: string) {
  await d.page.screenshot({ path: join(out, `${label}.png`) });
  expect(await d.page.locator('[data-quota-warning="claude"]').count()).toBe(1);
  const bar = await d.page.locator('[data-quota-warning="claude"]').boundingBox();
  expect(bar!.x).toBeGreaterThanOrEqual(0);
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(320);
  const hit = await d.page.evaluate<boolean>(`(() => {
    const e = document.querySelector('[data-quota-warning="claude"]'), r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })()`);
  expect(hit).toBe(true);
}

test.skipIf(!enabled)("safe-area-double：47px 原生安全区只由非空通知占一次，关闭后恢复顶栏", async () => {
  const d = await device(390, true, true);
  const cdp = await d.ctx.newCDPSession(d.page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 0, left: 0, right: 0 } });
    await d.page.waitForTimeout(500);
    const padding = (selector: string) => d.page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).paddingTop`);
    expect(await padding("#cstra-shell > div.absolute > div.shrink-0")).toBe("47px");
    expect(await padding("#cstra-shell aside > div.px-4.pb-2")).toBe("12px");
    expect(await padding("main header")).toBe("0px");
    await captureSurface(d, "390-safe-47-list");
    await d.page.getByRole("button", { name: "协作视图", exact: true }).click();
    await d.page.getByText("QWARN task", { exact: true }).waitFor();
    await d.page.getByRole("button").filter({ hasText: "QWARN task" }).click();
    await d.page.waitForTimeout(500);
    await captureSurface(d, "390-safe-47-task");
    for (const family of ["codex", "claude"]) await d.page.locator(`[data-quota-warning="${family}"] button`).click();
    await d.page.getByRole("status").filter({ hasText: "Claude Code 周额度已用完" }).getByRole("button", { name: "关闭", exact: true }).click();
    await d.page.waitForTimeout(100);
    expect(await padding("#cstra-shell aside > div.px-4.pb-2")).toBe("59px");
    expect(await padding("main header")).toBe("47px");
    await d.page.screenshot({ path: join(out, "390-safe-47-dismissed.png") });
  } finally { await cdp.detach(); await d.ctx.close(); }
}, 30_000);

interface Rect { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number }
interface Measurement {
  scroll: { rect: Rect; top: number; max: number; clientHeight: number; scrollHeight: number; atBottom: boolean }; warning: { family: string; rect: Rect }[];
  wall: Rect | null; input: Rect; last: Rect; textOverlaps: { id: string; text: string; area: number }[];
  pairAreas: number[]; inputAreas: number[]; wallHit: boolean | null; hitFamilies: (string | null)[];
}

async function capture(d: Device, label: string, bottom?: boolean) {
  const p = d.page;
  if (bottom !== undefined) {
    const box = (await scroller(p).boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.wheel(0, bottom ? 10000 : -10000);
  }
  await p.waitForTimeout(800);
  const measurement = await p.evaluate<Measurement>(`(() => {
    const rect = e => e.getBoundingClientRect().toJSON();
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const scroll = [...document.querySelectorAll("div.touch-pan-y.overflow-y-auto")].find((e) => e.querySelector("[data-mid]"));
    const clip = rect(scroll);
    const warning = [...document.querySelectorAll("[data-quota-warning]")].map((e) => ({ family: e.getAttribute("data-quota-warning"), rect: rect(e) }));
    const wall = [...document.querySelectorAll('[role="status"]')].find((e) => e.textContent?.includes("Claude Code 周额度已用完"));
    const wallRect = wall ? rect(wall) : null;
    const textOverlaps = [];
    for (const message of document.querySelectorAll("[data-mid]")) {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const visible = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right),
            top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
          if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
          const area = [...warning.map((w) => w.rect), ...(wallRect ? [wallRect] : [])].reduce((n, b) => n + overlap(visible, b), 0);
          if (area) textOverlaps.push({ id: message.dataset.mid, text: node.textContent.slice(0, 100), area });
        }
      }
    }
    const input = rect(document.querySelector("textarea"));
    const last = rect([...document.querySelectorAll("[data-mid]")].at(-1));
    return { scroll: { rect: clip, top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight,
      clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight,
      atBottom: Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 2 }, warning, wall: wallRect, input, last,
      textOverlaps, pairAreas: warning.map((w) => wallRect ? overlap(w.rect, wallRect) : 0),
      inputAreas: [...warning.map((w) => w.rect), ...(wallRect ? [wallRect] : [])].map((r) => overlap(input, r)),
      wallHit: wallRect ? document.elementFromPoint(wallRect.x + wallRect.width / 2, wallRect.y + wallRect.height / 2)
        ?.closest('[role="status"]') === wall : null,
      hitFamilies: warning.map((w) => document.elementFromPoint(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2)
        ?.closest("[data-quota-warning]")?.getAttribute("data-quota-warning") ?? null) };
  })()`);
  await p.screenshot({ path: join(out, `${label}.png`) });
  await Bun.write(join(out, `${label}.html`), await p.content());
  await Bun.write(join(out, `${label}.json`), JSON.stringify({ measurement, requests: d.requests, forbidden: d.forbidden, errors: d.errors }, null, 2));
  expect(d.forbidden).toEqual([]);
  expect(d.errors).toEqual([]);
  if (bottom === false) expect(measurement.scroll.top).toBe(0);
  if (bottom === true) expect(measurement.scroll.atBottom).toBe(true);
  return measurement;
}

function unobscured(m: Awaited<ReturnType<typeof capture>>) {
  expect(m.textOverlaps).toEqual([]);
  expect(m.pairAreas.every((n) => n === 0)).toBe(true);
  expect(m.inputAreas.every((n) => n === 0)).toBe(true);
  expect(m.hitFamilies).toEqual(m.warning.map((w) => w.family));
  if (m.wall) expect(m.wallHit).toBe(true);
}

for (const width of [390, 1280]) {
  test.skipIf(!enabled)(`真实Chat ${width}：顶部和底部消息文本不被两族提醒覆盖`, async () => {
    const d = await device(width);
    try {
      const top = await capture(d, `${width}-warning-top`, false); unobscured(top);
      expect(top.warning).toHaveLength(2);
      const bottom = await capture(d, `${width}-warning-bottom`, true); unobscured(bottom);
      expect(bottom.scroll.atBottom).toBe(true); expect(bottom.last.bottom).toBeLessThanOrEqual(bottom.input.top);
    } finally { await d.ctx.close(); }
  }, 30_000);
  test.skipIf(!enabled)(`真实Chat ${width}：旧墙与新两族同时完整可读`, async () => {
    const d = await device(width, true);
    try {
      await d.page.getByRole("status").filter({ hasText: "Claude Code 周额度已用完" }).waitFor();
      const top = await capture(d, `${width}-both-top`, false); unobscured(top);
      expect(top.warning).toHaveLength(2); expect(top.wall).not.toBeNull();
      const bottom = await capture(d, `${width}-both-bottom`, true); unobscured(bottom);
      expect(bottom.scroll.atBottom).toBe(true); expect(bottom.last.bottom).toBeLessThanOrEqual(bottom.input.top);
    } finally { await d.ctx.close(); }
  }, 30_000);
  test.skipIf(!enabled)(`真实Chat ${width}：unknown/关闭归零、新线重现和宽度变化保持吸底`, async () => {
    const d = await device(width);
    try {
      const shown = await capture(d, `${width}-reflow-initial`, true);
      await d.page.locator('[data-quota-warning="codex"] button').click();
      await d.page.locator('[data-quota-warning="claude"] button').click();
      const closed = await capture(d, `${width}-dismissed`); unobscured(closed);
      expect(closed.warning).toHaveLength(0); expect(closed.scroll.atBottom).toBe(true);
      expect(closed.scroll.rect.top).toBeLessThan(shown.scroll.rect.top);
      d.claude = "stop"; await poll(d.page);
      const stop = await capture(d, `${width}-new-stop`); unobscured(stop);
      expect(stop.warning.map((w) => w.family)).toEqual(["claude"]); expect(stop.scroll.atBottom).toBe(true);
      d.claude = d.codex = "unknown"; await poll(d.page);
      const unknown = await capture(d, `${width}-unknown`); unobscured(unknown);
      expect(unknown.warning).toHaveLength(0); expect(unknown.scroll.rect.top).toBe(closed.scroll.rect.top);
      d.claude = "warn"; d.codex = "stop"; d.wall = true; d.warnPct = 60; await poll(d.page);
      await d.page.setViewportSize({ width: width === 390 ? 320 : 1000, height: width === 390 ? 844 : 800 });
      const resized = await capture(d, `${width}-resized`); unobscured(resized);
      expect(resized.warning).toHaveLength(2); expect(resized.wall).not.toBeNull();
      expect(resized.scroll.atBottom).toBe(true);
    } finally { await d.ctx.close(); }
  }, 30_000);
}

for (const width of [390, 1280]) {
  test.skipIf(!enabled)(`真实Chat ${width}：用户上滚时提示高度变化不强制吸底`, async () => {
    const d = await device(width);
    try {
      await capture(d, `${width}-user-before-bottom`, true);
      const box = (await scroller(d.page).boundingBox())!;
      await d.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await d.page.mouse.wheel(0, -600);
      const before = await capture(d, `${width}-user-scrolled`);
      expect(before.scroll.atBottom).toBe(false);
      d.wall = true; await poll(d.page);
      const after = await capture(d, `${width}-user-notice-change`); unobscured(after);
      expect(after.scroll.atBottom).toBe(false);
      expect(after.scroll.top).toBe(before.scroll.top);
    } finally { await d.ctx.close(); }
  }, 30_000);
}

test.skipIf(!enabled)("真实Chat 390：触摸held冻结，抬手后恢复原吸底", async () => {
  const d = await device(390);
  const cdp = await d.ctx.newCDPSession(d.page);
  try {
    const before = await capture(d, "390-touch-before", true);
    const box = (await scroller(d.page).boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 2, y: box.y + 80, id: 1 }] });
    d.wall = true; await poll(d.page);
    const held = await capture(d, "390-touch-held"); unobscured(held);
    expect(held.scroll.top).toBe(before.scroll.top); expect(held.scroll.atBottom).toBe(false);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const released = await capture(d, "390-touch-released"); unobscured(released);
    expect(released.scroll.atBottom).toBe(true);
  } finally { await cdp.detach(); await d.ctx.close(); }
}, 30_000);

for (const width of [390, 1280]) {
  test.skipIf(!enabled)(`真实Chat ${width}：原选择文字UI的held保留选区与滚动位置`, async () => {
    const d = await device(width);
    try {
      await capture(d, `${width}-selection-before`, true);
      await d.page.locator('[data-mid="h24"] .cstra-bubble').last().click({ button: "right" });
      await d.page.getByRole("menuitem", { name: "选择文字" }).click();
      expect(await d.page.evaluate<string | undefined>('document.body.dataset.cstraSelect')).toBe("1");
      const selected = await d.page.evaluate<string>('window.getSelection().toString()');
      expect(selected.length).toBeGreaterThan(0);
      const before = await capture(d, `${width}-selection-active`);
      d.wall = true; await poll(d.page);
      const held = await capture(d, `${width}-selection-held`); unobscured(held);
      expect(held.scroll.top).toBe(before.scroll.top);
      expect(await d.page.evaluate<string>('window.getSelection().toString()')).toBe(selected);
      await d.page.getByRole("button", { name: /完成/ }).click();
    } finally { await d.ctx.close(); }
  }, 30_000);
}
