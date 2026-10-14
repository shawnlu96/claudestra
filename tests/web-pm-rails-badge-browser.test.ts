/**
 * PMR-2 验收线 7：台账卡片详情里带 intervention 的事件显示「人工干预」徽标。只在设了 PMR2_SHOTS_DIR 时跑（headless Chromium，
 * 只用本机回环夹具）；PMR2_BASELINE_WEB 指向 main 的 web 目录时拍 before（同一份数据，旧代码不认标记）。桌面 1280 / 手机 390 各一张。
 */
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";

const out = process.env.PMR2_SHOTS_DIR;
const baseWeb = process.env.PMR2_BASELINE_WEB;
const phase = baseWeb ? "before" : "after";
const CARD = "i28-A5";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test.skipIf(!out)("PMR-2 人工干预徽标：卡片详情「最近 3 件事」", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`), root = baseWeb ?? "web";
  const build = Bun.spawn([process.execPath, "build", `${root}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${root}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const home = generateHomeFixture();
  const team = await teamFromHome(home); // 团队投影只认原样夹具，先算，再往本机详情里加干预事件
  const d = home.details[CARD]!;
  const seq = Math.max(...Object.values(home.details).flatMap((x) => x.events.map((e) => e.seq))) + 1;
  d.events.push({ seq, ts: home.now - 4 * 60_000, actor: "agent-pm-a", target: CARD, kind: "scheduler", text: "结掉停在 unknown 的派单意图",
    data: { op: "settle", manual: true, intervention: { cmd: "scheduler-settle", by: "agent-pm-a", role: "pm" } } });
  const { server } = serve(home, team, bundle);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const shots: { view: string; size: string; phase: string; ref: string; sha256: string }[] = [];
  try {
    for (const [width, height] of [[1280, 1000], [390, 1400]] as const) {
      const g = await guardedPage(browser, server.url.href, { width });
      await g.page.setViewportSize({ width, height });
      await g.page.clock.setFixedTime(home.now);
      await g.page.goto(`${server.url}?side=local&loadAgents=1&theme=light&project=${home.project}&team=${home.team}&homeInstanceId=${home.sourceInstanceId}`);
      await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
      if (width < 640) {
        const feature = home.features.find((f) => f.id === d.task.itemId)!;
        await g.page.getByRole("button").filter({ has: g.page.getByText(feature.title, { exact: true }) }).first().click();
      }
      await g.page.getByText(d.task.title, { exact: true }).first().click();
      await g.page.locator('aside [data-now="who"]').waitFor();
      const panel = g.page.locator("aside").filter({ hasText: CARD }).first();
      await panel.getByText("结掉停在 unknown 的派单意图").first().scrollIntoViewIfNeeded();
      await g.page.waitForTimeout(400);
      await g.page.evaluate("document.fonts.ready");
      expect(await panel.locator("[data-intervention]").count()).toBe(baseWeb ? 0 : 1);
      if (!baseWeb) expect(await panel.locator("[data-intervention]").innerText()).toBe("人工干预");
      const ref = `${phase}-detail-${width}x${height}.png`;
      const bytes = await g.page.screenshot({ path: resolve(out, ref) });
      shots.push({ view: "detail-recent", size: `${width}x${height}`, phase, ref, sha256: sha(bytes) });
      expect(await shotIssues(g.page)).toEqual([]);
      expect(g.external).toEqual([]);
      expect(g.errors).toEqual([]);
      await g.ctx.close();
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${phase}-shots.json`), JSON.stringify({ shots }, null, 2));
}, 180_000);
