/**
 * TEAMDEPS1b [验收线 5]：团队视图项目地图的前后截图（opt-in：TEAMDEPS_SHOTS_DIR；改前构建的 web 根由 TEAMDEPS_BASELINE_WEB 传入）。
 * 同一份团队夹具（tests/helpers/collab-fixture-serve 的 serve，团队 feature 加两张合成的），page.route 拦 feature-deps：
 * 「读到边」= 3 条 declared / split / task + 1 条端点不在列表里的（应当被丢掉）；「403」「404」= 老中心，应当和没有边时一样。
 * 1280×800 与 390×844、浅色；每张图 shotIssues 为空、非回环请求为 0；证据写进 <dir>/<phase>-uiEvidence.json。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { FeatureDeps } from "@/lib/api/shared-ledger-reads";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";

const out = process.env.TEAMDEPS_SHOTS_DIR;
const webRoot = process.env.TEAMDEPS_BASELINE_WEB ?? "web";
const phase = process.env.TEAMDEPS_BASELINE_WEB ? "before" : "after";
type Center = "edges" | "old403" | "old404";
/** 视口「还有 N 件 / 个」浮签（v4 viewport-tools，归 PDVIEW1）压在卡上不算本卡的排版问题；原始结果照记（同 PDLAYOUT1） */
const HINT = /"(还有 \d+ (件|个独立推进) 在?右边? ?→|还有 \d+ 个独立推进 →|下面还有 \d+ 件 ↓|← 左边还有 \d+ 件|↑ 上面还有 \d+ 件)"/;
interface Shot { view: string; size: string; phase: string; file: string }

/** 夹具只有两个团队 feature：照它们的形状再合成两个（新 id、新标题），边才落得开 */
async function teamWithFour() {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const extra = [["5b2c7e10-4d1a-4c3e-a9f0-1e2d3c4b5a61", "共享台账 shared-ledger feature 3：团队视图项目地图画出模块依赖"],
    ["7c4e9a21-6f3b-4e5d-b1a2-3c4d5e6f7a82", "团队视图 feature 2：手机端链路提示与列表对齐"]] as const;
  for (const [i, [id, title]] of extra.entries()) {
    const d = structuredClone(team.details[i]!);
    d.feature = { ...d.feature, id, title };
    team.details.push(d);
    team.list.features.push(d.feature);
  }
  return { home, team };
}

function readBack(ids: string[], project: string, team: string): FeatureDeps {
  const [a, b, c, d] = ids as [string, string, string, string];
  const edge = (from: string, to: string, kind: "split" | "declared" | "task", satisfied: boolean, count = 1) =>
    ({ projectId: project, from, to, kind, satisfied, count });
  return { schemaVersion: 1, teamId: team, updatedAt: 1_790_000_000_000, edges: [
    edge(a, b, "declared", false), edge(b, c, "split", true), edge(a, d, "task", true, 3),
    edge("0f0f0f0f-0000-4000-a000-000000000000", a, "declared", false), // 端点不在列表里：网页丢掉
  ] };
}

async function openTeamMap(page: Page, title: string, wide: boolean) {
  if (wide) {
    // 同 PDLAYOUT1：收起右栏，把宽度留给项目地图；视口打开时的摆放跟着量过的尺寸走，所以收起后重载一次
    await page.getByRole("button", { name: "收起右栏" }).click();
    await page.reload();
  }
  const tab = page.getByRole("tab", { name: "产品 DAG", exact: true });
  await tab.first().waitFor();
  await tab.first().click();
  await page.getByText(title, { exact: true }).first().waitFor();
  // 依赖链 + 独立推进并排时右边会出画布：改前改后同一步「适配全部」，整张图都在视口里
  const fit = page.getByRole("button", { name: "适配全部" });
  if (wide && await fit.count()) { await fit.click(); await page.waitForTimeout(400); }
  await page.mouse.move(1, 1);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(500);
}

