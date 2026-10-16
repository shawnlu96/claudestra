/**
 * XMACH1 截图（opt-in，截图不进 git）：
 *   MACHINES_SHOTS_DIR=<目录> [MACHINES_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-now-machines-browser.test.ts
 * 入口与夹具同 TODAY1（tests/helpers/today-shots.ts，改前改后同一个入口、同一份数据），叠上 tests/helpers/machines-shots.ts 的联系人 / 借出 / 借入。
 * 时刻钉在 2026-10-14 12:00 Asia/Shanghai，真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 * 每个宽度四张：团队与额度块（借入收起）、团队与额度块（借入展开；改前同位置）、设置 · 伙伴机器页（改前 Peer 协作页）的出借块与借入块。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { machinesRoute, machinesWorld } from "./helpers/machines-shots";
import { bundleToday, serveToday, tailwindCss, TODAY_NOW } from "./helpers/today-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.MACHINES_SHOTS_DIR, baseRepo = process.env.MACHINES_BASE_REPO;
const FP = "local";

/** 元素滚进视口（不平滑：钉住的时钟下平滑滚动走不动）；tests 的 tsconfig 不带 dom 类型，参数只写用到的那一个方法 */
const scrollTo = (el: { scrollIntoView(o: object): void }, block: string) => el.scrollIntoView({ block, behavior: "instant" });

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(400); // 侧栏条 / 行的高度过渡（.2s）走完
}

test.skipIf(!out)("XMACH1：今天页团队与额度（借入收起 / 展开）与设置 · 伙伴机器页，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const world = machinesWorld(TODAY_NOW);
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const server = serveToday(await bundleToday(repo, resolve(out, `machines-bundle-${label}`), FP), await tailwindCss(repo), FP, (path) => machinesRoute(path, world));
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800;
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(new Date(TODAY_NOW));
          await g.page.setViewportSize({ width, height });
          await g.page.goto(String(server.url));
          await g.page.locator("[data-now=strip]").waitFor({ timeout: 15_000 });
          await g.page.waitForFunction(`document.querySelectorAll("[data-now-wait]").length >= 3`);
          const later = g.page.getByRole("button", { name: "以后再说" });
          if (await later.isVisible().catch(() => false)) await later.click();
          // 1280：没选会话的主区就是今天页面版；390：列表页展开侧栏条
          const scope = width >= 640 ? "main [data-now=page]" : "[data-now=strip]";
          if (width < 640) {
            await g.page.locator("[data-now=strip] button[aria-expanded]").first().click();
            await g.page.waitForFunction(`document.querySelector("[data-now=strip]").dataset.nowOpen === "1"`);
          }
          await g.page.locator(`${scope} [data-now-quota]`).waitFor();
          if (after) await g.page.locator(`${scope} [data-now-borrowed]`).waitFor();
          const team = g.page.locator(`${scope} section[data-now-team]`);
          const shot = async (view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 5); // 截图不带行的 hover 态
            const name = `${label}-${view}-${width}x${height}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };
          await settle(g.page); // 侧栏条展开的高度动效走完再滚，否则滚到半截
          await team.evaluate(scrollTo, "center");
          await shot("team");
          if (after) {
            await g.page.locator(`${scope} [data-now-borrowed] button[aria-expanded]`).click();
            await g.page.waitForFunction(`document.querySelectorAll(${JSON.stringify(`${scope} [data-remote-row]`)}).length === 3`);
            await settle(g.page);
            await g.page.locator(`${scope} [data-remote-row]`).last().evaluate(scrollTo, "end");
          }
          await shot("team-borrowed-open");
          // 设置：主区滚回顶再开（弹窗遮罩下的主区改前改后一致）；侧栏顶的伙伴入口（改前改后都是这颗按钮）直达 peers 页
          await g.page.evaluate(`document.querySelectorAll("main [data-now=page]").forEach((el) => { el.scrollTop = 0; });
            document.querySelector("[data-now=strip]")?.scrollIntoView({ block: "start", behavior: "instant" })`);
          await g.page.locator("button[aria-label^='Peer 协作']").first().click();
          await g.page.getByText("借别人的电脑跑我的活").waitFor();
          await g.page.getByText("把我的电脑借给别人").waitFor();
          // 出借、借入两块各一张：标题顶到弹窗内容区上沿，原来「借出中的单」「远端在跑」的位置在图里
          await g.page.getByText("把我的电脑借给别人").evaluate(scrollTo, "start");
          await shot("settings-lend");
          await g.page.getByText("借别人的电脑跑我的活").evaluate(scrollTo, "start");
          await shot("settings-borrow");
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "machines-shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "machines-requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    // 侧栏顶栏「会话」标题在 16rem 宽度下折行是改前就有的（UXHOME1 / TODAY1 同一条豁免）；
    // 改前同一张图里一字不差也有的（设置弹窗遮罩下主区的字与弹窗字相交：检查器不认半透明遮罩），不是本卡引入的。别的照断
    const known = (name: string, i: ShotIssue) => (i.kind === "squeeze" && i.detail === "会话 (2 lines)")
      || (issues[name.replace(/^after-/, "before-")] ?? []).some((b) => b.kind === i.kind && b.detail === i.detail);
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list: list.filter((i) => !known(name, i)) }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
