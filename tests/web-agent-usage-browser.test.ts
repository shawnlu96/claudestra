/** AGENT_USAGE_BROWSER=1 bun test tests/web-agent-usage-browser.test.ts; isolated fixture, no live bridge. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const enabled = process.env.AGENT_USAGE_BROWSER === "1";
const out = resolve(".playwright-mcp/i28-T4");
let browser: Browser, server: Server, url: string;
const totals = { input: 101, cacheRead: 202, cacheCreation: 303, output: 404, reasoning: 505, calls: 6, totalTokens: 1515 };
const summary = { since: 1, total: totals, rows: [{ ...totals, runtime: "codex", model: "gpt-requested", modelBasis: "request" }] };
function response(start = 0) {
  return { state: "ready", today: summary, week: { ...summary, total: { ...totals, totalTokens: 9999 } }, next: start === 0 ? "100.20" : null,
    turns: Array.from({ length: 20 }, (_, i) => ({ id: String(start + i), startedAt: 1790841600000 - i * 1000, runtime: "codex", kind: "channel",
      trigger: "已脱敏的来源摘要 " + "长".repeat(65), calls: 6, contextSeen: 80000, totalTokens: 90000, output: 1234, reasoning: 567,
      tools: [{ name: "tool_with_a_very_long_name_".repeat(4), count: 33 }],
      attr: i === 1 ? { task: null, step: null, round: null, basis: "coordination" } : { task: "i28-T4", step: "write", round: 0, basis: "session" },
    })) };
}
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentUsageSection } from "../../features/chat/components/agent-usage-section";
import { CenteredModal } from "../../features/chat/components/centered-modal";
import { useCollabNav } from "../../features/collab/collab-nav";
function App() {
  const [name, setName] = useState("agent-a"); const [closed, close] = useState(false); const nav = useCollabNav();
  window.switchUsageAgent = setName;
  return <><output id="nav">{nav.project}:{nav.task}</output>{!closed && <CenteredModal onClose={() => close(true)}>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3"><AgentUsageSection name={name} projects={["current", "historic"]}
      onClose={() => close(true)} /></div></CenteredModal>}</>;
}
createRoot(document.getElementById("root")).render(<App />);
`;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/usage-fixture/fixture.tsx");
  await Bun.write(entry, fixture);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]); unlinkSync(entry);
  if (code) throw new Error(error);
  const assets = new Map(readdirSync(out).filter((name) => /\.(js|css)$/.test(name)).map((name) => ["/" + name, Bun.file(resolve(out, name))]));
  const cssDir = resolve("web/.next/static/css");
  // Use the production Tailwind output when available; structural modal styles keep the standalone fixture runnable too.
  let productionCss = "";
  try { for (const name of readdirSync(cssDir)) if (name.endsWith(".css")) productionCss += await Bun.file(resolve(cssDir, name)).text(); }
  catch { /* A source-only checkout may lack a Next build; the fixture below supplies the modal's layout utilities. */ }
  server = createServer(async (req, res) => {
    if (req.url === "/") {
      const links = [...assets.keys()].filter((x) => x.endsWith(".css")).map((x) => `<link rel="stylesheet" href="${x}">`).join("");
      res.setHeader("Content-Type", "text/html");
      return res.end(`<!doctype html><html><head>${links}<style>${productionCss}
        *{box-sizing:border-box}body{margin:0;font:14px system-ui}.fixed{position:fixed}.inset-0{inset:0}.grid{display:grid}
        .place-items-center{place-items:center}.flex{display:flex}.flex-col{flex-direction:column}.min-w-0{min-width:0}
        .w-full{width:100%}.max-w-md{max-width:448px}.p-4{padding:16px}.px-5{padding-inline:20px}.py-3{padding-block:12px}
        .min-h-0{min-height:0}.flex-1{flex:1}.overflow-y-auto{overflow-y:auto}[class*="max-h-"]{max-height:88dvh}
        [class*="grid-cols-"]{grid-template-columns:minmax(0,1fr)}button{cursor:pointer}ol{padding:0;list-style:none}
        </style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
    }
    const asset = assets.get(req.url!);
    if (asset) { res.setHeader("Content-Type", req.url!.endsWith(".css") ? "text/css" : "text/javascript"); return res.end(Buffer.from(await asset.arrayBuffer())); }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/app-config.json") return res.end(JSON.stringify({ mode: "direct", fp: "test", machineName: "test" }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); });

async function pageWith(mode = "ready") {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/api/v1/usage/agent/**", async (route) => {
    const data = mode === "ready" ? response(new URL(route.request().url()).searchParams.has("before") ? 20 : 0)
      : { state: mode, today: null, week: null, turns: [], next: null };
    await route.fulfill({ status: mode === "forbidden" ? 403 : 200, json: data });
  });
  await page.goto(url);
  return page;
}
async function noOverflow(page: Page) {
  const size = await page.evaluate("({ page: document.documentElement.scrollWidth, viewport: innerWidth })") as { page: number; viewport: number };
  expect(size.page).toBe(size.viewport);
  const fits = await page.evaluate("(() => { const el = document.querySelector('section'); return el.scrollWidth <= el.clientWidth; })()") as boolean;
  expect(fits).toBe(true);
}

test.skipIf(!enabled)("mobile/desktop, period numbers, paginated loading and historical-card navigation", async () => {
  const page = await pageWith();
  await page.getByText("gpt-requested (请求)", { exact: false }).waitFor();
  expect(await page.locator("li").count()).toBe(20);
  expect(await page.getByText("协调开销").count()).toBe(1);
  await noOverflow(page); await page.screenshot({ path: resolve(out, "mobile.png") });
  await page.getByRole("button", { name: "近 7 天", exact: true }).click();
  await page.getByText("9,999", { exact: true }).waitFor();
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await page.waitForFunction("document.querySelectorAll('li').length === 40");
  expect(await page.getByRole("button", { name: "加载更多", exact: true }).count()).toBe(0);
  await page.setViewportSize({ width: 1280, height: 900 }); await noOverflow(page);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.screenshot({ path: resolve(out, "desktop.png") });
  await page.route("**/api/v1/ledger/**", (route) => route.fulfill({ status: route.request().url().includes("/historic/") ? 200 : 404, json: {} }));
  await page.getByRole("button", { name: "打开卡片 i28-T4", exact: true }).first().click();
  await page.waitForFunction("document.querySelector('#nav')?.textContent === 'historic:i28-T4'");
  expect(await page.locator("section").count()).toBe(0);
  await page.close();
}, 20_000);

test.skipIf(!enabled)("missing/empty/expired copy and forbidden section", async () => {
  for (const [mode, message] of [["missing", "尚未建立 token 账。"], ["empty", "暂时没有 token 记录。"], ["expired", "轮次明细已超过 30 天保留期。"]]) {
    const page = await pageWith(mode); await page.getByText(message, { exact: true }).waitFor(); await page.close();
  }
  const denied = await pageWith("forbidden");
  await denied.waitForFunction("!document.querySelector('section')"); await denied.close();
}, 20_000);

test.skipIf(!enabled)("switching agent cancels stale data; failed load-more retries without losing rows", async () => {
  const page = await pageWith();
  await page.waitForFunction("document.querySelectorAll('li').length === 20");
  await page.route("**/api/v1/usage/agent/agent-a?*before*", (route) => route.fulfill({ status: 503, json: {} }));
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await page.getByRole("button", { name: "重试", exact: true }).waitFor();
  expect(await page.locator("li").count()).toBe(20);
  await page.unroute("**/api/v1/usage/agent/agent-a?*before*");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction("document.querySelectorAll('li').length === 40");
  await page.route("**/api/v1/usage/agent/agent-b?*", async (route) => {
    await new Promise((done) => setTimeout(done, 100));
    await route.fulfill({ json: { state: "empty", turns: [], today: null, week: null, next: null } });
  });
  await page.evaluate("window.switchUsageAgent('agent-b')");
  await page.getByText("暂时没有 token 记录。", { exact: true }).waitFor();
  expect(await page.locator("li").count()).toBe(0);
  await page.close();
}, 20_000);
