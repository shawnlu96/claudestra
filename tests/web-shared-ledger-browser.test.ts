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
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTeamFixture, type TeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { generateHomeFixture, homeDagBoard, homeProductBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { FeatureDetail } from "@/lib/api/shared-ledger";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.SHARED_LEDGER_SHOTS_DIR;
const snapshot = process.env.TEAM_VIEW_SNAPSHOT;

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
  const { fx, home } = await loadFixture();
  const server = await serve(fx, bundle, home);
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: { name: string; png: Buffer }[] = [];
  const issues: Record<string, ShotIssue[]> = {};
  try {
    for (const width of [1400, 390]) for (const theme of ["light", "dark"] as const) for (const side of ["local", "team"] as const) {
      if (side === "local" && !home) continue; // 生产快照没有本机 DAG / 产品看板
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.url}?side=${side}&theme=${theme}&project=${fx.project}&team=${fx.team}`);
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
      if (side === "team" && theme === "light") {
        // 任务详情：团队操作在复用后的位置（任务属性页）上，执行类按 capabilities 置灰
        if (width < 700) {
          const f = fx.details[0]!, node = f.dag.nodes[6]!;
          await page.getByRole("button").filter({ has: page.getByText(f.feature.title, { exact: true }) }).click();
          await page.getByText(node.oneLine, { exact: true }).first().click();
          await page.getByRole("button", { name: new RegExp(`^${node.key} `) }).last().click();
        } else await page.getByText(fx.local.tasks[1]!.title, { exact: true }).first().click();
        await page.getByText("团队操作", { exact: true }).waitFor();
        for (const label of ["开卡", "绑卡", "阶段", "审批"]) expect(await page.getByRole("button", { name: label, exact: true }).isDisabled()).toBe(true);
        await page.screenshot({ path: resolve(out, `${name}-task.png`) });
        await page.goto(`${server.url}?side=team&theme=${theme}&project=${fx.project}&team=${fx.team}`);
        await page.getByText(fx.list.features[0]!.title, { exact: true }).first().waitFor({ timeout: 15_000 });
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


const regressions = process.env.TV1_REGRESSION === "1";
async function regression(run: (page: Page, url: string) => Promise<void>, empty = false) {
  const bundle = resolve(".tv1-regression-bundle"), webRoot = process.env.TV1_BASELINE_WEB ?? "web";
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const fx = generateTeamFixture();
  if (empty) { fx.list.features = []; fx.details = []; }
  const server = await serve(fx, bundle);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(2500);
    await page.goto(`${server.url}?side=team&project=${fx.project}&team=${fx.team}`);
    await run(page, String(server.url));
  } finally { await browser.close(); server.stop(true); }
}

test.skipIf(!regressions)("refresh-key: actual team entry refreshes after polling and committed rewrite", async () => {
  await regression(async (page, url) => {
    await page.getByText(generateTeamFixture().local.tasks[0]!.title, { exact: true }).first().waitFor();
    await page.request.get(`${url}__update`);
    await page.getByText("UPDATED REVIEW PROBE", { exact: true }).first().waitFor({ timeout: 8000 });
    await teamActions(page, false, "refresh");
    await page.getByRole("tab", { name: "产品 DAG", exact: true }).click();
    await page.getByRole("button").filter({ has: page.getByText(generateTeamFixture().details.at(-1)!.feature.title, { exact: true }) }).click();
    await page.getByText("我的草稿标题 refresh", { exact: true }).first().waitFor();
  });
}, 30000);

test.skipIf(!regressions)("empty-ops: create first feature and initialize first DAG from an empty team", async () => {
  await regression(async (page) => {
    await page.getByRole("tab", { name: "团队", exact: true }).click();
    await page.getByRole("button", { name: "新建 feature", exact: true }).click();
    await page.getByRole("textbox", { name: "标题", exact: true }).fill("FIRST FEATURE");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "编辑规划 FIRST FEATURE", exact: true }).click();
    await page.getByRole("button", { name: "添加节点", exact: true }).click();
    await page.getByRole("textbox", { name: "标题", exact: true }).fill("FIRST NODE");
    await page.getByRole("textbox", { name: "文件范围", exact: true }).fill("web/**");
    await page.getByRole("textbox", { name: "改图原因", exact: true }).fill("initialize first DAG");
    await page.getByRole("button", { name: "提交新版本", exact: true }).click();
    await page.getByRole("tab", { name: "产品 DAG", exact: true }).click();
    await page.getByRole("button").filter({ has: page.getByText("FIRST FEATURE", { exact: true }) }).click();
    await page.getByText("FIRST NODE", { exact: true }).first().waitFor();
  }, true);
}, 30000);

test.skipIf(!regressions)("dag-source: team renders shared nodes and versions without local ledger reads", async () => {
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

test.skipIf(!regressions)("overlap-check: fully overlapping transparent text fails while opaque masks hide text", async () => {
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


test.skipIf(!regressions)("unknown-metrics: team review rounds and fixed findings display unavailable", async () => {
  await regression(async page => {
    await page.getByText("审查轮次", { exact: true }).waitFor();
    for (const label of ["审查轮次", "P0/P1 修掉"]) {
      expect(await page.getByText(label, { exact: true }).locator("..").innerText()).toContain("暂无");
    }
  });
}, 30000);