test.skipIf(!out)("[验收线 5] team project map: edges vs old center 403 / 404, desktop and phone, paired shots", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { home, team } = await teamWithFour();
  const ids = team.list.features.map((f) => f.id), body = readBack(ids, home.project, home.team);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: Shot[] = [], evidence: Record<string, unknown> = {}, texts: Record<string, string> = {};
  const external: string[] = [], errors: string[] = [], unexpected: string[] = [];
  const { server, unexpected: missed } = serve(home, team, bundle);
  try {
    for (const center of ["edges", "old403", "old404"] as Center[]) for (const width of [1280, 390]) {
      // 改前没有这个读口，三种中心截出来是同一个样子；照样逐种截，好和改后成对
      const size = width === 390 ? "390x844" : "1280x800";
      const g = await guardedPage(browser, String(server.url), { width, theme: "light" });
      const reads: string[] = [], warnings: string[] = [];
      g.page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
      // serve() 没答这一条（同 tests/helpers/subdag-fixture.ts 的回法）
      await g.page.route("**/api/v1/shared-ledger/context", (route) => route.fulfill({ json: { identities: [] } }));
      await g.page.route("**/api/v1/shared-ledger/feature-deps", (route) => {
        reads.push(route.request().method());
        return center === "edges" ? route.fulfill({ json: body }) : route.fulfill({ status: center === "old403" ? 403 : 404, json: { error: "forbidden" } });
      });
      try {
        await g.page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        await g.page.clock.setFixedTime(home.now);
        await g.page.goto(`${server.url}?side=team&theme=light&project=${home.project}&team=${home.team}`);
        await openTeamMap(g.page, team.list.features[0]!.title, width === 1280);
        const view = `team-map-${center}`, file = `${phase}-${view}-${size}.png`;
        await g.page.screenshot({ path: resolve(out, file) });
        shots.push({ view, size, phase, file });
        const raw = await shotIssues(g.page), issues = raw.filter((i) => !HINT.test(i.detail));
        texts[`${view}-${size}`] = await g.page.locator("body").innerText();
        evidence[`${view}-${size}`] = { issues, raw, reads, warnings, edges: await g.page.locator("[data-pd-edge]").count() };
        expect(issues).toEqual([]);
        if (phase === "after") {
          expect(reads.length).toBeGreaterThan(0);
          expect(reads.every((m) => m === "GET")).toBe(true);
          expect(warnings.filter((w) => /feature-deps/.test(w))).toEqual([]); // 403 / 404 不打日志
        }
        external.push(...g.external); errors.push(...g.errors);
      } catch (error) {
        writeFileSync(resolve(out, `${phase}-navigation-error.txt`), await g.page.locator("body").innerText());
        await g.page.screenshot({ path: resolve(out, `${phase}-navigation-error.png`) });
        throw error;
      } finally { await g.ctx.close(); }
    }
  } finally { await browser.close(); server.stop(true); unexpected.push(...missed); }
  writeFileSync(resolve(out, `${phase}-uiEvidence.json`), JSON.stringify({ shots, evidence, texts, external, errors, unexpected }, null, 2) + "\n");
  expect(external).toEqual([]); expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  if (phase === "after") {
    // 老中心：页面文字和改前没有边时一致；读到边时有边、有「拆自」
    const before = JSON.parse(readFileSync(resolve(out, "before-uiEvidence.json"), "utf8")) as { shots: Shot[]; texts: Record<string, string> };
    for (const size of ["1280x800", "390x844"]) {
      for (const old of ["old403", "old404"]) expect(texts[`team-map-${old}-${size}`]).toBe(before.texts[`team-map-${old}-${size}`]!);
    }
    expect(texts["team-map-edges-1280x800"]).toContain("拆自");
    writeFileSync(resolve(out, "manifest.json"), JSON.stringify({ v: 1, summary: "团队视图项目地图读到模块依赖边；老中心 403 / 404 时和改前一致",
      shots: [...before.shots, ...shots] }, null, 2) + "\n");
  }
}, 240_000);
