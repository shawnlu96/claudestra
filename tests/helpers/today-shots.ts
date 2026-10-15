/**
 * TODAY1「今天」页的合成数据与回环夹具（模型单测、happy-dom、截图共用一份）。照规格「对照基准」：时刻 2026-10-14 12:00（Asia/Shanghai），
 * 标题全部合成。
 * - 项目 A：有产品看板，两个在做模块（导出 3 张在做、2 个 agent；通知 1 张在做）；1 条出问题（返工）、1 条停留 3 小时的卡住（审查），今天完成 2 张。
 * - 项目 B：没有产品看板（/product 404），1 个忙 agent，1 条卡住（合并，停 2 小时），今天完成 1 张。
 * - 项目 C：台账 403。
 * - 3 件等 owner 的 asks，其中 1 件带 taskId（A1）；/lend/quota-lines：Claude 62%、Codex 18%。
 * 纯数据 + Response 构造，不 import web 里带 React 的模块。
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const TODAY_NOW = Date.UTC(2026, 9, 14, 4, 0); // 2026-10-14 12:00 Asia/Shanghai
const H = 3600_000;

export const PROJECTS = [["proj-a", "合成项目 A"], ["proj-b", "合成项目 B"], ["proj-c", "合成项目 C"]].map(([id, name]) => ({ id: id!, name: name!, emoji: null, dirs: [] }));

/** 会话（前端名，不带 agent- 前缀；接口里由 apiAgents 加上） */
export function todayAgents(now = TODAY_NOW) {
  const row = (name: string, projectId: string | null, over: object = {}) => ({ name, displayName: name, purpose: "", cwd: "/repo", status: "active" as const, projectId,
    lastActivityTs: now - 2 * H, busy: false, ...over });
  return [
    row("a-dev1", "proj-a", { busy: true, label: "导出开发", lastActivityTs: now - 5 * 60_000, ledgerTask: { id: "A1", stage: "build", round: 0 } }),
    row("a-dev2", "proj-a", { busy: true, label: "通知开发", lastActivityTs: now - 8 * 60_000, ledgerTask: { id: "A4", stage: "build", round: 0 } }),
    row("b-dev", "proj-b", { busy: true, label: "同步开发", lastActivityTs: now - 12 * 60_000, ledgerTask: { id: "B1", stage: "merge", round: 1 } }),
    row("b-pm", "proj-b", { task: "排期" }),
  ];
}

const META = { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } };
const task = (id: string, title: string, stage: string, over: object = {}) => ({ id, title, kind: "feature", stage, round: 0, updatedAt: TODAY_NOW - H, metrics: {}, ...over });

export function todayLedgers(now = TODAY_NOW): Record<string, object> {
  const a = [
    task("A1", "导出按钮改版", "build", { agent: "agent-a-dev1", stageSince: now - 40 * 60_000 }),
    task("A2", "导出格式校验", "review", { agent: "agent-a-dev2", stageSince: now - 3 * H }),
    task("A3", "导出预览", "fix", { agent: "agent-a-dev1", round: 1, stageSince: now - 50 * 60_000,
      lastReview: { round: 1, verdict: "fix", p0: 0, p1: 1, p2: 0, text: "窄屏下预览溢出", ts: now - 50 * 60_000 } }),
    task("A4", "通知设置页", "build", { agent: "agent-a-dev2", stageSince: now - 20 * 60_000 }),
    task("A5", "导出入口文案", "done", { metrics: { endTs: now - H } }),
    task("A6", "导出权限提示", "verified", { metrics: { endTs: now - 2 * H } }),
    task("A7", "旧导出清理", "done", { metrics: { endTs: now - 30 * H } }),
  ];
  const b = [
    task("B1", "同步失败重试", "merge", { agent: "agent-b-dev", stageSince: now - 2 * H }),
    task("B2", "同步状态图标", "done", { metrics: { endTs: now - 3 * H } }),
  ];
  const ov = (tasks: object[]) => ({ ok: true, exists: true, now, meta: META, items: [], tasks, deps: [] });
  return { "proj-a": ov(a), "proj-b": ov(b) };
}

const feature = (id: string, title: string, status: string, counts: object, cards: { id: string; title: string; stage: string }[]) =>
  ({ id, title, status, hasDag: false, version: 1, counts, eta: null, cards });

export function todayBoards(): Record<string, object> {
  return {
    "proj-a": { deps: [], features: [
      feature("f-export", "导出", "active", { total: 6, completed: 2, active: 3 }, [
        { id: "A1", title: "导出按钮改版", stage: "build" }, { id: "A2", title: "导出格式校验", stage: "review" }, { id: "A3", title: "导出预览", stage: "fix" },
        { id: "A5", title: "导出入口文案", stage: "done" }, { id: "A6", title: "导出权限提示", stage: "verified" }, { id: "A7", title: "旧导出清理", stage: "done" }]),
      feature("f-notify", "通知", "active", { total: 3, completed: 1, active: 1 }, [{ id: "A4", title: "通知设置页", stage: "build" }]),
      feature("f-old", "旧版首页", "done", { total: 4, completed: 4, active: 0 }, []),
    ] },
  };
}

