/**
 * team-project-UXASK2 截图与浏览器断言（opt-in，截图不进 git）：
 *   TEAM_PROJECT_ASKS_SHOTS_DIR=<仓库外目录> [TEAM_PROJECT_ASKS_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-team-project-asks-browser.test.ts
 * 打包 web/features/collab/shared-projects/fixture-harness.tsx（?fixture=n4-source：生产的 sharedProjectsApi 端口，改前它的确认卡区自己轮询 /asks），
 * 前面垫一个入口照生产外壳（asks-entry.tsx）启动 asks store、在它打开时挂生产的 AsksDrawer（起法同 tests/web-collab-owner-waits-browser.test.ts 的 ?drawer=1）。
 * 数据照规格「对照基准」：加入邀请卡（带选择行、推荐 create）、建项目确认卡（无选择行）、普通 agent 拍板卡、按钮被改过的 shared-projects 卡；三张授权卡都带 bind.params 哨兵。
 * 页面：抽屉（团队项目确认组）、项目设置对话框底部；1280 与 390、浅色。给了 BASE_REPO 就用同一份数据再拍一套「改前」（只截图、只断言改前现状）。
 * 回环 Bun.serve，非回环请求一律拦掉并断言为 0（tests/helpers/collab-fixture-serve.ts guardedPage）。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.TEAM_PROJECT_ASKS_SHOTS_DIR, baseRepo = process.env.TEAM_PROJECT_ASKS_BASE_REPO;
const SECRET = { centerId: "sentinel-center-7f3a", teamId: "sentinel-team-91c2", instanceId: "sentinel-instance-4be0" };

/** 垫的入口：启动 asks store（同生产外壳）；?drawer=1 直接打开抽屉；body 上记侧栏「待你处理」的数（askCounts），改前改后对比 */
async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  // 入口在仓库外，裸模块名解析不到：react 按 web/node_modules 里的路径引（和夹具里的是同一份），不写 JSX
  await Bun.write(entry, `import { createElement } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { asksStore, useAsks } from ${from("web/features/asks/asks-store.ts")};
import { askCounts } from ${from("web/features/asks/asks-model.ts")};
import { AsksDrawer } from ${from("web/features/asks/components/asks-drawer.tsx")};
import ${from("web/features/collab/shared-projects/fixture-harness.tsx")};
asksStore.start("synthetic-machine");
asksStore.subscribe(() => { document.body.dataset.waiting = String(askCounts(asksStore.get().asks).waiting); });
function Inbox() { return useAsks().open ? createElement(AsksDrawer, { onOpenChat() {} }) : null; }
createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Inbox));
if (new URLSearchParams(location.search).has("drawer")) asksStore.openDrawer();
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser",
    "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 生产的 Tailwind 样式表（web/app/globals.css） */
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

function asks(now: number) {
  const ask = (over: Record<string, unknown>) => ({ fromAgent: null, assignee: null, createdBy: null, project: "master", taskId: null, context: "", body: "",
    kind: "authorize", kindHint: null, source: "system", options: [], allowText: false, blocking: true, urgency: "normal", state: "open", answer: null,
    updatedAt: now - 600_000, expiresAt: now + 86_400_000, canAnswer: true, ...over });
  const buttons = (a: string, d: string, la: string, ld: string) => ({ type: "buttons", buttons: [{ id: a, label: la, style: "success" }, { id: d, label: ld, style: "secondary" }] });
  return [
    ask({ id: "join", createdBy: "system:shared-ledger-join-offer", createdAt: now - 3_600_000, title: "邀请加入团队项目 合成项目",
      context: "邀请人：合成伙伴\n加入后在本机对应一个项目", bind: { action: "shared-ledger.join", params: SECRET },
      options: [buttons("sl_join_accept", "sl_join_decline", "确认加入", "不加入"),
        { type: "select", id: "sl_join_local", placeholder: "选本机项目", options: [{ value: "create", label: "新建本机项目" }, { value: "local-app", label: "绑定本机工作区" }] }],
      extra: { sharedProjectChoice: { selectId: "sl_join_local", recommended: "create" } } }),
    ask({ id: "create", createdBy: "system:shared-projects", createdAt: now - 3_000_000, title: "创建团队项目 合成工作台",
      context: "在团队 合成团队 下创建项目 合成工作台", bind: { action: "shared-projects.create", params: SECRET },
      options: [buttons("shared_project_confirm", "shared_project_cancel", "确认创建", "取消创建")] }),
    ask({ id: "decide", fromAgent: "agent-dev-1", kind: "decide", source: "reply", createdAt: now - 2_400_000, title: "接口命名二选一", allowText: true,
      options: [buttons("opt_a", "opt_b", "用 A", "用 B")] }),
    ask({ id: "tampered", createdBy: "system:shared-projects", createdAt: now - 1_800_000, title: "创建团队项目 被改过的合成卡",
      context: "按钮不是 bridge 开的那两颗", bind: { action: "shared-projects.create", params: SECRET },
      options: [buttons("shared_project_confirm", "shared_project_other", "确认创建", "别的按钮")] }),
  ];
}

function world(dist: string, tw: string, now: number) {
  const files = new Set(Array.from(new Bun.Glob("*").scanSync(dist)));
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const answers: { id: string; choices: string[] }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    if (path === "/app-config.json") return json({ mode: "direct", fp: "synthetic-machine", machineName: "fixture", version: "" });
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (path === "/api/v1/asks") return json({ ok: true, asks: asks(now), full: true, now, canAnswer: true });
    if (path === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center", teamId: "team",
      personId: "person-a", instanceId: "instance-a" }, teamRole: { available: true, value: "owner" },
      capabilities: { invite: { available: false }, leave: { available: false } },
      projects: [{ centerId: "center", teamId: "team", projectId: "workbench", name: "合成工作台", rev: 1, status: "active",
        projectRole: { available: true, value: "owner" }, localProjectIds: ["local-app"] }],
      localProjects: [{ id: "local-app", name: "本机工作区", personal: false, eligible: false, dirs: [] }], peers: [] });
    const answer = path.match(/^\/api\/v1\/ledger\/[^/]+\/asks\/([^/]+)\/answer$/);
    if (answer) { answers.push({ id: answer[1]!, ...(await req.json()) }); return json({ ok: true }); }
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    if (path !== "/") return files.has(path.slice(1)) ? new Response(Bun.file(resolve(dist, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/tw.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, answers };
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}
const headings = (page: Page) => page.evaluate(`[...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent.replace(/\\s+/g, " ").trim())`);

test.skipIf(!out)("UXASK2：团队项目确认卡在抽屉单列一组、专用控件作答；对话框只留一行入口，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const now = Date.now();
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const shots: { file: string; sha256: string }[] = [], waiting: Record<string, string | null> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const w = world(await bundle(repo, resolve(out, `bundle-${label}`)), await tailwindCss(repo), now);
      try {
        for (const width of [1280, 390]) {
          const page = async (extra = "") => {
            const g = await guardedPage(browser, w.server.url.href, { width });
            await g.page.clock.install({ time: now });
            const ready = g.page.waitForResponse((r) => r.url().includes("/api/v1/asks"));
            await g.page.goto(`${w.server.url}?fixture=n4-source&theme=light${extra}`);
            await ready;
            await g.page.waitForFunction("document.body.dataset.waiting !== undefined");
            return g;
          };
          const shot = async (g: Awaited<ReturnType<typeof page>>, view: string) => {
            await settle(g.page);
            const name = `${label}-${view}-${width}`;
            const png = await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            shots.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };

          // 1. 抽屉
          const d = await page("&drawer=1");
          const drawer = d.page.getByRole("dialog", { name: "待你处理" });
          await drawer.getByText("接口命名二选一").waitFor();
          waiting[`${label}-${width}`] = await d.page.evaluate("document.body.dataset.waiting");
          const html = await drawer.innerHTML();
          if (after) {
            expect(await headings(d.page)).toEqual(["团队项目确认 · 3", "等你处理 · 1"]);
            for (const v of Object.values(SECRET)) expect({ v, shown: html.includes(v) }).toEqual({ v, shown: false });
            expect(await d.page.locator("#ask-join select").inputValue()).toBe("create");
            expect(await d.page.locator("#ask-tampered button:not([aria-label])").count()).toBe(0);
            await d.page.locator("#ask-tampered").getByText("这张确认卡格式不对，不能在这里确认").waitFor();
          } else {
            expect(await headings(d.page)).toEqual(["等你处理 · 4"]);
            expect(html).toContain(SECRET.centerId);
          }
          await shot(d, "drawer");
          await d.ctx.close();

          // 2. 项目设置对话框底部
          const s = await page();
          await s.page.getByRole("button", { name: "项目设置", exact: true }).click();
          const region = s.page.getByRole("region", { name: "项目确认卡", exact: true });
          await region.waitFor();
          const before = s.calls.filter((c) => c.startsWith("GET /api/v1/asks")).length;
          await s.page.clock.fastForward(10_000);
          await settle(s.page);
          const polled = s.calls.filter((c) => c.startsWith("GET /api/v1/asks")).length - before;
          if (after) {
            expect({ width, polled }).toEqual({ width, polled: 0 });
            await region.getByText("有 3 张团队项目确认待你处理", { exact: true }).waitFor();
          } else {
            expect(polled).toBeGreaterThan(0);
            await region.getByText("邀请加入团队项目 合成项目").waitFor();
          }
          await region.scrollIntoViewIfNeeded();
          await shot(s, "dialog");
          if (after) {
            // 去处理：对话框收起、抽屉打开并定位到第一张（邀请卡），它在最上层
            await region.getByRole("button", { name: "去处理", exact: true }).click();
            await s.page.getByRole("dialog", { name: "待你处理" }).waitFor();
            await s.page.waitForFunction(`(() => { const c = document.getElementById("ask-join"); return c && c.className.includes("border-primary"); })()`);
            const onTop = await s.page.evaluate(`(() => { const c = document.getElementById("ask-join"), r = c.getBoundingClientRect();
              return c.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 12)); })()`);
            expect(onTop).toBe(true);
            await s.page.locator("#ask-join").getByRole("button", { name: "确认加入", exact: true }).click();
            await s.page.waitForFunction("document.body.dataset.waiting === '3'");
            expect(w.answers.splice(0)).toEqual([{ id: "join", choices: ["[button:sl_join_accept]", "[select:sl_join_local:create]"] }]);
            requests[`${label}-go-${width}`] = { external: [...s.external], errors: [...s.errors] };
          }
          await s.ctx.close();
        }
      } finally { w.server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, "manifest.json"), JSON.stringify({ shots, waiting }, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
    // 侧栏「待你处理」的数：同一份数据改前改后相等（4 张开着的都算）
    for (const [k, v] of Object.entries(waiting)) expect({ k, v }).toEqual({ k, v: "4" });
  } finally { await browser.close(); }
}, 600_000);
