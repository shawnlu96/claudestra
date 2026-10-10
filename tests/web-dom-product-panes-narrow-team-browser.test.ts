/**
 * team-project-N8B9 截图（opt-in）：N8B9_SHOTS_DIR=<目录> bun test tests/web-dom-product-panes-narrow-team-browser.test.ts
 * 同一份合成夹具（tests/web-team-source-n8b6.test.ts 的 n8b6Fixture），团队（?side=team）和本机（?side=local）各走一遍：
 * 1280 点「团队」→ 视口改成 390（产品 DAG 内容、「产品 DAG」选中）→ 改回 1280（还是「团队」）。浅色，过截图自动检查。
 * N8B9_BASELINE_WEB=<main 的 web 目录> 换成改前的构建、文件名前缀 before-，只截图不断言。纯 fixture，回环 Bun.serve，不连生产。
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

const out = process.env.N8B9_SHOTS_DIR;
const webRoot = process.env.N8B9_BASELINE_WEB ?? "web";
const prefix = process.env.N8B9_BASELINE_WEB ? "before-" : "after-";

function serve(bundle: string) {
  const fx = n8b6Fixture();
  const L = `/api/v1/ledger/${fx.project}`, fid = fx.list.features[0]!.id;
  const product = sharedProductBoard(fx.list, N8B6_NOW, fx.local.ov.tasks, fx.details);
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const at = Date.now();
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

/** 字符串：根 tsconfig 不带 dom 类型。页面上还有别的 tablist，只看带「谁在干活」的那一条（ProductPanes 的） */
const PANE_TABS = `[...([...document.querySelectorAll('[role=tablist]')].find((l) => l.textContent.includes('谁在干活'))?.querySelectorAll('[role=tab]') ?? [])]`;
const SELECTED = `${PANE_TABS}.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent)`;
const TABS = `${PANE_TABS}.map((b) => b.textContent)`;

test.skipIf(!out)("N8B9: 1280 选「团队」→ 390 → 1280，团队 / 本机", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { server, fx } = serve(bundle);
  const title = fx.list.features[0]!.title;
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, shots: { file: string; sha256: string; selected: string[]; tabs: string[] }[] = [];
  const seen: Record<string, { selected: string[]; tabs: string[]; text: string }> = {};
  try {
    for (const side of ["team", "local"] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const settle = async () => {
        await page.evaluate("document.fonts.ready");
        await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      };
      const shoot = async (step: string) => {
        await settle();
        const name = `${prefix}${side}-${step}`;
        const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
        const selected = await page.evaluate(SELECTED) as string[], tabs = await page.evaluate(TABS) as string[];
        shots.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex"), selected, tabs });
        issues[name] = await shotIssues(page);
        seen[name] = { selected, tabs, text: await page.locator("body").innerText() };
      };
      await page.goto(`${server.url}?side=${side}&theme=light&project=${fx.project}&team=${fx.team}`);
      await page.getByText(title, { exact: true }).first().waitFor({ timeout: 15_000 });
      await page.getByRole("tab", { name: "团队", exact: true }).click();
      await page.waitForFunction(`${SELECTED}.includes('团队')`, undefined, { timeout: 15_000 });
      await shoot("1-1280-team");
      await page.setViewportSize({ width: 390, height: 1100 });
      await page.waitForFunction(`!${TABS}.includes('团队')`, undefined, { timeout: 15_000 });
      await shoot("2-390-from-1280");
      await page.setViewportSize({ width: 1280, height: 1100 });
      await page.waitForFunction(`${TABS}.includes('团队')`, undefined, { timeout: 15_000 });
      await shoot("3-1280-back");
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
  writeFileSync(resolve(out, `${prefix}manifest.json`), JSON.stringify({ card: "team-project-N8B9", web: webRoot, shots, issues }, null, 2) + "\n");
  if (prefix !== "after-") return;
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  for (const side of ["team", "local"]) {
    const wide = seen[`after-${side}-1-1280-team`]!, narrow = seen[`after-${side}-2-390-from-1280`]!, back = seen[`after-${side}-3-1280-back`]!;
    expect(wide.selected).toEqual(["团队"]);
    expect(narrow.tabs).toEqual(["产品 DAG", "谁在干活"]);
    expect(narrow.selected).toEqual(["产品 DAG"]);
    expect(narrow.text).toContain(title);
    expect(back.selected).toEqual(["团队"]);
    expect(back.text).toBe(wide.text);
  }
}, 180_000);
