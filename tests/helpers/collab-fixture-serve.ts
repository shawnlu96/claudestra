import type { Browser } from "playwright-core";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homeDagBoard, homeDagDiff, homeDagFeature, homeProductBoard, homeWorkBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import type { TeamFromHome } from "../web-team-parity-browser-center.test";

/** legacy = 旧夹具的喂法：本地也由团队模型生成（teamOverview / teamDagBoard / sharedProductBoard，详情 events / timeline 为空） */
export function serve(home: HomeFixture, team: TeamFromHome, bundle: string, legacy = false) {
  const files = readdirSync(bundle), p = home.project, L = `/api/v1/ledger/${p}`;
  const details = new Map(team.details.map((d) => [d.feature.id, d]));
  const teamOv = teamOverview(team.list, details, home.now);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const unexpected: string[] = [];
  const agents = ["dev-1", "dev-2", "dev-3", "pm-a", "rv-1"].map((n) => ({ name: `agent-${n}`, status: "active", projectId: p, cwd: "/repo", lastActivityTs: home.now }));
  const ask = { id: "ask-a7", fromAgent: "agent-dev-1", assignee: null, project: p, taskId: "i28-A7", title: "接口命名二选一", context: "", body: "", kind: "decide",
    kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null,
    createdAt: home.now - 3600_000, updatedAt: home.now - 3600_000, expiresAt: home.now + 86_400_000, canAnswer: true };
  const since = home.now - 3 * 3600_000;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    // 本机这台机器自己的数据（registry / 待办 / peers / 额度）：两边同一台机器，照实都给
    if (path === "/api/v1/agents") return json({ ok: true, agents });
    if (path === "/api/v1/presence") return json({ ok: true });
    if (path === "/api/v1/asks") return json({ ok: true, asks: [ask], now: home.now, canAnswer: true });
    if (path === "/api/v1/peers/contacts") return json({ contacts: [{ name: "peer-mac", online: true, stale: false, agents: [{ name: "dev-x", busy: true }] }] });
    if (path === "/api/v1/team/quota") return json({ providers: [{ provider: "claude", used: 0.42, observedAt: home.now }] });
    if (path === "/api/v1/team/activity") return url.searchParams.get("project") === p ? json({ now: home.now, interactions: [], truncated: false }) : json({ error: "no project" }, 404);
    // 页面挂载时的只读查询：夹具没有会话用量（上下文一律「未知」）；本人是 team-a 成员但不在任何共享项目里、没有提案记录（不出提案按钮）
    if (path === "/api/v1/team/worker-context") return json({ known: false });
    if (path === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center-fixture", teamId: home.team,
      personId: "person-fixture", instanceId: home.sourceInstanceId }, teamRole: { available: true, value: "member" },
      capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [], peers: [] });
    if (path === "/api/v1/shared-feature-proposals" && req.method === "GET") return json({ ok: true, operations: [] });
    if (path === `/api/v1/me/last-seen/${p}`) return req.method === "PUT" ? json({ ok: true })
      : json({ lastSeen: since, now: home.now, events: Object.values(home.details).flatMap((d) => d.events).filter((e) => e.ts > since).sort((a, b) => a.seq - b.seq) });
    // 本机台账：只吐本机形状（legacy 时故意复现旧夹具）
    if (path === L) return json({ ok: true, ...(legacy ? teamOv.ov : home.overview) });
    if (path === `${L}/dag`) return json(legacy ? teamDagBoard(p, team.list, details, teamOv) : homeDagBoard(home));
    if (path === `${L}/product`) return json(legacy ? sharedProductBoard(team.list, home.now, teamOv.ov.tasks) : homeProductBoard(home));
    if (path === `${L}/work`) return json(homeWorkBoard(home));
    const diff = path.match(new RegExp(`^${L}/dag/([^/]+)/diff$`));
    if (diff) {
      const d = homeDagDiff(home, diff[1]!, Number(url.searchParams.get("from")), Number(url.searchParams.get("to")));
      return d ? json(d) : json({ error: "nf" }, 404);
    }
    const feat = path.match(new RegExp(`^${L}/dag/([^/]+)$`));
    if (feat) {
      const v = url.searchParams.get("version");
      const d = homeDagFeature(home, feat[1]!, v ? Number(v) : undefined);
      return d ? json(d) : json({ error: "nf" }, 404);
    }
    const task = path.match(new RegExp(`^${L}/tasks/(.+)$`));
    if (task) {
      const d = home.details[task[1]!];
      return d ? json({ ok: true, ...(legacy ? { task: teamOv.ov.tasks.find((t) => t.id === task[1]) ?? d.task, events: [], timeline: [], now: home.now } : d) }) : json({ error: "nf" }, 404);
    }
    // 团队：只吐由本机数据推出的投影
    if (path === "/api/v1/shared-ledger/features") return json(team.list);
    const shared = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (shared) return details.has(shared[1]!) ? json(details.get(shared[1]!)) : json({ error: "nf" }, 404);
    if (path.startsWith("/api/")) {
      if (!/^\/api\/v1\/(events|agents\/|me\/last-seen\/|team\/activity|ledger\/shared-ledger)/.test(path)) unexpected.push(`${req.method} ${path}`);
      return json({ ok: false, error: "not in fixture" }, 404);
    }
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    return new Response(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, team, unexpected };
}


/**
 * 每个页面都从这里开：BrowserContext 级的 HTTP 与 WebSocket 路由在建页、首次导航之前装好，非回环服务器本源的一律 abort / close 并记账。
 * 调用方断言 external 为空；tests 里的 sentinel 用例证明拦截真的生效（不同源的第二个回环服务器收不到请求）。
 */

export async function guardedPage(browser: Browser, url: string, opts: { width?: number; theme?: "light" | "dark"; locale?: string } = {}) {
  const origin = new URL(url).origin, wsOrigin = origin.replace(/^http/, "ws");
  // locale 固定 zh-CN（Cf1，PM 定）：不设时 Chromium 退到 navigator.language=en-US，hhmm() 的 toLocaleString([]) 出「10/2, 13:00」，
  // 和中文夹具的 G6 检测对不上；进程 LANG 管不到 macOS Chromium。en-US 只给负探针用
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1200, height: 900 }, colorScheme: opts.theme ?? "light", timezoneId: "Asia/Shanghai",
    locale: opts.locale ?? "zh-CN" });
  const calls: string[] = [], external: string[] = [], errors: string[] = [];
  await ctx.route("**/*", (r) => {
    if (new URL(r.request().url()).origin === origin) return r.continue();
    external.push(r.request().url());
    return r.abort();
  });
  await ctx.routeWebSocket(() => true, (ws) => {
    if (new URL(ws.url()).origin === wsOrigin) return void ws.connectToServer();
    external.push(ws.url());
    return ws.close();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000);
  page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(`${r.method()} ${decodeURIComponent(new URL(r.url()).pathname + new URL(r.url()).search)}`); });
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, calls, external, errors };
}


export async function bundleHarness(dir: string) {
  const bundle = resolve(dir, "fixture-bundle");
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/shared/fixture-harness.tsx", "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return bundle;
}
