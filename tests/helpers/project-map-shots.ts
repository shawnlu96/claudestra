/**
 * 项目地图这一批的截图底座（PDLAYOUT1 建，后面的卡复用、不改它）：起服务照 tests/web-collab-node-card-browser.test.ts
 * （generateHomeFixture、teamFromHome、bundleHarness、serve、guardedPage），默认 ?side=local；产品板用 page.route 换成传入的 board。
 * 改前构建由 PROJECT_MAP_BUNDLE 传入（同 NODE_CARD_BUNDLE），这时文件名前缀是 before-，否则 after-。
 * 输出目录是 PROJECT_MAP_SHOTS_DIR（各卡的截图测试以它为 opt-in 开关）。
 */
import type { Browser } from "playwright-core";
import { mkdirSync } from "node:fs";
import { generateHomeFixture, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { ProductBoard } from "../../web/lib/api/product-board-types";
import { teamFromHome } from "../web-team-parity-browser-center.test";
import { bundleHarness, guardedPage, serve } from "./collab-fixture-serve";

export const projectMapShotsDir = process.env.PROJECT_MAP_SHOTS_DIR;
/** before- = 改前构建（PROJECT_MAP_BUNDLE），after- = 当前代码 */
export const shotPrefix = process.env.PROJECT_MAP_BUNDLE ? "before-" : "after-";

let running: Promise<{ url: string; home: HomeFixture; stop: () => void }> | null = null;

async function start() {
  const out = projectMapShotsDir;
  if (!out) throw new Error("PROJECT_MAP_SHOTS_DIR is not set");
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const bundle = process.env.PROJECT_MAP_BUNDLE ?? await bundleHarness(out);
  const { server } = serve(home, team, bundle);
  return { url: String(server.url), home, stop: () => server.stop(true) };
}

/** 本进程共用一个服务；测试结束调 stopProjectMap */
export async function openProjectMap(browser: Browser, opts: { width: number; board: ProductBoard; side?: "local" | "team"; height?: number }) {
  running ??= start();
  const { url, home } = await running;
  const guarded = await guardedPage(browser, url, { width: opts.width });
  const { page } = guarded;
  await page.setViewportSize({ width: opts.width, height: opts.height ?? (opts.width < 600 ? 844 : 800) });
  await page.route("**/api/v1/ledger/*/product", (route) => route.fulfill({ json: opts.board }));
  await page.goto(`${url}?side=${opts.side ?? "local"}&project=${home.project}&team=${home.team}#chat`);
  await page.getByText(opts.board.features.find((f) => f.status === "active" && f.state === "run")?.title ?? opts.board.features[0]!.title, { exact: true })
    .first().waitFor();
  await page.evaluate("document.fonts.ready");
  return guarded;
}

export async function stopProjectMap() {
  if (!running) return;
  (await running).stop();
  running = null;
}