export function todayAsks(now = TODAY_NOW) {
  const ask = (id: string, over: object) => ({ id, fromAgent: null, assignee: null, project: "proj-a", taskId: null, title: id, context: "", body: "", kind: "decide",
    kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null, createdAt: now, updatedAt: now,
    expiresAt: now + 24 * H, canAnswer: true, ...over });
  return [
    ask("ask-task", { createdAt: now - 10 * 60_000, taskId: "A1", fromAgent: "agent-a-dev1", title: "导出按钮放顶栏还是更多菜单？" }),
    ask("ask-b", { createdAt: now - H, project: "proj-b", fromAgent: "agent-b-pm", title: "同步失败时要不要提醒？" }),
    ask("ask-c", { createdAt: now - 3 * H, project: "proj-c", title: "合成项目 C 的台账要开给这台设备吗？" }),
  ];
}

const QUOTA_LINES = { ok: true, config: { status: "ok", error: null, mode: "auto" }, at: TODAY_NOW,
  families: [{ family: "claude", weekUsedPct: 62, warnPct: 80, stopPct: 95 }, { family: "codex", weekUsedPct: 18, warnPct: 80, stopPct: 95 }] };

/**
 * 夹具接口：path 去掉 /api/v1 之后的部分；不认的返回 null（调用方 404）。/events 一律 404（不连事件流，轮询照常）。
 * world 可改：ledgers / boards / asks 换掉某一份做空态。
 */
export function todayRoute(path: string, world = todayWorld()): Response | null {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (path === "/agents") return json({ ok: true, agents: world.agents.map((a) => { const n = (a as { name: string }).name; return { ...a, name: n === "master" ? n : `agent-${n}` }; }) });
  if (path === "/projects") return json({ ok: true, projects: PROJECTS });
  if (path === "/asks") return json({ ok: true, asks: world.asks, now: world.now, canAnswer: true });
  if (path === "/lend/quota-lines") return json(QUOTA_LINES);
  if (path === "/ledger/proj-c" || path === "/ledger/proj-c/product") return json({ ok: false, error: "forbidden" }, 403);
  const ledger = /^\/ledger\/([\w-]+)$/.exec(path)?.[1];
  if (ledger && world.ledgers[ledger]) return json(world.ledgers[ledger]);
  const board = /^\/ledger\/([\w-]+)\/product$/.exec(path)?.[1];
  if (board && world.boards[board]) return json(world.boards[board]);
  return null;
}

export function todayWorld(now = TODAY_NOW) {
  return { now, agents: todayAgents(now) as object[], asks: todayAsks(now) as object[], ledgers: todayLedgers(now), boards: todayBoards() };
}

/** 截图入口：仓库外写一个入口（按绝对路径引仓库里的模块，改前改后同一个入口），外壳照生产 chat.tsx 的窄屏横滑 */
export async function bundleToday(repo: string, dir: string, fp: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h, useEffect, useState } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { machines } from ${from("web/lib/machines.ts")};
import { ChatStoreProvider, useChatStoreApi } from ${from("web/features/chat/chat-store.ts")};
import { ChatNavContext } from ${from("web/features/chat/components/nav-context.tsx")};
import { Sidebar } from ${from("web/features/chat/components/sidebar.tsx")};
import { MessageList } from ${from("web/features/chat/components/message-list.tsx")};
import { CollabSwitch, closingCollab } from ${from("web/features/collab/collab-switch.tsx")};
import { asksStore } from ${from("web/features/asks/asks-store.ts")};
document.documentElement.dataset.theme = "light";
await machines.add({ fp: "${fp}", name: "fixture" });
await machines.setCurrent("${fp}");
function Seed() {
  const store = useChatStoreApi();
  useEffect(() => { void store.loadAgents(); void store.loadProjects(); return asksStore.start("${fp}"); }, [store]);
  return null;
}
const narrow = matchMedia("(max-width: 639.98px)").matches;
function App() {
  const [content, setContent] = useState(false);
  const nav = { showContent: content, toContent: () => setContent(true), toList: () => setContent(false) };
  const side = narrow ? { display: content ? "none" : "flex", width: "100%" } : { display: "flex", flex: "none" };
  const main = { display: narrow && !content ? "none" : "flex", flex: "1 1 0", minWidth: 0, flexDirection: "column", position: "relative", height: "100%" };
  return h(ChatStoreProvider, null, h(ChatNavContext.Provider, { value: nav }, h(Seed),
    h("div", { className: "flex h-screen w-full overflow-hidden bg-base-100 text-base-content" },
      h("div", { style: { ...side, height: "100%" } }, h(Sidebar, { onSelect: closingCollab(() => setContent(true)) })),
      h("main", { style: main }, h(MessageList), h(CollabSwitch)))));
}
createRoot(document.getElementById("root")).render(h(App));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 生产的 Tailwind 样式表（web/app/globals.css） */
export async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

/** 回环服务：页面、样式、打包产物 + 夹具接口；夹具之外的 /api 一律 404。extra 先答（别的卡加自己的接口，如 ONB-3 的 onboard） */
export function serveToday(dist: string, tw: string, fp: string, extra?: (path: string, req: Request) => Response | null | Promise<Response | null>) {
  const files = readdirSync(dist), world = todayWorld();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css">${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}</head>
    <body><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } };</script>
    <script type="module" src="/entry.js"></script></body></html>`;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const own = path.startsWith("/api/v1/") ? await extra?.(path.slice("/api/v1".length), req) : null;
    if (own) return own;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp, machineName: "fixture", version: "" });
    if (path.startsWith("/api/v1/")) return todayRoute(path.slice("/api/v1".length), world) ?? Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
    if (path.startsWith("/api/")) return Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
    return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(dist, path.slice(1)))) : new Response(null, { status: 404 });
  } });
}
