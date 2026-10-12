/**
 * team-project-N8B6 截图（opt-in）：N8B6_SHOTS_DIR=<目录> bun test tests/web-team-source-n8b6-browser.test.ts
 * 同一份合成夹具（tests/web-team-source-n8b6.test.ts 的 n8b6Fixture）进子 DAG：团队（?side=team）和本机（?side=local），390 / 1280 浅色，
 * 过截图自动检查。N8B6_BASELINE_WEB=<main 的 web 目录> 换成改前的构建、文件名前缀 before-；本机两次的截图和子 DAG 的 DOM 摘要应逐字节相同。
 * 纯 fixture，回环 Bun.serve，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { teamDagFeature } from "@/features/collab/team-source-dag";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { N8B6_NOW, n8b6Fixture } from "./web-team-source-n8b6.test";

const out = process.env.N8B6_SHOTS_DIR;
const webRoot = process.env.N8B6_BASELINE_WEB ?? "web";
const prefix = process.env.N8B6_BASELINE_WEB ? "before-" : "after-";

function serve(bundle: string) {
  const fx = n8b6Fixture();
  const L = `/api/v1/ledger/${fx.project}`, fid = fx.list.features[0]!.id;
  const product = sharedProductBoard(fx.list, N8B6_NOW, fx.local.ov.tasks, fx.details);
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const at = Date.now();
    // 镜像新鲜度按真时钟判：投影时间跟着请求走，截图里不出「过期」
    const detail = fx.details.get(fid)!, feature = { ...detail.feature, projection: { ...detail.feature.projection!, observedAt: at, receivedAt: at } };
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === L) return json({ ok: true, ...fx.local.ov, now: at });
    if (path === `${L}/dag`) return json({ ...fx.local.board, now: at });
    if (path === `${L}/dag/${fid}`) return json(teamDagFeature(fx.local.board, fid));
    if (path === `${L}/product`) return json(product);
    if (path === "/api/v1/shared-ledger/features") return json({ ...fx.list, features: [feature] });
    if (path === `/api/v1/shared-ledger/features/${fid}`) return json({ ...detail, feature });
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

test.skipIf(!out)("N8B6: team / local sub-DAG at 390 / 1280", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { server, fx } = serve(bundle);
  const title = fx.list.features[0]!.title;
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, texts: Record<string, string> = {}, shots: { file: string; sha256: string; dom: string }[] = [];
  try {
    for (const side of ["team", "local"] as const) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}?side=${side}&theme=light&project=${fx.project}&team=${fx.team}`);
      await page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first().click();
      await page.waitForFunction("/T44/.test(document.body.innerText) && /R5/.test(document.body.innerText)", undefined, { timeout: 15_000 }); // 字符串：根 tsconfig 不带 dom 类型
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const name = `${prefix}${side}-${width}`;
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      // 子 DAG 节点卡的 DOM（去掉随构建变的 css module 类名）：本机改前改后逐字节相同的另一份证据
      const dom = String(await page.evaluate(`[...document.querySelectorAll("[class*=nmain]")].map((b) => b.parentElement.outerHTML).join("\\n")`))
        .replace(/class="[^"]*"/g, "");
      shots.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex"), dom: createHash("sha256").update(dom).digest("hex") });
      issues[name] = await shotIssues(page);
      texts[name] = await page.locator("body").innerText();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-N8B6", web: webRoot, shots, issues }, null, 2) + "\n");
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  if (prefix === "after-") for (const [name, text] of Object.entries(texts)) {
    if (name.includes("team")) {
      expect(text).not.toMatch(/修 · 第 2 轮/);
      expect(text).toMatch(/审 · 第 5 轮/);
    } else {
      expect(text).toMatch(/修 · 第 2 轮/);
      expect(text).toMatch(/审 · 第 5 轮/);
    }
  }
}, 180_000);
