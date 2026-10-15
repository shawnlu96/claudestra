/**
 * ONB-3 网页「接入编排」截图与 DOM 断言（opt-in，截图不进 git）：
 *   ONBOARD_SHOTS_DIR=<目录> [ONBOARD_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/team-onboard-browser.test.ts
 * 入口 / 样式 / 夹具复用 TODAY1 的（tests/helpers/today-shots.ts：真 Sidebar），这里只加 /host、/peers/contacts、/projects/:id/pm|onboard；
 * onboard 的清单由真的 planOnboard 按请求参数算（文案与后端一字不差）。真 Chromium，回环 Bun.serve，非回环请求拦掉并断言为 0。
 * 视图：menu = 右键「合成项目 A」的项目菜单；panel = 改后点「接入编排」、填检查命令后的弹窗，改前没有这一项，截同一菜单作对照。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { planOnboard, type OnboardFacts } from "../src/manager/team-onboard";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleToday, serveToday, tailwindCss, TODAY_NOW } from "./helpers/today-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.ONBOARD_SHOTS_DIR, baseRepo = process.env.ONBOARD_BASE_REPO;
const FP = "local";
const PROJECT = "合成项目 A";
const FACTS: OnboardFacts = {
  project: "proj-a", dir: "/repos/proj-a", git: "no-origin", actor: "owner", scheduler: { segment: null },
  meta: { pms: ["agent-a-pm"], team: null }, agents: { "agent-a-pm": { status: "active" } }, pendingProposal: null,
};

/** 本卡的接口；POST onboard 记下请求体，真提交把 todo 标成 done */
function routes(posts: Record<string, unknown>[]) {
  return async (path: string, req: Request): Promise<Response | null> => {
    if (path === "/host") return Response.json({ local: true, platform: "darwin", openers: [{ id: "finder", label: "Finder", kind: "files" }] });
    if (path === "/peers/contacts") return Response.json({ contacts: [] });
    if (path === "/projects/proj-a/pm") return Response.json({ active: "agent-a-pm", candidates: [{ name: "agent-a-pm", runtime: "claude", online: true, registered: true }] });
    if (path !== "/projects/proj-a/onboard" || req.method !== "POST") return null;
    const b = (await req.json()) as { dryRun: boolean; localMerge?: boolean; checks?: string; maxWorkers?: number };
    posts.push(b);
    const plan = planOnboard(FACTS, { localMerge: !!b.localMerge, ...(b.checks ? { checks: b.checks.split(",").map((s) => s.trim()) } : {}),
      ...(b.maxWorkers !== undefined ? { maxWorkers: b.maxWorkers } : {}) });
    const blocked = plan.items.filter((x) => x.status === "blocked");
    const items = b.dryRun || blocked.length ? plan.items : plan.items.map((x) => (x.status === "todo" ? { ...x, status: "done" } : x));
    return Response.json({ ok: !blocked.length, project: "proj-a", dryRun: b.dryRun, git: FACTS.git, items,
      ...(blocked.length ? { error: blocked.map((x) => x.text).join("；") } : {}) });
  };
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(400);
}

const statuses = (page: Page) => page.evaluate<string[]>(`[...document.querySelectorAll("[data-onboard-item]")].map((e) => e.dataset.onboardItem + ":" + e.dataset.status)`);

