/**
 * team-project-UXPROB1 截图与 DOM 断言（opt-in，截图不进 git）：
 *   COLLAB_ATTENTION_SHOTS_DIR=<仓库外目录> [COLLAB_ATTENTION_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-collab-attention-browser.test.ts
 * 打包 web/features/collab/shared/fixture-harness.tsx（side=local），数据照规格「对照基准」：在途卡里 2 张出问题（一张审查不过、一张 CI 失败）、
 * 3 张卡住（停了 40 分钟 / 1 小时 / 3 小时）、1 张在等你（夹具的 ask-a7）。
 * 桌面 1280：概览「其中 2 条出问题 / 3 条卡住」的数能点（Tab 聚焦、回车打开），出问题页两行带原因，点一行进任务详情、关掉回概览；卡住页三行按停留时长倒序；
 * 数据刷新后出问题清零，页面写「现在没有」不报错。手机 390 只拍首页（概览在手机上看不到，证明没有回退）。
 * 给了 COLLAB_ATTENTION_BASE_REPO 就用同一份数据再拍一套「改前」（只截图、只断言数点不动）。回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { LedgerTaskView, Stage } from "@/features/collab/collab-model";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.COLLAB_ATTENTION_SHOTS_DIR, baseRepo = process.env.COLLAB_ATTENTION_BASE_REPO;
const MIN = 60_000;
const REASON = { review: "审查不过：P0 接口没鉴权", ci: "CI 失败：web typecheck 报错" };

/** 夹具的在途卡改成对照基准：A5 / B3 返工（出问题），A4 / B2 / A3 在等且分别停了 40 分钟 / 1 小时 / 3 小时（卡住），B4 刚进复述不算卡住 */
function shape(home: HomeFixture, cleared = false) {
  const set = (id: string, stage: Stage, sinceMin: number, review?: string) => {
    const t = home.overview.tasks.find((x) => x.id === id)!;
    const patch: Partial<LedgerTaskView> = { stage, stageSince: home.now - sinceMin * MIN, stageSinceApprox: false };
    if (review) patch.lastReview = { round: t.round, verdict: "block", p0: 1, p1: 0, p2: 0, text: review, ts: home.now - sinceMin * MIN };
    Object.assign(t, patch);
    if (home.details[id]) Object.assign(home.details[id]!.task, patch);
  };
  set("i28-A5", cleared ? "build" : "fix", 20, REASON.review);
  set("i28-B3", cleared ? "build" : "fix", 50, REASON.ci);
  set("i28-A4", "review", 40);
  set("i28-B2", "review", 60);
  set("i28-A3", "merge", 180);
  set("i28-B4", "restate", 10);
}

