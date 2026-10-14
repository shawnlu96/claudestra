/**
 * UXHOME1「现在」落地页的截图与 DOM 断言（opt-in，截图不进 git）：
 *   NOW_HOME_SHOTS_DIR=<仓库外目录> [NOW_HOME_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-now-home-browser.test.ts
 * 入口写在仓库外（按绝对路径引仓库里的模块，改前改后同一个入口）：真的 Sidebar + 真的 MessageList + 真的协作覆盖层，
 * 外壳照生产 chat.tsx 的窄屏横滑（< 640 只显示一栏）。数据照规格「对照基准」：4 个 agent 其中 2 个忙；3 件等 owner 的 asks（1 件团队提案卡）；
 * 4 个项目（两个绑定团队：一个成组一个单成员；一个本机成组；一个本机单成员）。真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.NOW_HOME_SHOTS_DIR, baseRepo = process.env.NOW_HOME_BASE_REPO;
const FP = "local";

async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  // 入口在仓库外，裸模块名解析不到：react 按 web/node_modules 里的路径引（和组件里的是同一份），不写 JSX
  await Bun.write(entry, `import { createElement as h, useEffect, useState } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { machines } from ${from("web/lib/machines.ts")};
import { ChatStoreProvider, useChatStoreApi } from ${from("web/features/chat/chat-store.ts")};
import { ChatNavContext } from ${from("web/features/chat/components/nav-context.tsx")};
import { Sidebar } from ${from("web/features/chat/components/sidebar.tsx")};
import { MessageList } from ${from("web/features/chat/components/message-list.tsx")};
import { CollabSwitch } from ${from("web/features/collab/collab-switch.tsx")};
import { asksStore } from ${from("web/features/asks/asks-store.ts")};
document.documentElement.dataset.theme = "light";
await machines.add({ fp: "${FP}", name: "fixture" });
await machines.setCurrent("${FP}");
function Seed() {
  const store = useChatStoreApi();
  useEffect(() => { void store.loadAgents(); void store.loadProjects(); return asksStore.start("${FP}"); }, [store]);
  return null;
}
// 布局用行内样式：入口不在 Tailwind 扫描范围里，写的类名不一定生成
const narrow = matchMedia("(max-width: 639.98px)").matches;
function App() {
  const [content, setContent] = useState(false);
  const nav = { showContent: content, toContent: () => setContent(true), toList: () => setContent(false) };
  const side = narrow ? { display: content ? "none" : "flex", width: "100%" } : { display: "flex", flex: "none" };
  const main = { display: narrow && !content ? "none" : "flex", flex: "1 1 0", minWidth: 0, flexDirection: "column", position: "relative", height: "100%" };
  return h(ChatStoreProvider, null, h(ChatNavContext.Provider, { value: nav }, h(Seed),
    h("div", { className: "flex h-screen w-full overflow-hidden bg-base-100 text-base-content" },
      h("div", { style: { ...side, height: "100%" } }, h(Sidebar, { onSelect: () => setContent(true) })),
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
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

function world(dist: string, tw: string) {
  const now = Date.now(), files = readdirSync(dist);
  const ID = { center: "c1", team: "t1", person: "p1", homeInstanceId: "inst-a" };
  const row = (name: string, projectId: string, over: object = {}) => ({ name: `agent-${name}`, status: "active", projectId, cwd: "/repo", purpose: "",
    lastActivityTs: now - 2 * 3600_000, busy: false, ...over });
  const agents = [
    { name: "master", status: "active", busy: false, lastActivityTs: now - 600_000 },
    row("web-dev", "claudestra", { busy: true, label: "网页开发", lastActivityTs: now - 3 * 60_000, ledgerTask: { id: "UXHOME1", stage: "build", round: 0 }, task: "现在总览" }),
    row("pm", "claudestra", { task: "排期" }),
    row("reviewer", "notes", { busy: true, lastActivityTs: null, ledgerReview: { id: "UXNUM1", round: 2, verdict: null, p0: 0, p1: 0, p2: 0 } }),
    row("notes-2", "notes"),
    row("design", "design-kit", { purpose: "设计稿整理" }),
    row("blog", "blog"),
  ];
  const projects = [["claudestra", "Claudestra", "🛠️"], ["design-kit", "设计组件库", "🎨"], ["notes", "读书笔记", "📚"], ["blog", "个人博客", "✍️"]]
    .map(([id, name, emoji]) => ({ id, name, emoji, dirs: [] }));
  const ask = (id: string, over: object) => ({ id, fromAgent: null, assignee: null, project: "notes", taskId: null, title: id, context: "", body: "", kind: "decide",
    kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null, createdAt: now, updatedAt: now,
    expiresAt: now + 86_400_000, canAnswer: true, ...over });
  const asks = [
    ask("ask-1", { createdAt: now - 3 * 3600_000, title: "笔记导出用 Markdown 还是 PDF？", fromAgent: "agent-notes-2" }),
    ask("ask-2", { createdAt: now - 600_000, project: "master", kind: "authorize", source: "system", title: "提案待你批准：组件库按钮统一",
      extra: { centerProposal: { localProjectId: "design-kit" } } }),
    ask("ask-3", { createdAt: now - 3600_000, project: "claudestra", title: "侧栏条默认收起还是展开？", fromAgent: "agent-web-dev" }),
  ];
  const shared = (projectId: string, local: string, name: string) => ({ centerId: "c1", teamId: "t1", projectId, name, rev: 1, status: "active",
    projectRole: { available: true, value: "member" }, localProjectIds: [local] });
  const snapshot = { v: 1, identity: { subject: "owner:self", kind: "person", centerId: "c1", teamId: "t1", personId: "p1", instanceId: "inst-a" },
    teamRole: { available: true, value: "member" }, capabilities: { invite: { available: false }, leave: { available: false } },
    projects: [shared("center-claudestra", "claudestra", "Claudestra"), shared("center-design", "design-kit", "设计组件库")],
    localProjects: projects.map((p) => ({ id: p.id, name: p.name, personal: false, eligible: false, dirs: [] })), peers: [] };
  const ledger = { ok: true, exists: true, now, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks: [], deps: [] };
  const identities = [{ ...ID, project: "center-claudestra", localProjectId: "claudestra" }, { ...ID, project: "center-design", localProjectId: "design-kit" }];
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css">${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}</head>
    <body><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } }; /* Next 在构建期替换的 process.env，这里没有 Next */</script>
    <script type="module" src="/entry.js"></script></body></html>`;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: FP, machineName: "fixture", version: "" });
    if (path === "/api/v1/agents") return json({ ok: true, agents });
    if (path === "/api/v1/projects") return json({ ok: true, projects });
    if (path === "/api/v1/asks") return json({ ok: true, asks, now, canAnswer: true });
    if (path === "/api/v1/shared-ledger/context") return json({ identities });
    if (path === "/api/v1/shared-projects/snapshot") return json(snapshot);
    if (/^\/api\/v1\/ledger\/(notes|blog)$/.test(path)) return json(ledger);
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(dist, path.slice(1)))) : new Response(null, { status: 404 });
  } });
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(300); // 侧栏条高度过渡（.2s）走完
}

test.skipIf(!out)("UXHOME1：落地页（桌面主区 / 手机侧栏条收起与展开）与侧栏项目区，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const server = world(await bundle(repo, resolve(out, `now-bundle-${label}`)), await tailwindCss(repo));
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          await g.page.locator("section[aria-label='团队项目'] h2").waitFor({ timeout: 15_000 }).catch(async (e) => {
            throw new Error(`${label} ${width}: ${e}\nerrors: ${g.errors.join(" | ")}\nbody: ${(await g.page.locator("body").innerText()).slice(0, 400)}`);
          });
          const shot = async (view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 5); // 截图不带行的 hover 态
            const name = `${label}-${view}-${width}x${height}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };
          const team = g.page.locator("section[aria-label='团队项目']");
          await team.getByRole("button", { name: "设计组件库" }).waitFor();
          if (after) {
            await g.page.waitForFunction(`document.querySelectorAll("[data-now-worker]").length >= 2 && document.querySelectorAll("[data-now-wait]").length >= 3`);
            const strip = g.page.locator("[data-now=strip]");
            expect((await strip.locator("button[aria-expanded]").innerText()).replace(/\s+/g, " ").trim()).toBe("现在 · 2 个 agent 在干活 · 3 件等你");
            // 侧栏团队区：区头「团队」；成组的 Claudestra 不重复，单成员的设计组件库还在；绑定项目组的协作视图行带「团队」小标
            expect((await team.locator("h2").innerText()).trim()).toBe("团队");
            expect(await team.getByRole("button", { name: "Claudestra" }).count()).toBe(0);
            await g.page.locator("[data-collab-team-badge]").first().waitFor();
            expect(await g.page.locator("[data-collab-team-badge]").count()).toBe(1);
            if (width >= 640) {
              const page = g.page.locator("[data-now=page]");
              expect((await page.locator("section h3").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim())).toEqual(["等你的事 3 件", "在干活 2 个 agent", "各项目"]);
              expect(await g.page.getByText("选择左侧一个会话开始").count()).toBe(0);
            }
          }
          await shot("home");
          if (width < 640) {
            if (after) {
              await g.page.locator("[data-now=strip] button[aria-expanded]").click();
              await g.page.waitForFunction(`document.querySelector("[data-now=strip]").dataset.nowOpen === "1"`);
            }
            await shot("home-strip-open");
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "now-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "now-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    // 侧栏顶栏「会话」标题在 16rem 宽度下折行是改前就有的（体检第 6 条，拆给 UXSIDE1，文件不在本卡范围），只豁免这一条，别的照断
    const known = (i: ShotIssue) => i.kind === "squeeze" && i.detail === "会话 (2 lines)";
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list: list.filter((i) => !known(i)) }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
