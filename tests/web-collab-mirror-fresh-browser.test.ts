/**
 * team-project-N8F 截图（opt-in）：MIRROR_FRESH_SHOTS_DIR=<目录> bun test tests/web-collab-mirror-fresh-browser.test.ts
 * 团队视图「团队」标签的规划面板，四个 feature 分别是 fresh（刚同步）/ 5 分钟前 / 11 分钟前 / 无镜像，390 / 1280 各一张，过截图自动检查。
 * observedAt 按服务器收到请求时的真实时钟往前推（页面的 now 是浏览器里的 Date.now）。MIRROR_FRESH_BASELINE_WEB=<main 的 web 目录> 换成改前的构建，
 * 文件名前缀 before-（对照：main 上 5 分钟那个已标「主场镜像过期」）。纯 fixture，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import type { FeatureDetail } from "@/lib/api/shared-ledger";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.MIRROR_FRESH_SHOTS_DIR;
const webRoot = process.env.MIRROR_FRESH_BASELINE_WEB ?? "web";
const prefix = process.env.MIRROR_FRESH_BASELINE_WEB ? "before-" : "after-";
/** 四态：距 observedAt 多少毫秒；null = 没有执行镜像 */
const AGES = [["fresh", 0], ["5min", 5 * 60_000], ["11min", 11 * 60_000], ["none", null]] as const;

function serve(bundle: string) {
  const fx = generateTeamFixture({ features: AGES.length, nodes: 4 });
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const aged = (d: FeatureDetail, i: number): FeatureDetail => {
    const ago = AGES[i]![1], at = Date.now() - (ago ?? 0);
    return { ...d, feature: { ...d.feature, title: `${d.feature.title}（${AGES[i]![0]}）`,
      projection: ago === null ? null : { ...d.feature.projection!, observedAt: at, receivedAt: at } } };
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    const details = fx.details.map(aged);
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...fx.local });
    if (path === "/api/v1/shared-ledger/features") return json({ ...fx.list, features: details.map((d) => d.feature) });
    const feature = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (feature) return json(details.find((d) => d.feature.id === decodeURIComponent(feature[1]!)));
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, fx };
}

test.skipIf(!out)("mirror freshness: team planning panel at 390 / 1280, fresh / 5min / 11min / none", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { server, fx } = serve(bundle);
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, texts: Record<string, string> = {}, shots: { file: string; sha256: string }[] = [];
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}?side=team&theme=light&project=${fx.project}&team=${fx.team}`);
      await page.getByText(fx.list.features[0]!.title, { exact: false }).first().waitFor({ timeout: 15_000 });
      await (width < 700 ? page.getByRole("button", { name: "团队", exact: true }).first()
        : page.getByRole("tab", { name: "团队" }).or(page.getByRole("button", { name: "团队", exact: true })).first()).click();
      await page.getByText("团队规划", { exact: true }).waitFor();
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const name = `${prefix}team-planning-${width}`;
      const sec = page.getByText("团队规划", { exact: true }).first();
      await sec.scrollIntoViewIfNeeded();
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      shots.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
      issues[name] = await shotIssues(page);
      texts[name] = await page.locator("body").innerText();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-N8F", web: webRoot, states: AGES.map(([k]) => k), shots, issues }, null, 2) + "\n");
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  if (prefix === "after-") for (const text of Object.values(texts)) {
    // 规划面板每个 feature 一行「v2 · …」：fresh / 5 分钟最新、11 分钟写多久前同步、无镜像照旧
    expect(text.match(/^v2 · .*$/gm)).toEqual(["v2 · 主场镜像最新", "v2 · 主场镜像最新", "v2 · 主场 11 分钟前同步", "v2 · 尚无执行镜像"]);
  }
}, 180_000);
