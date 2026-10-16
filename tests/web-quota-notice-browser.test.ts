/**
 * QUOTA1 截图与 DOM 断言（opt-in，截图不进 git）：
 *   QUOTA_SHOTS_DIR=<目录> [QUOTA_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-quota-notice-browser.test.ts
 * 入口与数据在 tests/helpers/quota-shots.ts（今天页用 TODAY1 的 today-shots 入口）；改前 / 改后同一份数据、关闭记录初态都是空的。
 * 时刻钉在 2026-10-14 12:00 Asia/Shanghai（page.clock），真 Chromium，回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 * 截图（1280×800 与 390×844，浅色）：状态 1、2 的顶部通知；状态 2 的今天页「团队与额度」块；状态 2 的低优先级徽章 + 用量看板顶部（同一页）。
 * 改后断言：顶部插槽最多一张额度卡、没有旧横幅 DOM；今天页额度行的说法；全程今天页不发 GET /quota；页面文字不含禁用词与 low-priority；shotIssues 为空。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BANNED_OWNER_WORDS } from "../web/lib/owner-words";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleQuota, QUOTA_NOW, quotaRoute, type QuotaState } from "./helpers/quota-shots";
import { bundleToday, serveToday, tailwindCss } from "./helpers/today-shots";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.QUOTA_SHOTS_DIR, baseRepo = process.env.QUOTA_BASE_REPO;
const FP = "local";

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await page.waitForTimeout(500); // 卡片进场（高度 + 透明度 .2s）走完
}

test.skipIf(!out)("QUOTA1：顶部通知（状态 1 / 2）、今天页团队与额度、低优先级徽章 + 用量看板顶部，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before" as const, repo: resolve(baseRepo) }] : []), { label: "after" as const, repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {}, texts: Record<string, string> = {};
  let state: QuotaState = "s1";
  const extra = (path: string) => quotaRoute(state)(path);
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const tw = await tailwindCss(repo);
      const quota = serveToday(await bundleQuota(repo, resolve(out, `quota-bundle-${label}`), FP), tw, FP, extra);
      const today = serveToday(await bundleToday(repo, resolve(out, `today-bundle-${label}`), FP), tw, FP, extra);
      try {
        for (const width of [1280, 390]) {
          const height = width < 640 ? 844 : 800, size = `${width}x${height}`;
          const open = async (url: string) => {
            const g = await guardedPage(browser, url, { width });
            await g.page.clock.setFixedTime(new Date(QUOTA_NOW));
            await g.page.setViewportSize({ width, height });
            await g.page.goto(url);
            return g;
          };
          const shot = async (g: Awaited<ReturnType<typeof open>>, view: string) => {
            await settle(g.page);
            await g.page.mouse.move(width - 5, height - 5);
            const name = `${label}-${view}-${size}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
            texts[name] = await g.page.evaluate<string>("document.body.innerText");
            if (after) {
              expect({ name, banned: BANNED_OWNER_WORDS.filter((w) => texts[name]!.includes(w)) }).toEqual({ name, banned: [] });
              expect({ name, lp: /low-priority/.test(texts[name]!) }).toEqual({ name, lp: false });
            }
          };

          for (const s of ["s1", "s2"] as const) {
            state = s;
            const g = await open(String(quota.url));
            await g.page.locator(after ? "[data-quota-notice-row]" : "[role=status]").first().waitFor({ timeout: 15_000 });
            if (after) {
              await g.page.waitForFunction(`document.querySelectorAll("[data-quota-notice-row]").length === ${s === "s1" ? 1 : 2}`);
              expect(await g.page.locator("[data-quota-notice]").count()).toBe(1);
              expect(await g.page.locator('[data-testid="quota-warning"], [data-quota-warning]').count()).toBe(0);
            }
            await shot(g, `notice-${s}`);
            await g.ctx.close();
          }

          state = "s2";
          const t = await open(String(today.url));
          const scope = width >= 640 ? "[data-now=page]" : "[data-now=strip]";
          if (width < 640) {
            await t.page.locator("[data-now=strip]").waitFor({ timeout: 15_000 });
            if ((await t.page.locator("[data-now=strip]").getAttribute("data-now-open")) !== "1") await t.page.locator("[data-now=strip] button[aria-expanded]").first().click();
          }
          await t.page.locator(`${scope} [data-now-team]`).waitFor({ timeout: 15_000 });
          await t.page.locator(`${scope} [data-now-quota]`).waitFor({ timeout: 15_000 });
          const later = t.page.getByRole("button", { name: "以后再说" });
          if (await later.isVisible().catch(() => false)) await later.click();
          await t.page.locator(`${scope} [data-now-team]`).scrollIntoViewIfNeeded();
          if (after) {
            const lineText = (await t.page.locator(`${scope} [data-now-quota]`).innerText()).replace(/\s+/g, " ").trim();
            expect(lineText).toBe("Claude 本周已用 100% 用完 · 10/14 15:00 重置 · Codex 本周已用 95% 不再接新活");
            expect(await t.page.locator(`${scope} [data-now-usage]`).count()).toBe(1);
          }
          await shot(t, "today-team");
          expect({ size, label, quota: t.calls.filter((c) => /^GET \/api\/v1\/quota$/.test(c)) }).toEqual({ size, label, quota: [] }); // 今天页不发 GET /quota
          await t.ctx.close();

          const l = await open(`${quota.url}?view=links`);
          await l.page.locator("[data-lp-row]").nth(2).waitFor();
          await l.page.locator("[data-usage-top] .rounded-xl").first().waitFor();
          if (after) await l.page.locator("[data-usage-top] [data-quota-summary]").waitFor();
          await shot(l, "links");
          await l.ctx.close();
        }
      } finally { quota.stop(true); today.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, "inner-text.json"), JSON.stringify(texts, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
