/**
 * NAVV2-SHELLA1 新版整页宿主的截图与布局断言（opt-in，截图不进 git）：
 *   NAV_V2_SHOTS_DIR=<目录> [NAV_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-nav-v2-browser.test.ts
 * 入口沿用 TODAY1 / NAVBAR1 的截图入口（today-shots.ts：真的 Sidebar + MessageList + CollabSwitch），接口是 nav-shots.ts 同一份夹具，/settings 答 navV2: true；
 * 改前（基线没有 navV2）就是 NAVBAR1 旧布局。浅 / 深 × 1280×800 / 390×844，真 Chromium 无头，非回环请求一律拦掉并断言为 0。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleToday, serveToday, tailwindCss } from "./helpers/today-shots";
import { NAV_NOW, navRoute, navWorld, TEAM_NAME } from "./helpers/nav-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.NAV_V2_SHOTS_DIR, baseRepo = process.env.NAV_BASE_REPO;
const FP = "local";

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(400); // 淡入 / 子页滑入（≤220ms）走完
}

const theme = (page: Page, t: "light" | "dark") => page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
const click = (page: Page, sel: string) => page.locator(sel).first().click();

/** 元素的盒子（浏览器里算，写成字符串免得根 tsconfig 要 dom 类型） */
const box = (page: Page, sel: string): Promise<{ top: number; bottom: number; left: number; right: number } | null> =>
  page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);

/** 1280：主区宿主盖在聊天上、侧栏会话列表常在；今天 → 项目，深色再拍一张今天 */
async function desktop(page: Page, after: boolean, shot: (v: string) => Promise<void>) {
  if (after) {
    await click(page, "[data-nav=rail] [data-nav-tab=today]");
    await page.locator("[data-v2-host=main] [data-v2-section=today] [data-now-wait]").first().waitFor();
    const host = await box(page, "[data-v2-host=main]"), aside = await box(page, "aside");
    expect(host && aside && host.left >= aside.right - 1).toBe(true); // 画在主区，不压侧栏
    expect(await page.locator("aside input[type=search]").isVisible()).toBe(true); // 会话列表没被撤
  } else {
    await click(page, "[data-nav=rail] [data-nav-tab=today]");
    await page.locator("[data-nav-pages=today] [data-now-blocks]").waitFor();
  }
  await shot("today-light");
  await theme(page, "dark");
  await shot("today-dark");
  await theme(page, "light");
  await click(page, "[data-nav=rail] [data-nav-tab=projects]");
  await page.locator(after ? "[data-v2-section=projects] [data-now-project]" : "[data-nav-pages=projects] [data-now-project]").first().waitFor();
  await shot("projects-light");
}

/** 390：aside 里的整页宿主 + 底部栏；今天（浅 / 深）、团队（深）、我的 → 设置（改前是「我的」页）、会话列表 */
async function phone(page: Page, after: boolean, shot: (v: string) => Promise<void>) {
  const pg = (id: string) => (after ? `[data-v2-section=${id}]` : `[data-nav-pages=${id}]`);
  await page.locator(`${pg("today")} [data-now-wait]`).first().waitFor();
  await shot("today-light");
  await theme(page, "dark");
  await shot("today-dark");
  await click(page, "[data-nav=phone] [data-nav-tab=team]");
  await page.locator(`${pg("team")} section[aria-label=团队项目] button`, { hasText: TEAM_NAME }).first().waitFor();
  await shot("team-dark");
  await theme(page, "light");
  await click(page, "[data-nav=phone] [data-nav-tab=me]");
  await page.locator(`${pg("me")} [data-me-entry=settings]`).waitFor();
  if (after) {
    await click(page, "[data-v2-section=me] [data-me-entry=settings]");
    await page.locator("[data-v2-section=settings] [data-nav-v2-toggle]:not([disabled])").waitFor();
    expect(await page.locator("[data-v2-section=settings] [data-v2-back]").isVisible()).toBe(true);
    const nav = await box(page, "[data-nav=phone]"), host = await box(page, "[data-v2-host=aside]");
    expect(host && nav && host.bottom <= nav.top + 1.5).toBe(true); // 宿主不压底部栏（底部栏上沿 1px 描边与宿主相接）
  }
  await shot("me-settings-light");
  if (after) {
    await page.keyboard.press("Escape"); // Esc = 返回
    await page.locator("[data-v2-current=me]").waitFor();
  }
  await click(page, "[data-nav=phone] [data-nav-tab=sessions]");
  if (after) await page.waitForFunction(`document.querySelector("[data-v2-host=aside]")?.hidden === true`);
  await shot("sessions-light");
}

test.skipIf(!out)("NAVV2-SHELLA1：新版整页宿主，浅 / 深 × 1280 / 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const world = navWorld();
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const server = serveToday(await bundleToday(repo, resolve(out, `v2-bundle-${label}`), FP), await tailwindCss(repo), FP,
        (path) => navRoute(path, world, { navV2: true }));
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(new Date(NAV_NOW));
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          await g.page.locator("[data-nav-tab=today]").first().waitFor({ timeout: 15_000 }).catch(async (e) => {
            throw new Error(`${label} ${width}: ${e}\nerrors: ${g.errors.join(" | ")}\nbody: ${(await g.page.locator("body").innerText()).slice(0, 400)}`);
          });
          await g.page.waitForFunction(`document.querySelectorAll("[data-now-wait]").length >= 1`);
          const later = g.page.getByRole("button", { name: "以后再说" });
          if (await later.isVisible().catch(() => false)) await later.click();
          const shot = async (view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 120); // 不带 hover 态
            const name = `${label}-${view}-${width}x${height}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };
          if (width >= 640) await desktop(g.page, after, shot);
          else await phone(g.page, after, shot);
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "v2-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "v2-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
