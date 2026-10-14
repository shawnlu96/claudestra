/**
 * UXHOME1 协作视图页头与「规划与提案」标签的截图与 DOM 断言（opt-in，截图不进 git）：
 *   PAGE_HEAD_SHOTS_DIR=<仓库外目录> [PAGE_HEAD_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-collab-page-head-browser.test.ts
 * 打包 web/features/collab/shared/fixture-harness.tsx（?side=team / ?side=local），数据是 tests/helpers/collab-fixture-serve.ts 的同一份合成台账：
 * 团队那一份原样是「2 个 feature 过期」，再复制一份把观测时刻改成此刻 = 「全部新鲜」。真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 * 给了 PAGE_HEAD_BASE_REPO 就用同一份数据在基线上再拍一套 before-*（只截图，不断言新行为）。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome, type TeamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.PAGE_HEAD_SHOTS_DIR, baseRepo = process.env.PAGE_HEAD_BASE_REPO;

async function bundle(repo: string, dir: string) {
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/shared/fixture-harness.tsx", "--target", "browser", "--outdir", dir,
    "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return dir;
}

/** 同一份团队数据，各 feature 的执行进度观测时刻改成此刻（页面按真时钟判新鲜） */
function freshened(team: TeamFromHome): TeamFromHome {
  const t = structuredClone(team), now = Date.now();
  for (const f of [...t.list.features, ...t.details.map((d) => d.feature)]) if (f.projection) Object.assign(f.projection, { observedAt: now, receivedAt: now });
  return t;
}

const settle = async (page: Page) => {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(250); // 页头名单的高度过渡（.2s）走完
};
const head = (page: Page) => page.locator("[data-collab-head]");
const mirrorSec = (page: Page) => page.locator("section h5", { hasText: /^镜像$/ });

test.skipIf(!out)("UXHOME1：团队页头（新鲜 / 过期）、规划与提案标签、本机团队标签，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), stale = await teamFromHome(home), fresh = freshened(stale);
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const dist = await bundle(repo, resolve(out, `bundle-${label}`));
      for (const [state, team] of [["fresh", fresh], ["stale", stale]] as const) {
        const fixture = serve(home, team, dist);
        try {
          for (const width of [1280, 390]) {
            const narrow = width < 700;
            const open = async (side: "team" | "local") => {
              const g = await guardedPage(browser, String(fixture.server.url), { width });
              await g.page.setViewportSize({ width, height: narrow ? 844 : 800 });
              await g.page.goto(`${fixture.server.url}?side=${side}&theme=light&project=${home.project}&team=${home.team}`);
              await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
              return g;
            };
            const shot = async (g: Awaited<ReturnType<typeof open>>, view: string) => {
              await settle(g.page);
              const name = `${label}-${view}-${width}x${narrow ? 844 : 800}`;
              await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
              issues[name] = await shotIssues(g.page);
              requests[name] = { external: [...g.external], errors: [...g.errors] };
            };

            // 团队首页：页头一行；过期的点开名单
            const g = await open("team");
            if (after) {
              await head(g.page).first().waitFor();
              const text = (await head(g.page).first().innerText()).trim();
              if (state === "fresh") expect({ width, text }).toEqual({ width, text: expect.stringMatching(/^团队版 · \d+ 分钟前同步$/) as unknown as string });
              else {
                expect({ width, text }).toEqual({ width, text: "团队版 · 2 个模块的进度可能不是最新的" });
                await head(g.page).first().click();
                const names = (await g.page.locator("[data-collab-head-stale] li").allInnerTexts()).map((x) => x.trim());
                expect(names).toEqual(stale.list.features.map((f) => f.title));
                expect(await head(g.page).first().getAttribute("aria-expanded")).toBe("true");
              }
              expect(await mirrorSec(g.page).count()).toBe(0);
              expect(await g.page.locator("body").innerText()).not.toMatch(/主场镜像/);
            }
            if (state === "fresh" || !narrow) await shot(g, `team-${state}`);
            await g.ctx.close();
            if (state === "stale") continue;

            // 团队「规划与提案」标签（改前叫「团队」）与本机「团队」标签
            for (const side of ["team", "local"] as const) {
              if (narrow) continue;
              const t = await open(side);
              const name = side === "team" && after ? "规划与提案" : "团队";
              await t.page.getByRole("tab", { name, exact: true }).click();
              if (after && side === "team") {
                expect(await t.page.getByRole("tab", { name: "团队", exact: true }).count()).toBe(0);
                await t.page.getByText("团队规划", { exact: true }).first().waitFor();
              }
              if (after && side === "local") {
                expect(await head(t.page).count()).toBe(0);
                expect(await t.page.getByText("规划与提案").count()).toBe(0);
              }
              await shot(t, side === "team" ? "team-plan" : "local-team");
              await t.ctx.close();
            }
            // 手机：团队源的顶栏按钮与整屏页标题；本机仍叫团队、副标题不变
            if (narrow && after) {
              const t = await open("team");
              await t.page.getByRole("button", { name: "规划与提案", exact: true }).click();
              await t.page.getByText("团队规划与成员提案", { exact: true }).waitFor();
              await t.ctx.close();
              const l = await open("local");
              await l.page.getByRole("button", { name: "团队", exact: true }).click();
              await l.page.getByText("最近 10 分钟的真实往来", { exact: true }).waitFor();
              await l.ctx.close();
            }
          }
        } finally { fixture.server.stop(true); }
      }
    }
    await Bun.write(resolve(out, "page-head-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "page-head-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
