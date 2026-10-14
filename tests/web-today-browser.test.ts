/**
 * TODAY1「今天」页的截图与 DOM 断言（opt-in，截图不进 git）：
 *   TODAY_SHOTS_DIR=<目录> [TODAY_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-today-browser.test.ts
 * 入口与夹具在 tests/helpers/today-shots.ts（改前改后同一个入口、同一份数据）：真的 Sidebar + MessageList + CollabSwitch，外壳照生产 chat.tsx 的窄屏横滑。
 * 时刻钉在 2026-10-14 12:00 Asia/Shanghai（page.clock），真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0；全程不发 GET /quota。
 * 截图：1280 没选会话的主区（含侧栏条收起）、开着一个会话点「整页」后的主区（改前截同一会话的主区）；390 列表页侧栏条收起、展开。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleToday, serveToday, tailwindCss, TODAY_NOW } from "./helpers/today-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.TODAY_SHOTS_DIR, baseRepo = process.env.TODAY_BASE_REPO;
const FP = "local";

/** 侧栏里「同步开发」那个会话行（今天页 / 侧栏条里同名的行不算） */
const sessionRow = (page: Page) => page.locator("button:not([data-now] *)", { hasText: "同步开发" }).first();

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(400); // 侧栏条 / 块的高度过渡（.2s）、进度条宽度（.3s）走完
}

test.skipIf(!out)("TODAY1：今天页（桌面主区 / 整页 / 手机侧栏条收起与展开），1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[]; quota: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const server = serveToday(await bundleToday(repo, resolve(out, `today-bundle-${label}`), FP), await tailwindCss(repo), FP);
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(new Date(TODAY_NOW));
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          await g.page.locator("[data-now=strip]").waitFor({ timeout: 15_000 }).catch(async (e) => {
            throw new Error(`${label} ${width}: ${e}\nerrors: ${g.errors.join(" | ")}\nbody: ${(await g.page.locator("body").innerText()).slice(0, 400)}`);
          });
          await g.page.waitForFunction(`document.querySelectorAll("[data-now-wait]").length >= 3`);
          // 外壳自己的「打开协作邀请链接」浮条（改前就有、与本卡无关）会盖住主区底部：先点「以后再说」收掉
          const later = g.page.getByRole("button", { name: "以后再说" });
          if (await later.isVisible().catch(() => false)) await later.click();
          const shot = async (view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 5); // 截图不带行的 hover 态
            const name = `${label}-${view}-${width}x${height}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors], quota: g.calls.filter((c) => /^GET \/api\/v1\/quota\b/.test(c)) };
          };
          if (width >= 640) {
            if (after) {
              await g.page.waitForFunction(`document.querySelectorAll("[data-now=page] [data-now-stuck-row]").length === 3 && !!document.querySelector("[data-now=page] [data-now-quota]")`);
              const strip = (await g.page.locator("[data-now=strip] button[aria-expanded]").innerText()).replace(/\s+/g, " ").trim();
              expect(strip).toBe("今天 3 件要你处理 · 3 个 agent 在干活");
              expect((await g.page.locator("[data-now=page] h2").innerText()).trim()).toBe("今天");
            }
            await shot("home");
            // 开一个会话（侧栏行），再点侧栏条「整页」；改前没有这个按钮，截同一会话的主区
            await sessionRow(g.page).click();
            await g.page.waitForFunction(`!document.querySelector("main [data-now=page]")`);
            if (after) {
              await g.page.locator("[data-now=strip] [data-now-full]").click();
              await g.page.locator("main [data-now=page] [data-now-stuck-row]").first().waitFor();
            }
            await shot("full-page");
            if (after) {
              await sessionRow(g.page).click();
              await g.page.waitForFunction(`!document.querySelector("main [data-now=page]")`);
            }
          } else {
            await shot("list");
            await g.page.locator("[data-now=strip] button[aria-expanded]").click();
            await g.page.waitForFunction(`document.querySelector("[data-now=strip]").dataset.nowOpen === "1"`);
            if (after) await g.page.waitForFunction(`document.querySelectorAll("[data-now=strip] [data-now-stuck-row]").length === 3`);
            await shot("list-open");
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "today-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "today-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [], quota: [] });
    // 侧栏顶栏「会话」标题在 16rem 宽度下折行是改前就有的（UXHOME1 同一条豁免），别的照断
    const known = (i: ShotIssue) => i.kind === "squeeze" && i.detail === "会话 (2 lines)";
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list: list.filter((i) => !known(i)) }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