test.skipIf(!out)("ONB-3：项目菜单「接入编排」与接入弹窗，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, leaks: Record<string, string[]> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const posts: Record<string, unknown>[] = [];
      const server = serveToday(await bundleToday(repo, resolve(out, `onboard-bundle-${label}`), FP), await tailwindCss(repo), FP, routes(posts));
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          posts.splice(0); // 每个宽度单独数真提交
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(new Date(TODAY_NOW));
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          const later = g.page.getByRole("button", { name: "以后再说" });
          // 侧栏项目组头：li 的直接子按钮、名字在 .truncate 里、看得见（今天页 / 侧栏条里同名的行不算）
          const mark = `[...document.querySelectorAll("li > button")].find((b) => b.offsetParent && b.querySelector(":scope > span.truncate")?.textContent === ${JSON.stringify(PROJECT)})?.setAttribute("data-onb-head", "")`;
          await g.page.waitForFunction(`(${mark}, !!document.querySelector("[data-onb-head]"))`, undefined, { timeout: 15_000 });
          const head = g.page.locator("[data-onb-head]");
          if (await later.isVisible().catch(() => false)) await later.click();
          const shot = async (view: string) => {
            await settle(g.page);
            const name = `${label}-${view}-${width}x${height}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            leaks[name] = [...g.external, ...g.errors];
          };
          // 组头的手势要等 /host、/peers/contacts 回包才挂上（project-group.tsx）：右键到菜单出来为止
          const pmItem = g.page.getByText("主管 PM", { exact: false }).first();
          // 「主管 PM」「接入编排」只在 contacts 判出全权后出现：等两条请求都发出、回包落定再右键
          for (let i = 0; i < 100 && !["/peers/contacts", "/host"].every((x) => g.calls.some((c) => c.includes(x))); i++) await g.page.waitForTimeout(100);
          await g.page.waitForTimeout(800);
          // 右键第二次会把已开的菜单关掉：每次右键后等足 3 秒再决定要不要重试（负载高时渲染慢）
          for (let i = 0; i < 6 && !(await pmItem.isVisible()); i++) {
            const box = (await head.boundingBox())!;
            await g.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
            await pmItem.waitFor({ timeout: 3000 }).catch(() => { /* 手势还没挂上：下一轮再右键 */ });
          }
          await pmItem.waitFor();
          await shot("menu");
          const entry = g.page.getByText("接入编排", { exact: true });
          if (!after) {
            expect(await entry.count()).toBe(0);
            await shot("panel");
          } else {
            await entry.click();
            // 首轮读到「没有 origin」→ 自动勾上本地合并 → 再核：缺检查命令，调度配置拦住
            await g.page.waitForFunction(`[...document.querySelectorAll("[data-onboard-item=scheduler]")].some((e) => e.dataset.status === "blocked")`);
            expect(await g.page.locator('input[type="checkbox"]').isChecked()).toBe(true);
            await g.page.getByPlaceholder("cargo test, cargo clippy").fill("cargo test, cargo clippy");
            await g.page.waitForFunction(`[...document.querySelectorAll("[data-onboard-item=scheduler]")].some((e) => e.dataset.status === "todo")`);
            expect(await statuses(g.page)).toEqual(["project:ok", "git:ok", "scheduler:todo", "team:todo"]);
            const go = g.page.getByRole("button", { name: "接入", exact: true });
            expect(await go.isEnabled()).toBe(true);
            await shot("panel");
            await go.click();
            await g.page.getByText("已接入", { exact: false }).waitFor();
            expect(await statuses(g.page)).toEqual(["project:ok", "git:ok", "scheduler:done", "team:done"]);
            expect(posts.at(-1)).toEqual({ dryRun: false, localMerge: true, checks: "cargo test, cargo clippy", maxWorkers: 2 });
            expect(posts.filter((p) => p.dryRun === false)).toHaveLength(1);
          }
          await g.ctx.close();
        }
      } finally {
        server.stop(true);
      }
    }
  } finally {
    await browser.close();
  }
  for (const [name, list] of Object.entries(leaks)) expect([name, list]).toEqual([name, []]);
  // 项目菜单是浮层，盖住底下的会话行是设计如此（改前同样）：menu 视图只放过 overlap，其余检查照旧；弹窗视图全查
  for (const [name, list] of Object.entries(issues)) {
    if (name.startsWith("after")) expect([name, list.filter((x) => !(name.includes("-menu-") && x.kind === "overlap"))]).toEqual([name, []]);
  }
}, 300_000);
