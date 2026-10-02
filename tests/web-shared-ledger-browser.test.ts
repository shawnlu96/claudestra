/**
 * i28-TV1 同屏对照（opt-in）：SHARED_LEDGER_SHOTS_DIR=<审查目录> bun test tests/web-shared-ledger-browser.test.ts
 * 同一个项目的本地协作视图和团队视图（同一个 CollabView，换数据源），1400 / 390 × 浅 / 深 共 8 张，拼成 compare.png；
 * 每张都过截图自动检查（tests/helpers/ui-shot-checks.ts）。数据缺省用生成器造的生产形状夹具；
 * TEAM_VIEW_SNAPSHOT=<仓库外的只读 JSON，形状同 TeamFixture> 换成本机台账导出的生产快照（不进 git）。
 * 另在团队视图里把团队操作点一遍：编辑规划 → 409 → 重读 → 逐条处理 → 提交；任务详情里的开卡 / 绑卡 / 阶段 / 审批。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTeamFixture, type TeamFixture } from "@/features/collab/shared/team-fixture-gen";
import type { FeatureDetail } from "@/lib/api/shared-ledger";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.SHARED_LEDGER_SHOTS_DIR;
const snapshot = process.env.TEAM_VIEW_SNAPSHOT;

function loadFixture(): TeamFixture {
  return snapshot ? JSON.parse(readFileSync(snapshot, "utf8")) as TeamFixture : generateTeamFixture();
}

async function serve(fx: TeamFixture, bundle: string) {
  const files = readdirSync(bundle);
  let details = new Map(fx.details.map((d) => [d.feature.id, d]));
  let conflictOnce = true, conflicts = 0;
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/__rearm") { conflictOnce = true; return json({ ok: true }); } // 每轮团队操作都要再撞一次 409
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...fx.local });
    const task = path.match(new RegExp(`^/api/v1/ledger/${fx.project}/tasks/(.+)$`));
    if (task) {
      const t = fx.local.tasks.find((x) => x.id === decodeURIComponent(task[1]!));
      return t ? json({ ok: true, task: t, events: [], timeline: [], now: fx.now }) : json({ error: "nf" }, 404);
    }
    if (path === "/api/v1/shared-ledger/features") return json({ ...fx.list, features: [...details.values()].map((d) => d.feature) });
    const feature = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (feature) return json(details.get(decodeURIComponent(feature[1]!)));
    if (path === "/api/v1/shared-ledger/commands" && req.method === "POST") {
      const cmd = await req.json() as { featureId: string; requestId: string; nodes: FeatureDetail["dag"]["nodes"] };
      const d = details.get(cmd.featureId)!;
      if (conflictOnce) {
        // 同事先改了第一个没绑卡的节点：409 带最新图
        conflictOnce = false;
        const free = d.dag.nodes.find((n) => !d.dag.bindings.some((b) => b.nodeKey === n.key))!;
        const latest = { ...d, serverSeq: d.serverSeq + 1, feature: { ...d.feature, rev: d.feature.rev + 1, version: d.dag.version + 1, updatedBy: "person-b" },
          dag: { ...d.dag, version: d.dag.version + 1, nodes: d.dag.nodes.map((n) => n.key === free.key ? { ...n, oneLine: `同事改过的标题 ${++conflicts}` } : n) } };
        details = new Map(details).set(d.feature.id, latest);
        return json({ code: "conflict", error: "conflict", latest }, 409);
      }
      const next = { ...d, serverSeq: d.serverSeq + 1, feature: { ...d.feature, rev: d.feature.rev + 1, version: d.dag.version + 1 },
        dag: { ...d.dag, version: d.dag.version + 1, nodes: cmd.nodes } };
      details = new Map(details).set(d.feature.id, next);
      return json({ schemaVersion: 1, requestId: cmd.requestId, commandDigest: "x", serverSeq: next.serverSeq, committedAt: fx.now,
        result: { featureId: d.feature.id, rev: next.feature.rev, version: next.dag.version } });
    }
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    return new Response(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
}

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

async function teamActions(page: Page, narrow: boolean, tag: string) {
  await (narrow ? page.getByRole("button", { name: "团队", exact: true }).first() : page.getByRole("tab", { name: "团队" }).or(page.getByRole("button", { name: "团队", exact: true })).first()).click();
  await page.getByText("团队规划", { exact: true }).waitFor();
  const edit = page.getByRole("button", { name: /^编辑规划 / }).last();
  await edit.click();
  await page.getByRole("button", { name: "提交新版本" }).waitFor();
  const sets = page.locator("fieldset");
  expect(await sets.first().getByRole("textbox").first().isDisabled()).toBe(true); // 已绑卡的节点锁定
  const free = sets.filter({ hasNot: page.getByText("已绑卡，节点锁定") }).first();
  await free.getByRole("textbox").nth(1).fill(`我的草稿标题 ${tag}`);
  await page.getByRole("textbox", { name: "改图原因" }).fill("i28-TV1 browser check");
  await page.getByRole("button", { name: "提交新版本" }).click();
  await page.getByText("规划已被他人更新", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重读后编辑" }).click();
  await page.getByRole("button", { name: /^用我的 / }).first().click();
  await page.getByRole("button", { name: "提交新版本" }).click();
  await page.getByRole("button", { name: /^编辑规划 / }).first().waitFor();
  expect(await page.getByText("规划已被他人更新", { exact: true }).count()).toBe(0);
}

test.skipIf(!out)("team view = local CollabView: 1400/390 × light/dark side by side, shot checks, team actions", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, "fixture-bundle");
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/shared/fixture-harness.tsx", "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const fx = loadFixture();
  const server = await serve(fx, bundle);
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: { name: string; png: Buffer }[] = [];
  const issues: Record<string, ShotIssue[]> = {};
  try {
    for (const width of [1400, 390]) for (const theme of ["light", "dark"] as const) for (const side of ["local", "team"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}?side=${side}&theme=${theme}&project=${fx.project}&team=${fx.team}`);
      await page.getByText(fx.local.tasks[0]!.title, { exact: true }).first().waitFor({ timeout: 15_000 });
      await settle(page);
      const name = `${side}-${width}-${theme}`;
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      shots.push({ name, png });
      issues[name] = await shotIssues(page);
      if (side === "team" && theme === "light") {
        // 任务详情：团队操作在复用后的位置（任务属性页）上，执行类按 capabilities 置灰
        await page.getByText(fx.local.tasks[1]!.title, { exact: true }).first().click();
        await page.getByText("团队操作", { exact: true }).waitFor();
        for (const label of ["开卡", "绑卡", "阶段", "审批"]) expect(await page.getByRole("button", { name: label, exact: true }).isDisabled()).toBe(true);
        await page.screenshot({ path: resolve(out, `${name}-task.png`) });
        await page.goto(`${server.url}?side=team&theme=${theme}&project=${fx.project}&team=${fx.team}`);
        await page.getByText(fx.local.tasks[0]!.title, { exact: true }).first().waitFor({ timeout: 15_000 });
        await page.request.get(`${server.url}__rearm`);
        await teamActions(page, width < 700, name);
        await page.screenshot({ path: resolve(out, `${name}-ops.png`) });
      }
      expect(errors).toEqual([]);
      await page.close();
    }
    // 检查器自检：故意造的重叠、UUID 标题、横向溢出都要被抓到（否则上面的空数组不说明问题）
    const bad = await browser.newPage({ viewport: { width: 390, height: 400 } });
    await bad.setContent(`<body style="margin:0"><h3 style="position:absolute;top:10px;left:10px">团队视图标题</h3>
      <span style="position:absolute;top:14px;left:20px">连线文字</span><b style="position:absolute;top:80px">00a1fe59-1c2d-4e5f-a6b7-c8d9e0f1a2b3</b>
      <div style="width:600px;position:absolute;top:120px">wide</div><button style="position:absolute;top:200px;width:16px">待你处理</button></body>`);
    expect([...new Set((await shotIssues(bad)).map((i) => i.kind))].sort()).toEqual(["idTitle", "overflow", "overlap", "squeeze"]);
    await bad.close();
    // 8 张拼一张：每行同一尺寸 / 主题的本地 | 团队
    const grid = await browser.newPage({ viewport: { width: 2000, height: 1000 } });
    await grid.setContent(`<body style="margin:0;background:#888;font:14px system-ui"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px">
      ${shots.map((s) => `<figure style="margin:0"><figcaption>${s.name}</figcaption><img style="width:100%" src="data:image/png;base64,${s.png.toString("base64")}"></figure>`).join("")}
      </div></body>`);
    await grid.waitForLoadState("load");
    await grid.screenshot({ path: resolve(out, "compare.png"), fullPage: true });
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); server.stop(true); }
}, 240_000);
