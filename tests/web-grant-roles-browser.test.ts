/** GRANT_ROLES_BROWSER=1 bun test tests/web-grant-roles-browser.test.ts; real UI/API client, intercepted HTTP, no server or credentials.
 * Set GRANT_ROLES_BASELINE=<sha> to capture the original locked form from that revision without switching branches.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { GrantView, LendData } from "../web/features/lend/lend-model";

const enabled = process.env.GRANT_ROLES_BROWSER === "1";
const baseline = process.env.GRANT_ROLES_BASELINE;
const out = resolve(".playwright-mcp/i28-LW1");
const shellSentence = "这会让发起方的任务在你的用户下随时起 shell";
let browser: Browser;
let assets: Map<string, Blob>;
let style: string;

beforeAll(async () => {
  if (!enabled) return;
  const requireWeb = createRequire(resolve("web/package.json"));
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/grant-roles/fixture.tsx");
  await Bun.write(entry, `import React from "react"; import { createRoot } from "react-dom/client";
    import { LendPanel } from "../../features/lend/lend-panel";
    createRoot(document.getElementById("root")).render(<main className="p-3"><LendPanel /></main>);`);
  try {
    const runner = resolve(out, "build.ts"), bundle = resolve(out, "bundle");
    await Bun.write(runner, `import { resolve } from "node:path";
      const baseline = ${JSON.stringify(baseline ?? null)};
      const build = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: "browser", outdir: ${JSON.stringify(bundle)}, plugins: [{
      name: "isolated-grant-panel",
      setup(b) {
        b.onLoad({ filter: /features\\/chat\\/chat-store\\.ts$/ }, () => ({
          contents: "export const useChatStoreApi = () => ({ openAgent: async () => {} });", loader: "ts",
        }));
        if (baseline) b.onLoad({ filter: /features\\/lend\\/(grant-form|lend-model|lend-panel)\\.tsx?$/ }, async ({ path }) => {
          const relative = path.slice(resolve(".").length + 1);
          const result = Bun.spawnSync(["git", "show", baseline + ":" + relative]);
          if (result.exitCode) throw new Error(result.stderr.toString());
          return { contents: result.stdout.toString(), loader: path.endsWith("tsx") ? "tsx" : "ts" };
        });
      },
    }] });
    if (!build.success) throw new Error(build.logs.join("\\n"));`);
    const build = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const [code, log] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code) throw new Error(log);
    assets = new Map(readdirSync(bundle).map((name) => ["/" + name, Bun.file(resolve(bundle, name))]));
  } finally { unlinkSync(entry); }
  const postcss = requireWeb("postcss"), tailwind = requireWeb("@tailwindcss/postcss");
  const from = resolve("web/app/globals.css");
  style = (await postcss([tailwind({ base: resolve("web") })]).process(await Bun.file(from).text(), { from })).css;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 30_000);
afterAll(async () => { await browser?.close(); });

function grant(peer: string, write: boolean): GrantView {
  return { peer, roles: write ? ["review", "write"] : ["review"], repos: ["shawnlu96/claudestra"], families: { codex: 5, claude: 2 },
    ordersPerDay: 200, until: null, grantedAt: null, paused: null, problem: null };
}

async function openPanel(writeOpen: boolean, write = false, theme = "light", refresh?: Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: theme === "light" ? "light" : "dark" });
  const requests: { peer: string; roles?: string[] }[] = [], errors: string[] = [];
  const data: LendData = { writeOpen, maxDays: 7, shellSentence, orders: [], grants: [grant("Shawn", write), grant("Review", false)],
    peers: ["Shawn", "Review", "New"].map((name) => ({ name, fp: name })) };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const asset = assets.get(path);
    if (asset) return route.fulfill({ contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body: Buffer.from(await asset.arrayBuffer()) });
    if (path === "/") {
      const css = [...assets.keys()].filter((p) => p.endsWith(".css")).map((p) => `<link rel="stylesheet" href="${p}">`).join("");
      const js = [...assets.keys()].find((p) => p.endsWith(".js"));
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style>${css}</head>
        <body><div id="root"></div><script type="module" src="${js}"></script></body></html>` });
    }
    if (path === "/app-config.json") return route.fulfill({ json: { mode: "direct", fp: "fixture", machineName: "fixture" } });
    if (path === "/api/v1/lend/claude-token") return route.fulfill({ json: { loggedIn: true, legacyTokenFile: null, legacyTokenEnv: false, reason: null } });
    if (path === "/api/v1/lend/grants") {
      if (route.request().method() === "GET") {
        if (requests.length && refresh) await refresh;
        return route.fulfill({ json: data });
      }
      const body = route.request().postDataJSON();
      requests.push(body);
      let row = data.grants.find((g) => g.peer === body.peer);
      if (!row) { row = grant(body.peer, false); data.grants.push(row); }
      if (body.roles) row.roles = body.roles;
      for (const family of ["codex", "claude"]) if (body[family] !== undefined) row.families[family] = body[family];
      row.repos = body.repos;
      row.ordersPerDay = body.ordersPerDay;
      row.paused = null;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "unexpected fixture route" } });
  });
  await page.goto("http://grant-roles.test/");
  await page.getByRole("button", { name: "授权", exact: true }).waitFor();
  return { page, requests, errors, data };
}

async function openForm(page: Page) {
  await page.getByRole("button", { name: "授权", exact: true }).click();
  await page.getByPlaceholder("owner/repo").fill("shawnlu96/claudestra");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  return page.getByRole("switch", { name: "写代码", exact: true });
}

async function submit(page: Page) {
  await page.getByRole("button", { name: "提交授权", exact: true }).click();
  await page.getByRole("button", { name: "授权", exact: true }).waitFor();
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
  await page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled", fullPage: true });
}

test.skipIf(!enabled || !baseline)("baseline: original form stays locked despite writeOpen=true", async () => {
  const { page, errors } = await openPanel(true, true);
  const toggle = await openForm(page);
  expect(await toggle.getAttribute("aria-disabled")).toBe("true");
  await screenshot(page, "before-locked-390");
  expect(errors).toEqual([]);
  await page.close();
});

test.skipIf(!enabled || !!baseline)("write opens/closes; unchanged roles omitted; list badge and mobile screenshots", async () => {
  for (const theme of ["light", "dark"]) {
    const { page, requests, errors } = await openPanel(true, false, theme);
    let toggle = await openForm(page);
    expect(await toggle.isChecked()).toBe(false);
    await screenshot(page, `${theme}-off-390`);
    await toggle.check();
    expect(await toggle.isChecked()).toBe(true);
    expect(await page.getByText(shellSentence, { exact: true }).count()).toBe(1);
    expect(await page.getByText("审查", { exact: true }).count()).toBe(1);
    await screenshot(page, `${theme}-on-390`);
    await toggle.uncheck();
    await submit(page);
    expect(requests.at(-1)).not.toHaveProperty("roles");
    toggle = await openForm(page);
    await toggle.check();
    await submit(page);
    expect(requests.at(-1)?.roles).toEqual(["review", "write"]);
    const badge = page.locator(".badge", { hasText: "写代码" });
    await badge.waitFor();
    expect(await badge.locator("svg").count()).toBe(1);
    await screenshot(page, `${theme}-badge-390`);
    expect(errors).toEqual([]);
    await page.close();
  }
}, 30_000);

test.skipIf(!enabled || !!baseline)("existing write initializes on; switching peers restores their roles; disabling sends review", async () => {
  const { page, requests, errors } = await openPanel(true, true);
  const toggle = await openForm(page);
  expect(await toggle.isChecked()).toBe(true);
  await toggle.uncheck();
  await page.getByRole("combobox").selectOption("Review");
  expect(await toggle.isChecked()).toBe(false);
  await toggle.check();
  await page.getByRole("combobox").selectOption("New");
  expect(await toggle.isChecked()).toBe(false);
  await page.getByRole("combobox").selectOption("Shawn");
  expect(await toggle.isChecked()).toBe(true);
  await submit(page);
  expect(requests.at(-1)).not.toHaveProperty("roles");
  await openForm(page);
  await toggle.uncheck();
  await submit(page);
  expect(requests.at(-1)?.roles).toEqual(["review"]);
  expect(await page.locator(".badge", { hasText: "写代码" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test.skipIf(!enabled || !!baseline)("writeOpen=false preserves the lock/animation and never sends roles", async () => {
  for (const write of [false, true]) {
    const { page, requests, errors } = await openPanel(false, write);
    const toggle = await openForm(page);
    expect(await toggle.getAttribute("aria-disabled")).toBe("true");
    // aria-disabled still permits the intentional lock feedback through the real DOM click handler.
    await toggle.dispatchEvent("click");
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[role="switch"]')).animationName`)).toContain("lend-lock");
    await screenshot(page, `locked-${write ? "existing-write" : "review"}-390`);
    await submit(page);
    expect(requests.at(-1)).not.toHaveProperty("roles");
    expect(errors).toEqual([]);
    await page.close();
  }
}, 20_000);

test.skipIf(!enabled || !!baseline)("successful submit waits for fresh rows: new grant, roles and slots update without reopening the panel", async () => {
  for (const peer of ["Shawn", "New"]) {
    let release!: () => void;
    const refresh = new Promise<void>((done) => { release = done; });
    const { page, errors } = await openPanel(true, false, "light", refresh);
    const toggle = await openForm(page);
    await page.getByRole("combobox").selectOption(peer);
    await toggle.check();
    await page.getByRole("spinbutton").nth(0).fill("7");
    await page.getByRole("spinbutton").nth(2).fill("3");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/lend/grants"));
    await page.getByRole("button", { name: "提交授权", exact: true }).click();
    await response;
    expect(await page.getByRole("button", { name: "提交授权", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "授权", exact: true }).count()).toBe(0);
    release();
    await page.getByRole("button", { name: "授权", exact: true }).waitFor();
    const row = page.locator(".rounded-lg").filter({ has: page.getByText(peer, { exact: true }) });
    expect(await row.getByText("codex 7 · claude 3 · 200/d", { exact: true }).count()).toBe(1);
    expect(await row.locator(".badge", { hasText: "写代码" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await screenshot(page, `refreshed-${peer.toLowerCase()}-390`);
    await page.close();
  }
}, 20_000);
