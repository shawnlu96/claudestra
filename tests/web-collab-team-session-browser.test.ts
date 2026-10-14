/**
 * team-project-TEAMVIS8 截图（opt-in）：TEAM_SESSION_SHOTS_DIR=<目录> bun test tests/web-collab-team-session-browser.test.ts
 * 团队卡详情的「会话」区，浅色 1280 / 390，三态各一张：有内容（工具组展开、一步工具点开）/ 主场离线 / 主场未开放。
 * 真浏览器里照生产样式跑（globals.css 过 Tailwind），过截图自动检查；页面发出的请求只许到回环的夹具服务器。
 * 纯合成数据，回环 Bun.serve，不连生产；等待窗口在夹具里调短（不然主场离线要真等 30 秒）。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.TEAM_SESSION_SHOTS_DIR;
const PROJECT = "session-proj", FOCUS = "R1", HOME = "f".repeat(32), MASK = "[已遮蔽:疑似密钥]";
const ROOT = "/api/v1/shared-ledger/team-body/features/F1/tasks/task-1";
const STATES = ["content", "home-offline", "not-open"] as const;
type State = (typeof STATES)[number];

const ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatStoreProvider } from "@/features/chat/chat-store";
import { CollabView } from "@/features/collab/collab-view";
import { openCollab, openCollabTask } from "@/features/collab/collab-nav";
import { sharedCollabProject } from "@/features/collab/dag/shared-navigation";
import { TeamSource } from "@/features/collab/shared/team-ops";
import { setTeamSessionTimingForTest } from "@/features/collab/team-session/team-session-source";

const identity = { center: "center", team: "team-a", person: "person-a", project: ${JSON.stringify(PROJECT)}, machine: "local", homeInstanceId: "mine-1" };
const project = sharedCollabProject(identity);
setTeamSessionTimingForTest({ pollMs: 100, waitMs: 500 });
openCollab(project);
openCollabTask(${JSON.stringify(FOCUS)});
createRoot(document.getElementById("root")!).render(
  <ChatStoreProvider>
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <TeamSource identity={identity}><CollabView project={project} /></TeamSource>
    </div>
  </ChatStoreProvider>,
);
`;

function fixture() {
  const now = Date.now();
  const caps = { "feature.new": { enabled: true } };
  const feature = { id: "F1", projectId: PROJECT, title: "会话事项", description: "看会话", rev: 1, version: 1,
    authorityMode: "planning", homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active",
    counts: { total: 1, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: now,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: now, receivedAt: now } };
  const task = { taskId: "task-1", sourceTaskId: FOCUS, sourceRev: 1, sourceSeq: 9, stage: "review", assigneeCode: "peer-dev", executorInstanceId: HOME,
    pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only", steps: [], asks: [] };
  const detail = { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: [{ key: FOCUS, oneLine: "在审的卡", deps: [], fileGlobs: [], estimate: "" }], bindings: [{ nodeKey: FOCUS, taskId: "task-1" }] },
    tasks: [task] };
  const rec = (kind: string, sourceKey: string, text: string) =>
    ({ featureId: "F1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: "d".repeat(64) });
  const page = [
    rec("session-page", "author:5", "[用户]\n先把空列表的用例补上，再跑一遍测试"),
    rec("session-page", "author:6", `[助手]\n补好了，空列表直接返回。\n\n${MASK}\n[工具]\nRead: src/lib/list.ts\nBash: cat .env\n${MASK}\nEdit: src/lib/list.ts`),
    rec("session-page", "author:7", "[系统]\n上下文已压缩"),
    rec("session-page", "author:8", "[助手]\n测试全绿，已交付 PR #31\n[工具]\nBash: bun test tests/list.test.ts"),
  ];
  return {
    list: { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, features: [feature] }, detail, now,
    body: { schemaVersion: 1, teamId: "team-a", projectId: PROJECT, featureId: "F1", taskId: "task-1", records: [rec("event", "3", "开工：先写测试")],
      syncedAt: now - 60_000, homeOnline: true },
    page,
  };
}

test.skipIf(!out)("team session viewer: content / home offline / not open at 1280 / 390, light", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const work = resolve(out, "bundle"), dir = resolve("web/.next/team-session-fixture");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "fixture.tsx");
  writeFileSync(entry, ENTRY);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", work, "--tsconfig-override", "web/tsconfig.json"],
    { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  unlinkSync(entry);
  if (code) throw new Error(err);
  const webRequire = createRequire(resolve("web/package.json"));
  const globals = resolve("web/app/globals.css");
  const tw = await webRequire("postcss")([webRequire("@tailwindcss/postcss")({ base: resolve("web") })]).process(readFileSync(globals, "utf8"), { from: globals });
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css"><link rel="stylesheet" href="/fixture.css"><style>#root{height:100vh;position:relative}</style></head>
    <body class="bg-base-100 text-base-content"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
  const fx = fixture();
  let state: State = "content";
  const writes: string[] = [];
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method !== "GET") writes.push(`${req.method} ${path}`);
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/tw.css") return new Response(tw.css, { headers: { "content-type": "text/css" } });
    if (/^\/fixture\.(js|css)$/.test(path)) return new Response(Bun.file(join(work, path)));
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === "/api/v1/agents") return json({ ok: true, agents: [] });
    if (path === "/api/v1/shared-ledger/features") return json(fx.list);
    if (path === "/api/v1/shared-ledger/features/F1") return json(fx.detail);
    if (path === ROOT) return json(fx.body);
    if (path === `${ROOT}/session-pages` && req.method === "POST") return json({ requestId: "req-1", expiresAt: fx.now + 600_000 });
    if (path === `${ROOT}/session-pages/req-1`) {
      const base = { requestId: "req-1", expiresAt: fx.now + 600_000, homeOnline: state !== "home-offline" };
      if (state === "home-offline") return json({ ...base, status: "pending", result: null });
      if (state === "not-open") return json({ ...base, status: "ready", result: { kind: "refused", code: "not_open" } });
      return json({ ...base, status: "ready", result: { kind: "page", records: fx.page, nextCursor: "v1:author:5" } });
    }
    return path.startsWith("/api/") ? json({ ok: false, error: "not in fixture" }, 404) : new Response(null, { status: 404 });
  } });
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, external: Record<string, string[]> = {}, shots: { view: string; size: string; file: string; sha256: string }[] = [];
  const texts: Record<string, string> = {};
  try {
    for (const width of [1280, 390]) for (state of STATES) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors: string[] = [], outside: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.hostname !== "127.0.0.1") outside.push(r.url()); });
      await page.goto(server.url.href);
      const sec = page.locator("[data-team-session]");
      await sec.waitFor({ timeout: 15_000 });
      await sec.locator("[data-session-toggle]").click();
      const want = state === "content" ? "ready" : state === "home-offline" ? "home_offline" : "not_open";
      await page.locator(`[data-team-session="${want}"]`).waitFor({ timeout: 15_000 });
      if (state === "content") {
        // 工具组展开、Bash 那一步点开：折叠 / 展开 / 已遮蔽都在图里
        await sec.locator("[data-role=assistant] button[aria-expanded]").first().click();
        await sec.locator("[data-tool-row] button", { hasText: "cat .env" }).click();
        await sec.locator("[data-tool-output]").waitFor();
      }
      await page.evaluate("document.fonts.ready");
      await sec.scrollIntoViewIfNeeded();
      await page.evaluate("document.querySelector('[data-team-session]').scrollIntoView({ block: 'start' })");
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const name = `after-team-session-${state}-${width}`;
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      shots.push({ view: `team-session-${state}`, size: String(width), file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
      issues[name] = await shotIssues(page);
      external[name] = outside;
      texts[name] = await sec.innerText();
      expect({ name, errors }).toEqual({ name, errors: [] });
      // 只读：没有输入框 / 可编辑元素
      expect(await sec.locator("textarea, input, [contenteditable='true'], [contenteditable=''], [role='textbox']").count()).toBe(0);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
  const manifest = { card: "team-project-TEAMVIS8", theme: "light", states: STATES, shots, issues, external, writes: [...new Set(writes)] };
  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  for (const [name, list] of Object.entries(external)) expect({ name, list }).toEqual({ name, list: [] });
  // 页面发过的写请求只有登记取页
  expect([...new Set(writes)]).toEqual([`POST ${ROOT}/session-pages`]);
  for (const width of [1280, 390]) {
    expect(texts[`after-team-session-content-${width}`]).toContain("已遮蔽 1 段");
    expect(texts[`after-team-session-content-${width}`]).toContain("3 步工具调用");
    expect(texts[`after-team-session-home-offline-${width}`]).toContain("主场离线，暂时看不了会话");
    expect(texts[`after-team-session-not-open-${width}`]).toContain("主场未开放会话");
  }
}, 240_000);
