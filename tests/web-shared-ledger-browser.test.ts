/**
 * i28-TV1 同屏对照（opt-in）：SHARED_LEDGER_SHOTS_DIR=<审查目录> bun test tests/web-shared-ledger-browser.test.ts
 * 同一个项目的本地协作视图和团队视图（同一个 CollabView，换数据源），1400 / 390 × 浅 / 深 共 8 张，拼成 compare.png；
 * 每张都过截图自动检查（tests/helpers/ui-shot-checks.ts）。数据缺省是 home-fixture-gen.ts 的一份本机台账：本地路由吐它，
 * 团队路由吐它经生产导出 / 投影器 / 中心读口得到的投影（web-team-parity-browser-center.test.ts；不再用 teamDagBoard 冒充本地，team-parity-C）。
 * TEAM_VIEW_SNAPSHOT=<仓库外的只读 JSON，形状同 TeamFixture> 换成生产快照（不进 git）：快照里没有本机 DAG / 产品看板，只截团队一侧。
 * 另在团队视图里把团队操作点一遍：编辑规划 → 409 → 重读 → 逐条处理 → 提交；任务详情里的开卡 / 绑卡 / 阶段 / 审批。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { budgetedTest } from "./browser-test-budget";
import { generateTeamFixture, type TeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { generateHomeFixture, homeDagBoard, homeProductBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { FeatureDetail } from "@/lib/api/shared-ledger";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.SHARED_LEDGER_SHOTS_DIR;
const snapshot = process.env.TEAM_VIEW_SNAPSHOT;
const browsers = new Set<Browser>();
const browserTest = budgetedTest(() => [...browsers].flatMap(b => b.contexts()));

async function withFixture(fx: TeamFixture, home: HomeFixture | null, run: (browser: Browser, url: string) => Promise<void>, webRoot = "web") {
  const bundle = mkdtempSync(join(tmpdir(), "shared-ledger-browser-"));
  let server: Awaited<ReturnType<typeof serve>> | undefined, browser: Browser | undefined;
  const failures: unknown[] = [];
  try {
    const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
      "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code) throw new Error(stderr);
    server = await serve(fx, bundle, home);
    // Collect closed pipe finalizers before Chromium can reuse their descriptors in the next scenario.
    Bun.gc(true);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
    browsers.add(browser);
    await run(browser, String(server.url));
  } catch (error) { failures.push(error); }
  finally {
    try { await browser?.close(); } catch (error) { failures.push(error); }
    if (browser) browsers.delete(browser);
    try { server?.stop(true); } catch (error) { failures.push(error); }
    try { rmSync(bundle, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    console.info("[shared-ledger-browser] cleanup", {
      contexts: browser?.contexts().length ?? 0, connected: browser?.isConnected() ?? false, bundleExists: existsSync(bundle), failures: failures.length,
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "browser fixture failed, including cleanup");
}

async function openPage(browser: Browser, url: string, width: number, theme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, serviceWorkers: "block" });
  const external: string[] = [], calls: string[] = [], errors: string[] = [];
  await ctx.route("**/*", r => {
    if (new URL(r.request().url()).origin === new URL(url).origin) return r.continue();
    external.push(r.request().url()); return r.abort();
  });
  await ctx.routeWebSocket(() => true, ws => { external.push(ws.url()); ws.close(); });
  const page = await ctx.newPage();
  page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  page.on("pageerror", e => errors.push(e.message));
  return { page, ctx, external, calls, errors };
}

