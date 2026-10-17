/** NAVBAR2: real Sidebar + portal invite toast, synthetic data and production Tailwind.
 * INVITE_NAV_SHOTS_DIR=ui-shots [INVITE_NAV_PHASE=before] bun test tests/web-invite-intake-navbar-browser.test.ts
 * Set INVITE_NAV_REPO to a baseline checkout; before deliberately fails the same mobile assertions after saving both views.
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { bundleToday, serveToday, tailwindCss } from "./helpers/today-shots";
import { NAV_NOW, navRoute, navWorld } from "./helpers/nav-shots";

const out = process.env.INVITE_NAV_SHOTS_DIR;
const phase = process.env.INVITE_NAV_PHASE ?? "after";
interface Layout {
  card: { x: number; y: number; width: number; height: number; bottom: number };
  navTop: number | null;
  reachable: string[];
  wrapperEvents: string;
  cardEvents: string;
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(`(() => {
    const card = [...document.querySelectorAll("button")].find(e => e.textContent === "允许").parentElement;
    const r = card.getBoundingClientRect();
    const nav = document.querySelector("[data-nav=phone]");
    const reachable = [...(nav?.querySelectorAll("[data-nav-tab]") ?? [])].filter(button => {
      const b = button.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return hit?.closest("button") === button;
    }).map(b => b.dataset.navTab);
    return { card: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom },
      navTop: nav?.getBoundingClientRect().top ?? null, reachable,
      wrapperEvents: getComputedStyle(card.parentElement).pointerEvents, cardEvents: getComputedStyle(card).pointerEvents };
  })()`);
}

test.skipIf(!out)("NAVBAR2: invite stays above all five phone buttons; desktop placement is unchanged", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const root = resolve(import.meta.dir, "..");
  const repo = resolve(process.env.INVITE_NAV_REPO ?? root);
  const bundle = resolve(root, ".playwright-mcp/navbar2", phase);
  const world = navWorld();
  const server = serveToday(await bundleToday(repo, bundle, "local"), await tailwindCss(repo), "local", p => navRoute(p, world));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const results: Record<string, Layout> = {};
  try {
    // Capture both sizes before assertions, so a baseline red still yields a complete pair of views.
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      const size = `${width}x${height}`;
      const g = await guardedPage(browser, String(server.url), { width });
      try {
        await g.page.clock.setFixedTime(new Date(NAV_NOW));
        await g.page.setViewportSize({ width, height });
        await g.ctx.addInitScript(`navigator.registerProtocolHandler = () => {};
          localStorage.removeItem("cstra_invite_handler");`);
        await g.page.goto(String(server.url));
        await g.page.getByRole("button", { name: "允许", exact: true }).waitFor();
        await g.page.locator("[data-nav-tab=me]").waitFor();
        await g.page.evaluate("document.fonts.ready");
        await g.page.waitForTimeout(400); // Existing Sidebar/nav transitions finish before measuring.
        await g.page.mouse.move(width - 5, 5);
        results[size] = await layout(g.page);
        await g.page.screenshot({ path: resolve(out, `${phase}-invite-${size}.png`), animations: "disabled" });
        expect(g.external).toEqual([]);
        expect(g.errors).toEqual([]);
        if (phase === "after") {
          // Real clicks also prove the portal card remains interactive and 「我的」 opens its page.
          if (width < 640) {
            const cdp = await g.ctx.newCDPSession(g.page);
            await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 34, left: 0 } });
            const safe = await layout(g.page);
            expect(safe.card.bottom).toBe(results[size]!.card.bottom - 34);
            expect(safe.navTop).toBe(results[size]!.navTop! - 34);
            expect(safe.reachable).toEqual(["today", "projects", "sessions", "team", "me"]);
            await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
            await cdp.detach();
            await g.page.locator("[data-nav=phone] [data-nav-tab=me]").click();
            await g.page.locator("[data-nav-pages=me] [data-me-entry]").first().waitFor();
            await g.page.setViewportSize({ width: 1440, height: 900 });
            await g.page.locator("[data-nav=rail]").waitFor();
            expect((await layout(g.page)).card.bottom).toBe(884);
            await g.page.setViewportSize({ width, height });
            await g.page.locator("[data-nav=phone]").waitFor();
            expect((await layout(g.page)).reachable).toEqual(["today", "projects", "sessions", "team", "me"]);
          }
          await g.page.getByRole("button", { name: "以后再说", exact: true }).click();
          expect(await g.page.getByRole("button", { name: "允许", exact: true }).count()).toBe(0);
        }
      } finally { await g.ctx.close(); }
    }
    await Bun.write(resolve(out, `${phase}-bounds.json`), JSON.stringify(results, null, 2));
    const desktop = results["1440x900"]!;
    expect(desktop.navTop).toBeNull();
    expect(desktop.card.bottom).toBe(900 - 16);
    expect(desktop.card.width).toBe(420);
    expect(desktop.card.x).toBe((1440 - 420) / 2);
    const phone = results["390x844"]!;
    expect(phone.reachable).toEqual(["today", "projects", "sessions", "team", "me"]);
    expect(phone.navTop).not.toBeNull();
    expect(phone.card.bottom).toBeLessThan(phone.navTop!);
    expect(phone.wrapperEvents).toBe("none");
    expect(phone.cardEvents).toBe("auto");
  } finally { await browser.close(); server.stop(true); }
}, 120_000);
