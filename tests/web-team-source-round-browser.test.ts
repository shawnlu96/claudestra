/**
 * team-project-N8B2 截图（opt-in）：ROUND_SHOTS_DIR=<目录> bun test tests/web-team-source-round-browser.test.ts
 * 团队视图（?side=team）与本机协作视图（?side=local），390 / 1280 浅色，同一份合成夹具，过截图自动检查。
 * 1280 拍首页（左栏任务线带阶段短语）；手机团队首页只有产品 DAG，390 团队侧拍第一个 feature 里 review 卡的任务详情，本机侧拍手机列表。
 * ROUND_BASELINE_WEB=<main 的 web 目录> 换成改前的构建、文件名前缀 before-（改前对照图）。
 * 本机夹具把 review / fix 卡的轮次改成真实值（0 / 6 / 3），改后应照旧显示。纯 fixture，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { teamOverview } from "@/features/collab/team-source-adapter";
import type { LedgerOverview } from "@/features/collab/collab-model";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.ROUND_SHOTS_DIR;
const webRoot = process.env.ROUND_BASELINE_WEB ?? "web";
const prefix = process.env.ROUND_BASELINE_WEB ? "before-" : "after-";

/** 本机卡的真实轮次：第一张 review 卡 0（还没送审）、第二张 6，fix 卡 3 且最近审查是第 3 轮 */
function localRounds(local: LedgerOverview, now: number): LedgerOverview {
  let reviews = 0;
  const tasks = local.tasks.map((t) => {
    if (t.stage === "review") return { ...t, round: reviews++ === 0 ? 0 : 6 };
    if (t.stage === "fix") return { ...t, round: 3, lastReview: { round: 3, verdict: "changes", p0: 0, p1: 1, p2: 0, text: "边界条件没覆盖", ts: now } };
    return t;
  });
  return { ...local, tasks };
}

function serve(bundle: string) {
  const fx = generateTeamFixture();
  const local = localRounds(fx.local, fx.now);
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    const at = Date.now();
    const details = fx.details.map((d) => ({ ...d, feature: { ...d.feature, projection: d.feature.projection && { ...d.feature.projection, observedAt: at, receivedAt: at } } }));
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...local, now: at });
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

test.skipIf(!out)("round unknown: team / local home at 390 / 1280", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { server, fx } = serve(bundle);
  const reviewId = teamOverview(fx.list, new Map(fx.details.map((d) => [d.feature.id, d])), fx.now).ov.tasks
    .find((t) => t.itemId === fx.list.features[0]!.id && t.stage === "review")!.id;
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, texts: Record<string, string> = {}, shots: { file: string; sha256: string }[] = [];
  try {
    for (const side of ["team", "local"] as const) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}?side=${side}&theme=light&project=${fx.project}&team=${fx.team}`);
      if (side === "team" && width < 700) {
        // 手机首页只有产品 DAG 卡片，阶段短语在任务详情里：feature 卡 → 子 DAG 节点 → 节点页里的卡号 → 任务详情
        await page.getByText(fx.list.features[0]!.title, { exact: false }).first().click();
        await page.getByText(reviewId, { exact: true }).first().click();
        await page.locator("[class*=sheet_]").getByText(reviewId, { exact: true }).first().click();
      }
      await page.waitForFunction("/等审查|返工中/.test(document.body.innerText)", undefined, { timeout: 15_000 }); // 字符串：根 tsconfig 不带 dom 类型
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const name = `${prefix}${side}-${width}`;
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      shots.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
      issues[name] = await shotIssues(page);
      texts[name] = await page.locator("body").innerText();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-N8B2", web: webRoot, shots, issues }, null, 2) + "\n");
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  if (prefix === "after-") for (const [name, text] of Object.entries(texts)) {
    if (name.includes("team")) {
      // 手机详情底下压着子 DAG，节点上的「审 · 第 N 轮」来自主场步骤行的真实轮次（sourceStepId），不在本卡范围
      expect(text).not.toMatch(/(等审查|返工中|审查中) · 第/);
      expect(text).toMatch(/等审查/);
      if (name.endsWith("1280")) {
        expect(text).toMatch(/返工中/);
        expect(text).not.toMatch(/第\s*\d+\s*轮/);
      }
    } else {
      expect(text).toMatch(/等审查 · 第 1 轮/);
      expect(text).toMatch(/等审查 · 第 6 轮/);
      expect(text).toMatch(/返工中 · 第 3 轮意见/);
    }
  }
}, 180_000);
