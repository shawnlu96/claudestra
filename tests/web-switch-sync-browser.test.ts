/**
 * SYN-1 验收 6：真 Chrome（无头）经 30KB/s 慢链路切换 agent 5 次，记录每次「正在同步」横幅亮了多久，改前 / 改后各一组（opt-in）：
 *   SYN1_BROWSER=1 [SYN1_OUT=<目录>] bun test tests/web-switch-sync-browser.test.ts
 * before = SYN1_BASELINE（默认开卡时的 main）的 web/（git archive 导出，共用本仓 web/node_modules）；after = 当前工作区。
 * 同输入：同一入口（真 ChatStoreProvider + 真 SyncBanner）+ 同一份合成 bridge（回环，两个 agent 各 500 条、每条约 270 字节，
 * 和 10-13 现场 135KB / 500 条同量级）+ 同一限速（CDP：下行 / 上行 30KB/s，RTT 100ms）。每次切回前给目标 agent 追加一条新消息。
 * 量的是：横幅亮灯时长（DOM 里出现「正在同步最新消息…」到消失）、新消息上屏耗时、这次切换下载的字节数。合成夹具，非生产页面。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.SYN1_BROWSER === "1";
const OUT = process.env.SYN1_OUT;
const BASELINE = process.env.SYN1_BASELINE ?? "a2c2066cb";
const web = resolve("web");
type Variant = "before" | "after";
const cleanup: string[] = [];
let browser: Browser;

/** 合成 bridge 的会话内容（前后两版各自一份新的，内容相同） */
interface Rec { seq: number; role: "user" | "assistant"; text: string; ts: string }
const PAD = "这是一段用来撑出真实体量的历史文本，".repeat(8);
function makeSessions(): Record<string, Rec[]> {
  const mk = (agent: string) => Array.from({ length: 500 }, (_, i) => rec(i + 1, `${agent}#${i + 1} ${PAD}`));
  return { a: mk("a"), b: mk("b") };
}
function rec(seq: number, text: string): Rec {
  return { seq, role: seq % 2 ? "user" : "assistant", text, ts: new Date(Date.UTC(2026, 9, 14, 0, 0, seq)).toISOString() };
}

const ENTRY = `import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLang } from "@/lib/i18n";
import { ChatStoreProvider, useChatStoreApi } from "../chat-store";
import { SyncBanner } from "./sync-banner";
setLang("zh");
function Wire() {
  const store = useChatStoreApi();
  useEffect(() => { window.__store = store; window.ready = true; }, [store]);
  return null;
}
createRoot(document.getElementById("root")).render(
  <ChatStoreProvider><Wire /><div className="relative h-40">合成夹具 · 非生产页面 · SYN-1 __VARIANT__<SyncBanner /></div></ChatStoreProvider>);
`;

const BUILD = `
const map = { "build-info": "export const CLIENT_COMMIT = ''; export const CLIENT_WEB_COMMIT = ''; export const CLIENT_VERSION = '';" };
const stubs = { name: "syn1-stubs", setup(b) {
  b.onResolve({ filter: /(^|\\/)build-info$/ }, (a) => ({ path: a.path.split("/").pop(), namespace: "syn1-stub" }));
  b.onLoad({ filter: /.*/, namespace: "syn1-stub" }, (a) => ({ contents: map[a.path], loader: "js" }));
} };
const [entry, outdir] = process.argv.slice(-2);
const r = await Bun.build({ entrypoints: [entry], target: "browser", outdir, plugins: [stubs], define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1); }
`;

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

async function beforeRoot(commit: string) {
  const dir = mkdtempSync(join(tmpdir(), "syn1-before-"));
  cleanup.push(dir);
  const tar = Bun.spawn(["sh", "-c", `git archive ${commit} web | tar -x -C ${dir}`], { stderr: "pipe" });
  if (await tar.exited) throw new Error(await new Response(tar.stderr).text());
  symlinkSync(join(web, "node_modules"), join(dir, "web/node_modules"));
  return join(dir, "web");
}

