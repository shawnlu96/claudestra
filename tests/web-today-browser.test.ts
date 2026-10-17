/**
 * TODAY1「今天」页的截图与 DOM 断言（opt-in，截图不进 git）：
 *   TODAY_SHOTS_DIR=<目录> [TODAY_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-today-browser.test.ts
 *   加 TODAY_SIDEBAR_CHECK=1 跑 TODAY2：1440×900 真 Gate 下整页、Esc / 返回、点另一会话；390 列表收起 / 展开。
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

/** TODAY2: 同一份生产 Gate + Sidebar 外壳，基线只记录不可点击的 B，交付版真实点击 B。 */
async function sidebarShots(dir: string, base?: string) {
  mkdirSync(dir, { recursive: true });
  const sides = [...(base ? [{ phase: "before", repo: resolve(base) }] : []), { phase: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: { view: string; size: string; phase: string; file: string }[] = [];
  try {
    for (const { phase, repo } of sides) {
      const server = serveToday(await bundleToday(repo, resolve(dir, `sidebar-bundle-${phase}`), FP), await tailwindCss(repo), FP);
      try {
        for (const width of [1440, 390]) {
          const height = width === 1440 ? 900 : 844, size = `${width}x${height}`;
          const g = await guardedPage(browser, String(server.url), { width });
          try {
            const page = g.page;
            await page.clock.setFixedTime(new Date(TODAY_NOW));
            await page.setViewportSize({ width, height });
            await page.goto(String(server.url));
            await page.locator("[data-now=strip]").waitFor();
            const later = page.getByRole("button", { name: "以后再说" });
            if (await later.isVisible()) await later.click();
            const shot = async (view: string) => {
              await settle(page);
              if (await later.isVisible()) await later.click();
              await page.mouse.move(width - 5, height - 5);
              const file = `${phase}-${view}-${size}.png`;
              await page.screenshot({ path: resolve(dir, file), animations: "disabled" });
              shots.push({ view, size, phase, file });
            };
            if (width === 390) {
              await page.locator("[data-nav-pages=today] [data-now=page]").waitFor();
              await shot("today");
              await page.locator("[data-nav=phone] [data-nav-tab=sessions]").click();
              expect(await page.locator("[data-now-full]").isVisible()).toBe(false);
              await shot("list");
              await page.locator("[data-now=strip] button[aria-expanded]").first().click();
              await page.waitForFunction(`document.querySelectorAll("[data-now=strip] [data-now-stuck-row]").length === 3`);
              await shot("list-open");
            } else {
              const a = sessionRow(page), b = page.locator("aside button", { hasText: "通知开发" }).first();
              await a.click();
              await page.waitForFunction(`!document.querySelector("main [data-now=page]")`);
              const sameSidebar = await page.locator("aside").elementHandle();
              const open = async () => {
                await page.locator("[data-now-full]").click();
                await page.locator("main [data-now-back]").waitFor();
                await page.waitForFunction(`document.querySelectorAll("main [data-now-stuck-row]").length === 3`);
              };
              const selected = (name: string) => page.waitForFunction(`Array.from(document.querySelectorAll("aside button"))
                .some(el => el.textContent.includes(${JSON.stringify(name)}) && el.parentElement.classList.contains("bg-base-300"))`);
              await selected("同步开发");
              await open();
              await shot("full-page");
              const visible = await b.isVisible();
              expect({ phase, visible }).toEqual({ phase, visible: phase === "after" });
              if (phase === "after") {
                await b.click({ trial: true });
                const main = await page.locator("main").boundingBox(), overlay = await page.locator("main [data-now=page]").boundingBox();
                expect(main!.x).toBeGreaterThan(0);
                expect(overlay!.x).toBe(main!.x);
                expect(await sameSidebar!.evaluate((el: unknown) => (el as { isConnected: boolean }).isConnected)).toBe(true);
              }
              // Esc / 返回不换会话；之后重新打开整页，点 B 复现验收线 1。
              for (const close of [() => page.keyboard.press("Escape"), () => page.locator("main [data-now-back]").click()]) {
                await close();
                await page.waitForFunction(`!document.querySelector("main [data-now=page]")`);
                await selected("同步开发");
                await open();
              }
              if (visible) {
                await b.click();
                await page.waitForFunction(`!document.querySelector("main [data-now=page]")`);
                await selected("通知开发");
              }
              await shot("select-session");
            }
            expect({ external: g.external, errors: g.errors }).toEqual({ external: [], errors: [] });
          } finally { await g.ctx.close(); }
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(dir, "manifest.json"), JSON.stringify({ v: 1, summary: "桌面今天整页保留会话栏并支持切会话；手机列表保持一致", shots }, null, 2));
  } finally { await browser.close(); }
}

test.skipIf(!out)("TODAY：今天页与会话栏，桌面整页 / 手机列表改前改后", async () => {
  if (!out) return;
  if (process.env.TODAY_SIDEBAR_CHECK === "1") return sidebarShots(out, baseRepo);
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
              const strip = (await g.page.locator("[data-now=strip] button[aria-expanded]").first().innerText()).replace(/\s+/g, " ").trim();
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
            await g.page.locator("[data-now=strip] button[aria-expanded]").first().click();
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
