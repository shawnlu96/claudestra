/**
 * NAVBAR1 五个入口的截图与 DOM 断言（opt-in，截图不进 git）：
 *   NAV_SHOTS_DIR=<目录> [NAV_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-phone-nav-browser.test.ts
 * 入口与外壳沿用 TODAY1 的截图入口（today-shots.ts bundleToday：真的 Sidebar + MessageList + CollabSwitch，窄屏照生产横滑），
 * 接口换成 nav-shots.ts（规格「对照基准」）；时刻钉在 2026-10-14 12:00，真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 * 390：冷开、「项目」「团队」「我的」（改前没有这些入口，截同一列表页）；1280：侧栏顶栏、「我的」菜单展开、「团队」页（改前截原顶栏与列表）。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleToday, serveToday, tailwindCss } from "./helpers/today-shots";
import { NAV_NOW, navRoute, navWorld, TEAM_NAME } from "./helpers/nav-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.NAV_SHOTS_DIR, baseRepo = process.env.NAV_BASE_REPO;
const FP = "local";
/** 五格的字（角标在名字前：「今天」2 件要你处理，「会话」未读 3 + 1） */
const TABS = ["2 今天", "项目", "4 会话", "团队", "我的"];
/** 全权设备 + shells 200 时「我的」的全部条目（原顶栏 8 个无字图标） */
const ME = ["设置", "全部已读", "项目管理", "多选管理", "伙伴机器", "用量看板", "新终端", "图片与文件"];

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(400); // 淡入（150ms）、指示条（200ms）、侧栏条高度过渡走完
}

/** 浏览器里取字：写成字符串，避免 tests/ 的 tsconfig 去要 dom 类型（同 ui-shot-checks.ts） */
const texts = (page: Page, sel: string): Promise<string[]> =>
  page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`);

/** 390「会话」：列表滚到底，最后一行的中心点要点得到它自己（没被底部栏盖住） */
async function lastRowReachable(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const list = [...document.querySelectorAll("aside .overflow-y-auto")].find((el) => el.querySelector("[data-agent], li"));
    if (!list) return false;
    list.scrollTop = list.scrollHeight;
    const rows = [...list.querySelectorAll("button")].filter((b) => b.offsetParent);
    const last = rows.at(-1);
    if (!last) return false;
    const r = last.getBoundingClientRect(), nav = document.querySelector("[data-nav=phone]").getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.bottom <= nav.top + 0.5 && !!hit && last.contains(hit);
  })()`);
}

async function phone(page: Page, after: boolean, shot: (v: string) => Promise<void>) {
  if (after) {
    await page.locator("[data-nav-pages=today] [data-now-wait]").first().waitFor();
    expect(await texts(page, "[data-nav=phone] [data-nav-tab]")).toEqual(TABS);
  }
  await shot("cold");
  for (const view of ["projects", "team", "me"] as const) {
    if (after) {
      await page.locator(`[data-nav=phone] [data-nav-tab=${view}]`).click();
      await page.locator(`[data-nav-pages=${view}]`).waitFor();
      if (view === "projects") await page.locator("[data-nav-pages=projects] [data-now-project]").first().waitFor();
      if (view === "team") await page.locator("[data-nav-pages=team] section[aria-label=团队项目] button", { hasText: TEAM_NAME }).waitFor();
      if (view === "me") {
        expect(await texts(page, "[data-nav-pages=me] [data-me-entry]")).toEqual(ME.map((s) => (s === "伙伴机器" ? `${s} 1/2 在线` : s)));
        expect(await page.locator("[data-me-version]").innerText()).toContain("Floka Web");
      }
    }
    await shot(view);
  }
  if (after) {
    await page.locator("[data-nav=phone] [data-nav-tab=sessions]").click();
    await page.waitForFunction(`!document.querySelector("[data-nav-pages]")`);
    expect(await lastRowReachable(page)).toBe(true);
  }
}

async function desktop(page: Page, after: boolean, shot: (v: string) => Promise<void>) {
  if (after) {
    expect(await texts(page, "[data-nav=rail] [data-nav-tab]")).toEqual(TABS);
    // 顶栏（标题那一行）里看得见的按钮都有字（手机图例 ⓘ 在桌面 hidden，不算）
    const bare = await page.evaluate(`[...document.querySelectorAll("aside > div:nth-of-type(2) button")]
      .filter((e) => e.offsetParent && !e.innerText.trim()).map((e) => e.outerHTML.slice(0, 160))`);
    expect(bare).toEqual([]);
  }
  await shot("topbar");
  if (after) {
    await page.locator("[data-nav=rail] [data-nav-tab=me]").click();
    await page.locator("[role=menu] [data-me-entry]").first().waitFor();
    expect(await page.locator("[role=menu] [data-me-entry]").count()).toBe(8);
  }
  await shot("me-menu");
  if (after) {
    await page.keyboard.press("Escape");
    await page.mouse.click(900, 400); // 点遮罩收菜单
    await page.locator("[data-nav=rail] [data-nav-tab=team]").click();
    await page.locator("[data-nav-pages=team] section[aria-label=团队项目] button", { hasText: TEAM_NAME }).waitFor();
  }
  await shot("team");
}

test.skipIf(!out)("NAVBAR1：五个入口（手机底部栏 / 电脑图标栏 / 我的 / 团队），1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const world = navWorld();
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const server = serveToday(await bundleToday(repo, resolve(out, `nav-bundle-${label}`), FP), await tailwindCss(repo), FP, (path) => navRoute(path, world));
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(new Date(NAV_NOW));
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          await g.page.locator("[data-now=strip]").waitFor({ timeout: 15_000 }).catch(async (e) => {
            throw new Error(`${label} ${width}: ${e}\nerrors: ${g.errors.join(" | ")}\nbody: ${(await g.page.locator("body").innerText()).slice(0, 400)}`);
          });
          await g.page.waitForFunction(`document.querySelectorAll("[data-now-wait]").length >= 2`);
          const later = g.page.getByRole("button", { name: "以后再说" });
          if (await later.isVisible().catch(() => false)) await later.click();
          const shot = async (view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, 5); // 截图不带行的 hover 态（右上角在主区，不在菜单 / 底部栏上）
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
    await Bun.write(resolve(out, "nav-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "nav-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    // 「我的」菜单沿用侧栏行菜单的外壳（menu-shell.tsx，底色 97% 不透明），检查脚本把菜单下面的列表字也算可见：菜单里的字与底下的重叠不算
    const menu = new Set([...ME, "1/2 在线", "我的"].map((s) => JSON.stringify(s)));
    const known = (name: string, i: ShotIssue) => name.includes("-me-menu-") && i.kind === "overlap" && i.detail.split(" × ").some((x) => menu.has(x));
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list: list.filter((i) => !known(name, i)) }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
