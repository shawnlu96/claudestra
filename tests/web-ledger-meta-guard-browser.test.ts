/** Opt-in real Chromium regression + screenshot: LEDGER_BROWSER=1 bun test tests/web-ledger-meta-guard-browser.test.ts.
 * React runs in the browser bundle, not the root test process. No live bridge or credentials are used.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";

const enabled = process.env.LEDGER_BROWSER === "1";
const out = resolve(".playwright-mcp/i28-V1z");
const project = "claude-orchestrator";
const overview = () => ({
  ok: true, exists: true, now: Date.now(),
  meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], deps: [],
  tasks: [{ id: "i28-V1z", itemId: null, title: "协作视图正文超时恢复验证", kind: "code", stage: "build", stageBefore: null,
    round: 0, agent: "agent-worker", pm: null, pr: null, spec: null, model: null, extra: {}, createdAt: Date.now(), updatedAt: Date.now(),
    lastEvent: null, stageSince: Date.now(), metrics: { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 } }],
});

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatStoreProvider } from "./features/chat/chat-store";
import { CollabView } from "./features/collab/collab-view";
import { CollabEntry } from "./features/collab/collab-entry";
import { openCollab, closeCollab, useCollabNav } from "./features/collab/collab-nav";
import { cacheOverview, cachedOverview, clearOverview, setLedgerAccess } from "./features/collab/collab-cache";
import { CollabPaneBoundary } from "./components/boundaries";
window.fixture = { cacheOverview, cachedOverview, clearOverview, setLedgerAccess, openCollab, closeCollab };
function App() {
  const { project } = useCollabNav();
  return <ChatStoreProvider><aside><h2>claude-orchestrator</h2><ul><CollabEntry projectId="claude-orchestrator" /></ul></aside>
    <main>{project ? <CollabPaneBoundary onClose={closeCollab}><CollabView project={project} /></CollabPaneBoundary>
      : <p>选择协作视图</p>}</main></ChatStoreProvider>;
}
createRoot(document.getElementById("root")).render(<App />);
`;

let browser: Browser;
let assets: Map<string, Blob>;
beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/ledger-regression/fixture.tsx");
  await Bun.write(entry, fixture.replaceAll('from "./', 'from "../../'));
  const bundle = resolve(out, "bundle");
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", bundle], { stdout: "pipe", stderr: "pipe" });
  const [code, log] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  unlinkSync(entry);
  if (code) throw new Error(log);
  assets = new Map(readdirSync(bundle).map((name) => ["/" + name, Bun.file(resolve(bundle, name))]));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
});
afterAll(async () => { await browser?.close(); }, 20_000);

async function backend(mode: "stall" | "normal" | "retry") {
  const requests: { at: number; closedAt?: number }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/") {
      const css = [...assets.keys()].filter((p) => p.endsWith(".css")).map((p) => `<link rel="stylesheet" href="${p}">`).join("");
      const js = [...assets.keys()].find((p) => p.endsWith(".js"));
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${css}<style>
        body{margin:0;background:#f8f9fb;color:#172133;font:14px system-ui} #root{display:flex;height:100vh}
        aside{width:220px;padding:20px;background:#eef1f6} main{position:relative;flex:1;display:flex;min-width:0}
        button{cursor:pointer} ul{list-style:none;padding:0} h2{font-size:16px} main>p{padding:28px}
        </style></head><body><div id="root"></div><script type="module" src="${js}"></script></body></html>`);
    }
    const asset = assets.get(path);
    if (asset) { res.writeHead(200, { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" }); return res.end(Buffer.from(await asset.arrayBuffer())); }
    if (path === "/app-config.json") return json({ mode: "direct", fp: "fixture", machineName: "fixture", version: "" });
    if (path === `/api/v1/ledger/${project}`) {
      const record = { at: Date.now(), closedAt: undefined as number | undefined };
      requests.push(record);
      res.on("close", () => { record.closedAt = Date.now(); });
      if (mode === "stall" && requests.length === 1) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders();
        res.write('{"padding":"' + "x".repeat(65536));
        timers.add(setTimeout(() => res.end('","done":true}'), 15_000));
        return;
      }
      if (mode === "retry" && requests.length <= 2) return json({ error: "temporary" }, 503);
      if (mode === "retry") { timers.add(setTimeout(() => json(overview()), 500)); return; }
      return json(overview());
    }
    if (path.startsWith("/api/v1/me/last-seen/")) return json({ lastSeen: null, now: Date.now(), events: [] });
    return json({ error: "fixture endpoint unavailable" }, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); server.close();
  } };
}

test.skipIf(!enabled)("first 200 body stalls 15s: no poisoned cache, entry recovers and real view opens", async () => {
  const api = await backend("stall");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  const failures: { at: number; message: string }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("Response body interrupted")) failures.push({ at: Date.now(), message: message.text() });
  });
  try {
    await page.goto(api.url);
    await page.waitForFunction("window.fixture && !window.fixture.cachedOverview('claude-orchestrator')");
    await page.waitForTimeout(11_000);
    expect(api.requests).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].at - api.requests[0].at).toBeGreaterThan(9000);
    expect(failures[0].at - api.requests[0].at).toBeLessThan(13_000);
    expect(await page.evaluate("window.fixture.cachedOverview('claude-orchestrator')")).toBeUndefined();
    await page.getByRole("button", { name: "协作视图", exact: true }).click({ timeout: 15_000 });
    await page.getByText("协作视图正文超时恢复验证", { exact: true }).first().waitFor();
    expect(await page.getByText("这部分出错了", { exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: resolve(out, "body-timeout-recovered.png"), fullPage: true });
    const evidence = { requests: api.requests, failures, pageErrors: errors, stalledBytes: 65536, stallMs: 15000 };
    await Bun.write(resolve(out, "body-timeout-evidence.json"), JSON.stringify(evidence, null, 2));
  } finally { await page.close(); api.close(); }
}, 45_000);

test.skipIf(!enabled)("invalid cache writes reject; an existing {} is evicted before render and reloaded", async () => {
  const api = await backend("normal");
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(api.url);
    await page.getByRole("button", { name: "协作视图", exact: true }).waitFor();
    const checks = await page.evaluate(`(() => {
      const f = window.fixture, results = [];
      for (const value of [{}, {error:'proxy'}, {tasks:[],items:[],deps:[]}]) {
        try { f.cacheOverview('invalid', value, 0); results.push(false); } catch { results.push(!f.cachedOverview('invalid')); }
      }
      const ov = f.cachedOverview('claude-orchestrator').ov;
      for (const key of Object.keys(ov)) delete ov[key];
      return results;
    })()`);
    expect(checks).toEqual([true, true, true]);
    const before = api.requests.length;
    await page.getByRole("button", { name: "协作视图", exact: true }).click();
    await page.getByText("协作视图正文超时恢复验证", { exact: true }).first().waitFor();
    expect(api.requests.length).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  } finally { await page.close(); api.close(); }
}, 15_000);

test.skipIf(!enabled)("manual retry clears only this project's cache before fetching", async () => {
  const api = await backend("retry");
  const page = await browser.newPage();
  try {
    await page.goto(api.url);
    await page.waitForFunction("window.fixture");
    await page.waitForTimeout(100);
    await page.evaluate(`window.fixture.openCollab('${project}')`);
    await page.getByText("读台账失败", { exact: true }).waitFor();
    await page.evaluate(`(() => {
      const ov = ${JSON.stringify(overview())};
      window.fixture.cacheOverview('${project}', ov, 0);
      window.fixture.cacheOverview('other-project', ov, 0);
    })()`);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    const thisCached = await page.evaluate(`!!window.fixture.cachedOverview('${project}')`);
    const otherCached = await page.evaluate("!!window.fixture.cachedOverview('other-project')");
    expect(thisCached).toBe(false);
    expect(otherCached).toBe(true);
    await page.getByText("协作视图正文超时恢复验证", { exact: true }).first().waitFor();
  } finally { await page.close(); api.close(); }
}, 15_000);