async function bundle(repo: string, dir: string) {
  const build = Bun.spawn([process.execPath, "build", resolve(repo, "web/features/collab/shared/fixture-harness.tsx"), "--target", "browser",
    "--outdir", dir, "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return dir;
}

/**
 * 夹具服务器前面套一层：/api/v1/events 给一条一直开着的流（push() 发一条本项目的 ledger 事件 = 生产里台账变了，页面去抖后重拉总览），
 * 其余原样转给它
 */
function world(home: HomeFixture, inner: string) {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/events") {
      let mine: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.add((mine = c)), cancel: () => void streams.delete(mine) });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return fetch(new Request(inner + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() }));
  } });
  const push = () => {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type: "ledger", data: { project: home.project } })}\n\n`);
    for (const c of streams) try { c.enqueue(frame); } catch { streams.delete(c); }
  };
  return { server, push, stop: () => { for (const c of streams) try { c.close(); } catch { /* 已断开 */ } server.stop(true); } };
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}
const rows = (page: Page) => page.locator("[data-attention-row]");

test.skipIf(!out)("UXPROB1：概览「出问题 / 卡住」的数能点开，列出任务与原因；1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), team = await teamFromHome(home); // 团队投影只给夹具服务器的团队接口用，本页走 side=local
  shape(home);
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      shape(home);
      const fixture = serve(home, team, await bundle(repo, resolve(out, `bundle-${label}`)));
      const w = world(home, String(fixture.server.url).replace(/\/$/, ""));
      try {
        for (const width of [1280, 390]) {
          const g = await guardedPage(browser, String(w.server.url), { width });
          await g.page.goto(`${w.server.url}?side=local&theme=light&project=${home.project}`);
          await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
          const shot = async (view: string) => {
            await settle(g.page);
            const name = `${label}-${view}-${width}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };
          if (width < 700) { // 手机：概览不在这里（D6），只拍首页
            await shot("home");
            await g.ctx.close();
            continue;
          }
          const now = g.page.locator("[data-now]");
          await now.getByText("其中 2 条出问题").waitFor();
          await now.getByText("3 条卡住").waitFor();
          await shot("home");
          if (!after) { // 改前：数是纯文字，点不动（点了右栏仍是概览，拍下来和改后的两页成对）
            expect(await now.locator("button").count()).toBe(0);
            for (const [view, text] of [["problem", "其中 2 条出问题"], ["stuck", "3 条卡住"]] as const) {
              await now.getByText(text).click();
              await g.page.getByText("项目概览", { exact: true }).waitFor();
              await shot(view);
            }
            await g.ctx.close();
            continue;
          }
          const problem = g.page.getByRole("button", { name: "查看出问题的 2 个任务", exact: true });
          const stuck = g.page.getByRole("button", { name: "查看卡住的 3 个任务", exact: true });
          expect([await problem.innerText(), await stuck.innerText()]).toEqual(["2", "3"]);
          // 键盘：Tab 走到「2」上，回车打开出问题页
          await g.page.locator("body").click({ position: { x: 1, y: 1 } });
          let focused = false;
          for (let i = 0; i < 300 && !focused; i++) {
            await g.page.keyboard.press("Tab");
            focused = await g.page.evaluate(`document.activeElement?.getAttribute("data-attention") === "problem"`);
          }
          expect(focused).toBe(true);
          await g.page.keyboard.press("Enter");
          await g.page.getByText("点一个任务看详情").waitFor();
          expect(await rows(g.page).count()).toBe(2);
          for (const r of Object.values(REASON)) await rows(g.page).getByText(r, { exact: false }).waitFor();
          await shot("problem");
          // 点一行：进任务详情；关掉回概览
          await rows(g.page).getByRole("button", { name: /^i28-A5/ }).click();
          await g.page.getByText("点一个任务看详情").waitFor({ state: "detached" });
          const a5 = home.overview.tasks.find((t) => t.id === "i28-A5")!.title;
          await g.page.locator("aside").getByText(a5, { exact: false }).first().waitFor();
          await g.page.locator("aside").getByRole("button", { name: "关闭", exact: true }).last().click();
          await g.page.getByText("项目概览", { exact: true }).waitFor();
          // 卡住：三行，停得久的在前
          await stuck.click();
          await g.page.getByText("点一个任务看详情").waitFor();
          expect(await rows(g.page).evaluateAll((els) => els.map((e) => e.getAttribute("data-attention-row")))).toEqual(["i28-A3", "i28-B2", "i28-A4"]);
          await shot("stuck");
          // 数据刷新：出问题清零，页面写「现在没有」，不报错、不关页
          await g.page.getByRole("button", { name: "关闭", exact: true }).last().click();
          await problem.click();
          await rows(g.page).first().waitFor();
          shape(home, true);
          w.push();
          await g.page.getByText("现在没有", { exact: true }).waitFor();
          await g.page.getByText("点一个任务看详情").waitFor();
          expect(await rows(g.page).count()).toBe(0);
          requests[`${label}-cleared-${width}`] = { external: [...g.external], errors: [...g.errors] };
          shape(home);
          await g.ctx.close();
        }
      } finally { w.stop(); fixture.server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