async function css(root: string) {
  const req = createRequire(join(web, "package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = join(root, "app/globals.css");
  return (await postcss([tw({ base: root })]).process(readFileSync(from, "utf8"), { from })).css;
}

/** 构建入口 + 起一个回环服务：页面、脚本和合成 bridge 都在这里；bytes 记每个请求回的正文字节 */
async function serve(v: Variant, root: string) {
  const entry = join(root, "features/chat/components", `.syn1-bench-${v}.tsx`);
  await Bun.write(entry, ENTRY.replace("__VARIANT__", v));
  const out = mkdtempSync(join(tmpdir(), `syn1-${v}-out-`));
  cleanup.push(out);
  try {
    const build = Bun.spawn([process.execPath, "-e", BUILD, entry, out], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
  } finally { unlinkSync(entry); }
  const js = readdirSync(out).find((f) => f.endsWith(".js"))!;
  const style = await css(root);
  const sessions = makeSessions();
  const state = { bytes: 0, requests: [] as string[] };
  const enc = new TextEncoder();
  const json = (b: unknown, status = 200) => {
    const body = JSON.stringify(b);
    state.bytes += enc.encode(body).length;
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === `/${js}`) return new Response(Bun.file(join(out, js)));
    if (p === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (p === "/") return new Response(`<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body><div id="root"></div>
      <script>window.process = { env: { NODE_ENV: "production" } };</script><script type="module" src="/${js}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    state.requests.push(p + url.search);
    if (p === "/api/v1/events") {
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(": connected\n\n")); timer = setInterval(() => c.enqueue(enc.encode(": ping\n\n")), 5_000); },
        cancel() { clearInterval(timer); },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    const list = /^\/api\/v1\/agents\/([ab])\/history$/.exec(p);
    if (list) return json({ sessions: [{ sessionId: `s-${list[1]}` }] });
    const page = /^\/api\/v1\/agents\/([ab])\/history\/s-[ab]$/.exec(p);
    if (page) {
      const all = sessions[page[1]];
      const limit = Number(url.searchParams.get("limit") ?? 300);
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      const rows = after !== null ? all.filter((m) => m.seq > Number(after)).slice(0, limit)
        : before !== null ? all.filter((m) => m.seq < Number(before)).slice(-limit) : all.slice(-limit);
      return json({ messages: rows });
    }
    if (/\/(hidden)$/.test(p)) return json({ ranges: [] });
    if (/\/pending$/.test(p)) return json({ question: null, thinking: false });
    if (/\/bg-tasks$/.test(p)) return json({ tasks: [] });
    return json({ ok: false, error: "not in fixture" }, 404);
  } });
  return { server, sessions, state };
}

/** 页面里记横幅亮灭：MutationObserver 打时间戳，测试读出来算时长 */
const WATCH = `(() => {
  window.__marks = [];
  let on = false;
  const check = () => {
    const now = document.body.innerText.includes("正在同步最新消息…");
    if (now !== on) { on = now; window.__marks.push({ on, t: performance.now() }); }
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;

interface Row { i: number; agent: string; bannerMs: number; newMsgMs: number; bytes: number; fullPage: boolean }

async function runVariant(v: Variant, root: string): Promise<Row[]> {
  const { server, sessions, state } = await serve(v, root);
  const ctx = await browser.newContext();
  await ctx.route((u) => !u.toString().startsWith(server.url.origin), (r) => r.abort());
  const page: Page = await ctx.newPage();
  const cdp: CDPSession = await ctx.newCDPSession(page);
  await page.goto(server.url.href);
  await page.waitForFunction("window.ready", undefined, { timeout: 30_000 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 100, downloadThroughput: 30 * 1024, uploadThroughput: 30 * 1024 });
  await page.evaluate(WATCH);
  const open = (a: string) => page.evaluate(`window.__store.openAgent(${JSON.stringify(a)})`);
  const shown = (needle: string) => `window.__store.state.messages.some((m) => (m.content || "").includes(${JSON.stringify(needle)}))`;
  // 冷启动先各开一次（不计入）：两边都有了快照，之后的切换都是「切回看过的」
  await open("a");
  await page.waitForFunction(shown("a#500"), undefined, { timeout: 120_000 });
  await open("b");
  await page.waitForFunction(shown("b#500"), undefined, { timeout: 120_000 });
  const rows: Row[] = [];
  const order = ["a", "b", "a", "b", "a"];
  for (let i = 0; i < order.length; i++) {
    const agent = order[i];
    const recs = sessions[agent];
    const needle = `${agent}-new-${i}`;
    recs.push(rec(recs.length + 1, `${needle} 离开期间的新消息`));
    await page.evaluate("window.__marks.length = 0");
    state.bytes = 0;
    state.requests.length = 0;
    const t0 = (await page.evaluate("performance.now()")) as number;
    await page.evaluate(`void window.__store.openAgent(${JSON.stringify(agent)})`);
    await page.waitForFunction(shown(needle), undefined, { timeout: 120_000 });
    const t1 = (await page.evaluate("performance.now()")) as number;
    // 横幅保底亮 1.2s（use-min-visible），等它真灭再读
    await page.waitForFunction(`!document.body.innerText.includes("正在同步最新消息…")`, undefined, { timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 300));
    const marks = (await page.evaluate("window.__marks")) as { on: boolean; t: number }[];
    const onAt = marks.find((m) => m.on)?.t;
    const offAt = [...marks].reverse().find((m) => !m.on)?.t;
    rows.push({
      i: i + 1, agent,
      bannerMs: onAt !== undefined && offAt !== undefined ? Math.round(offAt - onAt) : 0,
      newMsgMs: Math.round(t1 - t0),
      bytes: state.bytes,
      fullPage: state.requests.some((r) => /\/history\/s-[ab]\?limit=\d+$/.test(r)),
    });
  }
  await ctx.close();
  server.stop(true);
  return rows;
}

beforeAll(async () => {
  if (!enabled) return;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
}, 60_000);

test.skipIf(!enabled)("30KB/s 下切换 5 次：改后不再整页重拉，横幅和新消息上屏都更短", async () => {
  const before = await runVariant("before", await beforeRoot(await git("rev-parse", "--verify", `${BASELINE}^{commit}`)));
  const after = await runVariant("after", web);
  const report = { card: "SYN-1", fixture: "synthetic bridge on loopback, not a production page", throttle: "CDP 30KB/s down+up, 100ms latency",
    baseline: BASELINE, head: await git("rev-parse", "HEAD"), before, after };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "syn1-switch-bench.json"), JSON.stringify(report, null, 2));
  }
  expect(before.every((r) => r.fullPage)).toBe(true); // 改前：每次切回都整页重拉
  expect(after.some((r) => r.fullPage)).toBe(false); // 改后：只发差量
  const sum = (rows: Row[], k: "bannerMs" | "newMsgMs" | "bytes") => rows.reduce((n, r) => n + r[k], 0);
  expect(sum(after, "newMsgMs")).toBeLessThan(sum(before, "newMsgMs"));
  expect(sum(after, "bytes")).toBeLessThan(sum(before, "bytes"));
}, 900_000);