async function taskDetail(page: Page, fx: TeamFixture, side: "local" | "team", narrow: boolean) {
  const id = narrow ? fx.details[0]!.dag.nodes[6]!.key : fx.local.tasks[1]!.id;
  if (narrow) {
    const f = fx.details[0]!, node = f.dag.nodes[6]!;
    await page.getByRole("button").filter({ has: page.getByText(f.feature.title, { exact: true }) }).click();
    await page.getByText(node.oneLine, { exact: true }).first().click();
  } else {
    // The original target is verified and excluded by the default unfinished filter.
    await page.getByRole("navigation", { name: "大纲" }).getByRole("tab", { name: /^全部 / }).click();
    await page.getByRole("navigation", { name: "大纲" }).getByText(fx.local.tasks[1]!.title, { exact: true }).click();
  }
  const panel = page.locator("aside").filter({ has: page.getByRole("button", { name: "关闭", exact: true }) });
  await panel.getByText(id, { exact: true }).first().waitFor();
  await panel.getByText("现在", { exact: true }).waitFor();
  await panel.getByText("正在读取…", { exact: true }).waitFor({ state: "hidden" });
  if (side === "team") {
    await panel.getByText("团队操作", { exact: true }).waitFor();
    for (const label of ["开卡", "绑卡", "阶段", "审批"]) expect(await panel.getByRole("button", { name: label, exact: true }).isDisabled()).toBe(true);
    expect(await panel.innerText()).toContain("全文仅在主场");
  } else expect(await panel.getByText("团队操作", { exact: true }).count()).toBe(0);
  return id;
}

/** home = 本地一侧的唯一数据源；生产快照只有团队一侧，home 为 null */
async function loadFixture(): Promise<{ fx: TeamFixture; home: HomeFixture | null }> {
  if (snapshot) return { fx: JSON.parse(readFileSync(snapshot, "utf8")) as TeamFixture, home: null };
  const home = generateHomeFixture(), team = await teamFromHome(home);
  return { fx: { team: home.team, project: home.project, now: home.now, list: team.list, details: team.details, local: home.overview }, home };
}

async function serve(fx: TeamFixture, bundle: string, home: HomeFixture | null = null) {
  const files = readdirSync(bundle);
  let details = new Map(fx.details.map((d) => [d.feature.id, d]));
  let conflictOnce = true, conflicts = 0, seq = fx.list.serverSeq;
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/__update") {
      const d = [...details.values()][0]!;
      details.set(d.feature.id, { ...d, feature: { ...d.feature, rev: d.feature.rev + 1 },
        dag: { ...d.dag, nodes: d.dag.nodes.map((n, i) => i === 0 ? { ...n, oneLine: "UPDATED REVIEW PROBE" } : n) } });
      seq++; return json({ ok: true });
    }
    if (path === "/__rearm") { conflictOnce = true; return json({ ok: true }); } // 每轮团队操作都要再撞一次 409
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...fx.local });
    // 本地 DAG / 产品看板 / 任务详情只从本机台账出；没有本机数据（只喂团队的回归用例、生产快照）就 404，不拿团队模型冒充
    if (path === `/api/v1/ledger/${fx.project}/dag`) return home ? json(homeDagBoard(home)) : json({ error: "no home ledger" }, 404);
    if (path === `/api/v1/ledger/${fx.project}/product`) return home ? json(homeProductBoard(home)) : json({ error: "no home ledger" }, 404);
    const task = path.match(new RegExp(`^/api/v1/ledger/${fx.project}/tasks/(.+)$`));
    if (task) {
      const d = home?.details[decodeURIComponent(task[1]!)];
      return d ? json({ ok: true, ...d }) : json({ error: "nf" }, 404);
    }
    if (path === "/api/v1/shared-ledger/features") return json({ ...fx.list, serverSeq: seq, features: [...details.values()].map((d) => d.feature) });
    const feature = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (feature) return json(details.get(decodeURIComponent(feature[1]!)));
    if (path === "/api/v1/shared-ledger/commands" && req.method === "POST") {
      const cmd = await req.json() as { featureId: string; requestId: string; nodes: FeatureDetail["dag"]["nodes"]; type: string; title: string };
      if (cmd.type === "feature.new") {
        const d = structuredClone(generateTeamFixture().details[0]!);
        d.feature = { ...d.feature, title: cmd.title, version: 0, rev: 1 };
        d.dag = { version: 0, nodes: [], bindings: [] }; d.tasks = [];
        details.set(d.feature.id, d); seq++;
        return json({ schemaVersion: 1, requestId: cmd.requestId, commandDigest: "x", serverSeq: seq, committedAt: fx.now,
          result: { featureId: d.feature.id, rev: 1, version: 0 } });
      }
      const d = details.get(cmd.featureId)!;
      if (cmd.type === "dag.init") conflictOnce = false;
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
      details = new Map(details).set(d.feature.id, next); seq++;
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

async function submitPlan(page: Page, status: number) {
  const [res] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/shared-ledger/commands" && r.request().method() === "POST"),
    page.getByRole("button", { name: "提交新版本" }).click(),
  ]);
  expect(res.status()).toBe(status);
  const command = res.request().postDataJSON();
  expect(command.type).toBe("dag.rewrite");
  expect(command.reason).toBe("i28-TV1 browser check");
  expect(command.requestId).toBeString();
  return command;
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
  const first = await submitPlan(page, 409);
  await page.getByText("规划已被他人更新", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重读后编辑" }).click();
  await page.getByRole("button", { name: /^用我的 / }).first().click();
  const second = await submitPlan(page, 200);
  expect(second.featureId).toBe(first.featureId);
  expect(second.expectedRev).toBe(first.expectedRev + 1);
  expect(second.baseVersion).toBe(first.baseVersion + 1);
  expect(second.requestId).not.toBe(first.requestId);
  expect(second.nodes.some((n: { oneLine: string }) => n.oneLine === `我的草稿标题 ${tag}`)).toBe(true);
  await page.getByRole("button", { name: /^编辑规划 / }).first().waitFor();
  expect(await page.getByText("规划已被他人更新", { exact: true }).count()).toBe(0);
}

