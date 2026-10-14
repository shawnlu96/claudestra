/**
 * UXFIX1 截图与 DOM 断言（opt-in，截图不进 git）：
 *   COLLAB_LOAD_STATE_SHOTS_DIR=<仓库外目录> [COLLAB_LOAD_STATE_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-collab-load-state-browser.test.ts
 * 页面照 web/features/collab/shared/fixture-harness.tsx 的本机分支（?side=local）挂 CollabView；它没有会话导航，这里垫的入口多包一层 ChatNavContext，
 * toList 把协作视图换成一块「会话列表」，用来断言点返回真的离开了协作视图。改前 / 改后同一个垫法、同一份数据。
 * 三种整页状态：读失败无缓存（台账接口回 503，body 带合成原文）/ 空台账（项目存在、0 个任务、没有 ops）/ 读取中（接口挂起不回）。
 * 1280 与 390、浅色。回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.COLLAB_LOAD_STATE_SHOTS_DIR, baseRepo = process.env.COLLAB_LOAD_STATE_BASE_REPO;
const RAW = "synthetic ledger failure: upstream HTTP 503 at 127.0.0.1";
const LEFT = "fixture-chat-list";
type Mode = "fail" | "empty" | "loading";
const MODES: readonly Mode[] = ["fail", "empty", "loading"];

/** 入口在仓库外，裸模块名解析不到：react 按 web/node_modules 里的路径引，不写 JSX */
async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h, useEffect, useState } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { asksStore } from ${from("web/features/asks/asks-store.ts")};
import { ChatStoreProvider } from ${from("web/features/chat/chat-store.ts")};
import { ChatNavContext } from ${from("web/features/chat/components/nav-context.tsx")};
import { CollabView } from ${from("web/features/collab/collab-view.tsx")};
const project = new URLSearchParams(location.search).get("project");
function Harness() {
  const [list, setList] = useState(false);
  useEffect(() => asksStore.start("local"), []);
  const nav = { showContent: !list, toContent: () => setList(false), toList: () => setList(true) };
  return h(ChatStoreProvider, null, h(ChatNavContext.Provider, { value: nav },
    h("div", { style: { position: "absolute", inset: 0, display: "flex" } }, list ? h("div", { "data-testid": ${JSON.stringify(LEFT)} }, "会话列表") : h(CollabView, { project }))));
}
createRoot(document.getElementById("root")).render(h(Harness));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser",
    "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 夹具服务器前面套一层：台账总览按 mode 换成失败 / 空 / 挂起，并记下打了几次；其余原样转给它 */
function world(home: ReturnType<typeof generateHomeFixture>, inner: string) {
  const L = `/api/v1/ledger/${home.project}`, state = { mode: "fail" as Mode, hits: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    if (path === L && req.method === "GET") {
      state.hits++;
      if (state.mode === "fail") return Response.json({ ok: false, error: RAW, message: RAW }, { status: 503 });
      if (state.mode === "empty") return Response.json({ ok: true, ...home.overview, tasks: [], items: [], deps: [] });
      return new Promise<Response>(() => {}); // 读取中：挂起不回
    }
    return fetch(new Request(inner + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() }));
  } });
  return { server, state };
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

const TITLE: Record<Mode, string> = { fail: "没取到，正在重试", empty: "这个项目还没有台账", loading: "正在读取台账…" };
const visible = (page: Page) => page.locator("body").innerText();

/** 改后：顶栏返回（aria-label「返回」）+ 项目名；点返回走 nav.toList，离开协作视图 */
async function checkBack(page: Page, name: string, narrow: boolean) {
  const back = page.locator(`button[aria-label="返回"]`); // 桌面 display:none，getByRole 看不到
  expect(await back.count()).toBe(1);
  expect(await page.locator("span", { hasText: name }).first().isVisible()).toBe(true);
  // 桌面的返回按钮和正常页一样不显示（v4.module.css .back），照样在 DOM 里；桌面直接派发点击
  if (narrow) await back.click(); else await back.dispatchEvent("click");
  await page.getByTestId(LEFT).waitFor();
  expect(await page.getByText(TITLE.fail).count()).toBe(0);
}

/** 改后的读失败：原文折叠时不可见、展开「详情」后可见；点一次「重试」只多一次台账请求 */
async function checkFail(page: Page, hits: () => number) {
  expect(await visible(page)).not.toContain(RAW);
  const before = hits();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  for (let i = 0; i < 100 && hits() === before; i++) await Bun.sleep(50);
  await page.getByText(TITLE.fail).waitFor();
  await Bun.sleep(300); // 有第二次也该到了
  expect(hits() - before).toBe(1);
  await page.locator("summary", { hasText: "详情" }).click();
  await page.waitForFunction(`document.body.innerText.includes(${JSON.stringify(RAW)})`);
}

test.skipIf(!out)("UXFIX1：读失败 / 空台账 / 读取中带顶栏能返回，原文收进详情，空状态不给命令；1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const fixture = serve(home, team, await bundle(repo, resolve(out, `bundle-${label}`)));
      const w = world(home, String(fixture.server.url).replace(/\/$/, ""));
      try {
        for (const width of [1280, 390]) {
          const narrow = width < 700;
          for (const mode of MODES) {
            w.state.mode = mode;
            const g = await guardedPage(browser, String(w.server.url), { width });
            await g.page.goto(`${w.server.url}?side=local&theme=light&project=${home.project}`);
            await g.page.getByText(TITLE[mode]).waitFor({ timeout: 15_000 });
            if (mode === "loading") await g.page.waitForTimeout(300); // 确认真挂着：标题不变
            await settle(g.page);
            const name = `${label}-${mode}-${width}x900`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            issues[name] = await shotIssues(g.page);
            if (after) {
              if (mode === "empty") {
                expect(await visible(g.page)).toContain("PM 派任务后，这里会列出每个任务和进度。");
                expect(await g.page.content()).not.toContain("bun src/manager.ts");
                expect(await g.page.locator("code").count()).toBe(0);
              }
              if (mode === "fail") {
                await checkFail(g.page, () => w.state.hits);
                await settle(g.page);
                await g.page.screenshot({ path: resolve(out, `${label}-fail-details-${width}x900.png`) });
                issues[`${name}-details`] = await shotIssues(g.page);
              }
              await checkBack(g.page, home.project, narrow);
            }
            requests[name] = { external: [...g.external], errors: [...g.errors] };
            await g.ctx.close();
          }
        }
      } finally { w.server.stop(true); fixture.server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 300_000);