(out ? browserTest : test.skip)("team view = local CollabView: 1400/390 × light/dark side by side, shot checks, team actions", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const { fx, home } = await loadFixture();
  const shots: { name: string; png: Buffer }[] = [];
  const issues: Record<string, ShotIssue[]> = {};
  await withFixture(fx, home, async (browser, url) => {
    for (const width of [1400, 390]) for (const theme of ["light", "dark"] as const) for (const side of ["local", "team"] as const) {
      if (side === "local" && !home) continue; // 生产快照没有本机 DAG / 产品看板
      const { page, ctx, errors, external, calls } = await openPage(browser, url, width, theme);
      await page.goto(`${url}?side=${side}&theme=${theme}&project=${fx.project}&team=${fx.team}`);
      await page.getByText(fx.list.features[0]!.title, { exact: true }).first().waitFor({ timeout: 15_000 });
      await settle(page);
      const firstFeature = fx.list.features[0]!;
      const bar = page.getByRole("progressbar", { name: firstFeature.title, exact: true });
      await bar.waitFor();
      const tasks = side === "local" ? fx.local.tasks : teamOverview(fx.list, new Map(fx.details.map(d => [d.feature.id, d])), fx.now).ov.tasks;
      // 本地事项 id 是主场的，团队的是中心 UUID：按标题对上同一个 feature
      const itemId = side === "local" ? fx.local.items.find(i => i.title === firstFeature.title)?.id : firstFeature.id;
      const completed = tasks.filter(t => t.itemId === itemId && (t.stage === "done" || t.stage === "verified")).length;
      expect(Number(await bar.getAttribute("aria-valuenow"))).toBe(completed);
      const name = `${side}-${width}-${theme}`;
      const png = await page.screenshot({ path: resolve(out, `${name}.png`) });
      shots.push({ name, png });
      issues[name] = await shotIssues(page);
      if (theme === "light") {
        const id = await taskDetail(page, fx, side, width < 700);
        if (side === "local") expect(calls).toContain(`GET /api/v1/ledger/${fx.project}/tasks/${id}`);
        else expect(calls.filter(c => /^(POST|PATCH|DELETE) .*\/shared-ledger\//.test(c))).toEqual([]);
        await page.screenshot({ path: resolve(out, `${name}-task.png`) });
      }
      if (side === "team" && theme === "light") {
        await page.goto(`${url}?side=team&theme=${theme}&project=${fx.project}&team=${fx.team}`);
        await page.getByText(fx.list.features[0]!.title, { exact: true }).first().waitFor({ timeout: 15_000 });
        await page.request.get(`${url}__rearm`);
        await teamActions(page, width < 700, name);
        await page.screenshot({ path: resolve(out, `${name}-ops.png`) });
      }
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      if (side === "team") expect(calls.filter(c => /\/ledger\//.test(c))).toEqual([]);
      else expect(calls.filter(c => /\/shared-ledger\//.test(c))).toEqual([]);
      await Bun.write(resolve(out, `${name}-requests.json`), JSON.stringify({ calls, external, errors }, null, 2));
      await ctx.close();
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
  });
}, 240_000);


const regressions = process.env.TV1_REGRESSION === "1";
// 显式基线解析后与当前 web 同一实际根（./web、web/、软链等别名）仍按当前模式验证，不算隔离基线
const isolatedBaseline = () => !!process.env.TV1_BASELINE_WEB && realpathSync(process.env.TV1_BASELINE_WEB) !== realpathSync("web");
// 模拟探针（TV1_FILTER_PROBE，不是线上复现）：hidden = 旧页无筛选、大纲直接列全部；delayed = 大纲先出、筛选 400ms 后才就绪
const probe = process.env.TV1_FILTER_PROBE;
const filterProbes: Record<string, string> = Object.fromEntries(["hidden", "delayed"].map(kind => [kind, `new MutationObserver((_, o) => {
  const list = document.querySelector('nav[aria-label="大纲"] [role=tablist]'); if (!list) return; o.disconnect();
  ${kind === "hidden" ? `[...list.children].find(b => b.textContent.startsWith("全部")).click();` : `setTimeout(() => { list.style.display = ""; }, 400);`}
  list.style.display = "none";
}).observe(document, { childList: true, subtree: true });`]));
if (probe && !filterProbes[probe]) throw new Error(`unknown TV1_FILTER_PROBE=${probe}`);
async function regression(run: (page: Page, url: string) => Promise<void>, empty = false, init?: string) {
  const fx = generateTeamFixture();
  if (empty) { fx.list.features = []; fx.details = []; }
  await withFixture(fx, null, async (browser, url) => {
    const { page, ctx, external, errors } = await openPage(browser, url, 1400);
    page.setDefaultTimeout(2500);
    if (init) await page.addInitScript(init);
    await page.goto(`${url}?side=team&project=${fx.project}&team=${fx.team}`);
    await run(page, url);
    expect(external).toEqual([]); expect(errors).toEqual([]);
    await ctx.close();
  }, process.env.TV1_BASELINE_WEB ?? "web");
}

(regressions ? browserTest : test.skip)("refresh-key: actual team entry refreshes after polling and committed rewrite", async () => {
  await regression(async (page, url) => {
    const outline = page.getByRole("navigation", { name: "大纲" });
    const all = outline.getByRole("tab", { name: /^全部 / }), done = generateTeamFixture().local.tasks[0]!.title;
    // 只有真正不同的隔离基线才认无筛选旧页；就绪 = 「全部」可点，或大纲已直接列出默认「未完成」会藏起的已完成卡（不拿某一刻 count=0 判无入口）
    const isolated = isolatedBaseline();
    if (isolated) await all.or(outline.getByText(done, { exact: true })).first().waitFor();
    if (!isolated || await all.isVisible()) await all.click();
    await page.getByText(done, { exact: true }).first().waitFor();
    await page.request.get(`${url}__update`);
    await page.getByText("UPDATED REVIEW PROBE", { exact: true }).first().waitFor({ timeout: 8000 });
    await teamActions(page, false, "refresh");
    await page.getByRole("tab", { name: "产品 DAG", exact: true }).click();
    await page.getByRole("button").filter({ has: page.getByText(generateTeamFixture().details.at(-1)!.feature.title, { exact: true }) }).click();
    await page.getByText("我的草稿标题 refresh", { exact: true }).first().waitFor();
  }, false, probe && filterProbes[probe]);
}, 30000);

(regressions ? browserTest : test.skip)("empty-ops: new feature from an empty team goes to the N7W proposal API, never V1 feature.new", async () => {
  await regression(async (page) => {
    const posts: string[] = []; page.on("request", r => void (r.method() === "POST" && /\/shared-/.test(r.url()) && posts.push(new URL(r.url()).pathname)));
    await page.getByRole("tab", { name: "团队", exact: true }).click();
    await page.getByRole("button", { name: "新建 feature", exact: true }).click();
    await page.getByRole("textbox", { name: "标题", exact: true }).fill("FIRST FEATURE");
    for (const [name, value] of [["一句话描述 1", "FIRST NODE"], ["文件范围 1", "web/**"]]) await page.getByRole("textbox", { name }).fill(value!);
    await page.getByRole("button", { name: "提交提案", exact: true }).click();
    await page.getByText("本机未绑定该团队项目").first().waitFor(); expect(posts).toEqual(["/api/v1/shared-feature-proposals"]); // 夹具无提案路由
  }, true);
}, 30000);

(regressions ? browserTest : test.skip)("dag-source: team renders shared nodes and versions without local ledger reads", async () => {
  await regression(async (page) => {
    const localReads: string[] = [];
    page.on("request", r => { if (/\/ledger\/.*\/(dag|product)/.test(r.url())) localReads.push(r.url()); });
    await page.reload();
    await page.getByRole("tab", { name: "子 DAG", exact: true }).waitFor();
    await page.getByRole("button").filter({ has: page.getByText(generateTeamFixture().details[0]!.feature.title, { exact: true }) }).click();
    await page.getByText(generateTeamFixture().details[0]!.dag.nodes[6]!.oneLine, { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "版本", exact: true }).click();
    await page.getByRole("button", { name: "对比", exact: true }).waitFor();
    expect(localReads).toEqual([]);
  });
}, 30000);

(regressions ? browserTest : test.skip)("overlap-check: fully overlapping transparent text fails while opaque masks hide text", async () => {
  const check = process.env.TV1_BASELINE_WEB
    ? (await import(resolve(process.env.TV1_BASELINE_WEB, "../tests/helpers/ui-shot-checks.ts"))).shotIssues as typeof shotIssues : shotIssues;
  await regression(async (page) => {
    for (const left of [10, 18]) {
      await page.setContent(`<span style="position:absolute;left:10px;top:10px">ABCDEFG</span>
        <span style="position:absolute;left:${left}px;top:10px">HIJKLMN</span>`);
      expect((await check(page)).some(i => i.kind === "overlap")).toBe(true);
    }
    await page.setContent('<span style="position:absolute;left:10px;top:10px">ABCDEFG</span><div style="position:absolute;inset:0;background:white">MASK</div>');
    expect(await check(page)).toEqual([]);
  });
}, 30000);


(regressions ? browserTest : test.skip)("unknown-metrics: team review rounds and fixed findings display unavailable", async () => {
  await regression(async page => {
    await page.getByText("审查轮次", { exact: true }).waitFor();
    for (const label of ["审查轮次", "P0/P1 修掉"]) {
      expect(await page.getByText(label, { exact: true }).locator("..").innerText()).toContain("暂无");
    }
  });
}, 30000);
