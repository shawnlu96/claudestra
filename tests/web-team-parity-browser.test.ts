/**
 * team-parity-C 同一份本机数据双喂的真实对照（opt-in，截图是私密证据，不进 git）：
 *   TEAM_PARITY_SHOTS_DIR=<仓库外目录> bun --no-env-file test tests/web-team-parity-browser.test.ts
 * 本地路由只吐 home-fixture-gen.ts 那一份本机台账，团队路由只吐 home-to-team-fixture.ts 从它推出的投影；回环 Bun.serve，
 * 页面上所有非回环请求一律拦掉并记账（生产 bridge / 中心 / 字体 CDN 都到不了）。1200 / 390 × 浅 / 深 × 本地 / 团队，
 * 首页、任务详情（手机先进 feature 再点卡）、版本页、对比页、谁在干活、团队标签逐个截图，DOM 检测器出
 * {section, local, team} 矩阵，按 tests/helpers/team-parity-matrix.ts 的 §3 期望逐项判 pass / known_gap / fail。
 * 另外两条证明检测是真的：旧「本机由团队模型生成」的喂法下 T3/T5/T7 差异检不出（旧红），本机数据下检得出（新绿）；
 * 在页面里删掉一个区块（受控变异），检测器和比对必须报出来。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, homeDagBoard, homeDagDiff, homeDagFeature, homeProductBoard, homeWorkBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { homeToTeam } from "@/features/collab/shared/home-to-team-fixture";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { compareMatrix, differing, MATRIX, type MatrixResult, type Observed, type TeamState } from "./helpers/team-parity-matrix";

const out = process.env.TEAM_PARITY_SHOTS_DIR;
/** 手机列表会把已完成的卡折起来：选一张在返工、带 block 审查的卡，桌面 / 手机都能点到 */
const FOCUS = "i28-A5";

/** legacy = 旧夹具的喂法：本地也由团队模型生成（teamOverview / teamDagBoard / sharedProductBoard，详情 events / timeline 为空） */
function serve(home: HomeFixture, bundle: string, legacy = false) {
  const files = readdirSync(bundle), team = homeToTeam(home), p = home.project, L = `/api/v1/ledger/${p}`;
  const details = new Map(team.details.map((d) => [d.feature.id, d]));
  const teamOv = teamOverview(team.list, details, home.now);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const unexpected: string[] = [];
  const agents = ["dev-1", "dev-2", "dev-3", "pm-a", "rv-1"].map((n) => ({ name: `agent-${n}`, status: "active", projectId: p, cwd: "/repo", lastActivityTs: home.now }));
  const ask = { id: "ask-a7", fromAgent: "agent-dev-1", assignee: null, project: p, taskId: "i28-A7", title: "接口命名二选一", context: "", body: "", kind: "decide",
    kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null,
    createdAt: home.now - 3600_000, updatedAt: home.now - 3600_000, expiresAt: home.now + 86_400_000, canAnswer: true };
  const since = home.now - 3 * 3600_000;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    // 本机这台机器自己的数据（registry / 待办 / peers / 额度）：两边同一台机器，照实都给
    if (path === "/api/v1/agents") return json({ ok: true, agents });
    if (path === "/api/v1/presence") return json({ ok: true });
    if (path === "/api/v1/asks") return json({ ok: true, asks: [ask], now: home.now, canAnswer: true });
    if (path === "/api/v1/peers/contacts") return json({ contacts: [{ name: "peer-mac", online: true, stale: false, agents: [{ name: "dev-x", busy: true }] }] });
    if (path === "/api/v1/team/quota") return json({ providers: [{ provider: "claude", used: 0.42, observedAt: home.now }] });
    if (path === "/api/v1/team/activity") return url.searchParams.get("project") === p ? json({ now: home.now, interactions: [], truncated: false }) : json({ error: "no project" }, 404);
    if (path === `/api/v1/me/last-seen/${p}`) return req.method === "PUT" ? json({ ok: true })
      : json({ lastSeen: since, now: home.now, events: Object.values(home.details).flatMap((d) => d.events).filter((e) => e.ts > since).sort((a, b) => a.seq - b.seq) });
    // 本机台账：只吐本机形状（legacy 时故意复现旧夹具）
    if (path === L) return json({ ok: true, ...(legacy ? teamOv.ov : home.overview) });
    if (path === `${L}/dag`) return json(legacy ? teamDagBoard(p, team.list, details, teamOv) : homeDagBoard(home));
    if (path === `${L}/product`) return json(legacy ? sharedProductBoard(team.list, home.now, teamOv.ov.tasks) : homeProductBoard(home));
    if (path === `${L}/work`) return json(homeWorkBoard(home));
    const diff = path.match(new RegExp(`^${L}/dag/([^/]+)/diff$`));
    if (diff) {
      const d = homeDagDiff(home, diff[1]!, Number(url.searchParams.get("from")), Number(url.searchParams.get("to")));
      return d ? json(d) : json({ error: "nf" }, 404);
    }
    const feat = path.match(new RegExp(`^${L}/dag/([^/]+)$`));
    if (feat) {
      const v = url.searchParams.get("version");
      const d = homeDagFeature(home, feat[1]!, v ? Number(v) : undefined);
      return d ? json(d) : json({ error: "nf" }, 404);
    }
    const task = path.match(new RegExp(`^${L}/tasks/(.+)$`));
    if (task) {
      const d = home.details[task[1]!];
      return d ? json({ ok: true, ...(legacy ? { task: teamOv.ov.tasks.find((t) => t.id === task[1]) ?? d.task, events: [], timeline: [], now: home.now } : d) }) : json({ error: "nf" }, 404);
    }
    // 团队：只吐由本机数据推出的投影
    if (path === "/api/v1/shared-ledger/features") return json(team.list);
    const shared = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (shared) return details.has(shared[1]!) ? json(details.get(shared[1]!)) : json({ error: "nf" }, 404);
    if (path.startsWith("/api/")) {
      if (!/^\/api\/v1\/(events|agents\/|me\/last-seen\/|team\/activity|ledger\/shared-ledger)/.test(path)) unexpected.push(`${req.method} ${path}`);
      return json({ ok: false, error: "not in fixture" }, 404);
    }
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    return new Response(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, team, unexpected };
}

// ---- 检测器：只读 DOM，给出 present / absent / home_only / unknown ----

/** 区块文字 → 状态：仅主场 → home_only；暂无 → unknown；data 判定有真数据 → present；否则 absent */
const classify = (text: string | null, data: (t: string) => boolean): TeamState =>
  text === null ? "absent" : /仅主场|仅在主场/.test(text) ? "home_only" : /暂无/.test(text) ? "unknown" : data(text) ? "present" : "absent";
const DURATION = /\d+\s*(秒|分|小时|天)/;

async function detailSections(page: Page, id: string): Promise<Record<string, string | null>> {
  // 页面脚本写成字符串：根 tsconfig 不带 dom lib（同 web-shared-ledger-browser.test.ts 的约定）
  return page.evaluate(`(() => {
    const panel = [...document.querySelectorAll("aside")].find((a) => [...a.querySelectorAll("span")].some((s) => s.textContent === ${JSON.stringify(id)}));
    if (!panel) return {};
    const secs = {};
    for (const h of panel.querySelectorAll("h5")) secs[h.textContent ?? ""] = h.parentElement.innerText;
    secs.__all = panel.innerText;
    return secs;
  })()`);
}

async function observeTask(page: Page, id: string, title: string): Promise<Observed> {
  const s = await detailSections(page, id), all = s.__all ?? "";
  const line = (re: RegExp) => all.split("\n").find((l) => re.test(l)) ?? null;
  return {
    "标题": all.includes(title) ? "present" : "absent",
    "现在·停留时长": classify(s["现在"] ?? null, (t) => /在此阶段/.test(t) && DURATION.test(t)),
    "阶段用时": classify(s["阶段与用时"] ?? null, (t) => DURATION.test(t)),
    "因果线": classify(s["它的因果线"] ?? null, (t) => /i28-/.test(t)),
    "最近 3 件事": classify(s["最近 3 件事"] ?? null, (t) => t.split("\n").length > 1),
    "回放": classify(s["回放"] ?? line(/回放/), () => true),
    "审查": classify(s["审查"] ?? null, (t) => /R\d/.test(t)),
    "参与者": classify(s["参与者"] ?? null, (t) => /执行者|PM|审查员/.test(t)),
    "打开会话 / 对它说": classify(line(/打开会话|对它说|会话仅主场/), (t) => /打开会话|对它说/.test(t)),
    "步骤线": classify(s["步骤"] ?? null, () => true),
    // 团队操作区块里本来就有「全文仅在主场」（T14），不能按占位词判
    "团队操作": s["团队操作"] ? "present" : "absent",
  };
}

async function metric(page: Page, label: string): Promise<TeamState> {
  const el = page.getByText(label, { exact: true }).first();
  if (!(await el.count())) return "absent";
  const text = (await el.locator("..").innerText()).replace(label, "").trim();
  return /暂无/.test(text) ? "unknown" : /^\d/.test(text) ? "present" : "absent";
}

type Shot = { name: string; png: Buffer };
interface RunResult { observed: Observed; notes: string[]; calls: string[]; external: string[]; errors: string[] }

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

async function openTask(page: Page, home: HomeFixture, narrow: boolean) {
  const task = home.details[FOCUS]!.task;
  if (narrow) {
    const f = home.features.find((x) => x.id === task.itemId)!;
    await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
    await page.getByText(task.title, { exact: true }).first().click();
    await page.getByRole("button", { name: new RegExp(`^${FOCUS} `) }).last().click();
  } else await page.getByText(task.title, { exact: true }).first().click();
  await page.locator("aside h5", { hasText: "现在" }).first().waitFor();
  // 详情是异步读的：等到「正在读取…」消失再测
  await page.waitForFunction(`![...document.querySelectorAll("aside")].some((a) => a.innerText.includes("正在读取"))`);
  await settle(page);
}

async function runSide(browser: Browser, url: string, home: HomeFixture, width: number, theme: "light" | "dark", side: "local" | "team", shots: Shot[], dir: string | null): Promise<RunResult> {
  const narrow = width < 700, name = `${side}-${width}-${theme}`;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, timezoneId: "Asia/Shanghai" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000);
  const calls: string[] = [], external: string[] = [], errors: string[] = [], notes: string[] = [];
  const origin = new URL(url).origin;
  await page.route("**/*", (r) => {
    if (new URL(r.request().url()).origin === origin) return r.continue();
    external.push(r.request().url());
    return r.abort();
  });
  page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(`${r.method()} ${decodeURIComponent(new URL(r.url()).pathname + new URL(r.url()).search)}`); });
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (view: string) => {
    await settle(page);
    const png = await page.screenshot(dir ? { path: resolve(dir, `${name}-${view}.png`) } : {});
    shots.push({ name: `${name}-${view}`, png });
  };
  const observed: Observed = {};
  try {
    // 待办 store、上次以来各自一个请求：先挂上等待再导航，回来了再测，不 sleep
    // 团队侧只等待办：上次以来是本机接口，P1-A 之后团队不该再请求它
    const ready = Promise.all([page.waitForResponse((r) => r.url().includes("/api/v1/asks")),
      side === "local" ? page.waitForResponse((r) => r.url().includes("/api/v1/me/last-seen/")) : null]);
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    const first = home.features[0]!;
    await page.getByRole("progressbar", { name: first.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await ready;
    await settle(page);
    observed["产品 DAG 卡片"] = "present";
    if (narrow) {
      for (const m of ["在场 agent", "进行中", "今日完成", "审查轮次", "P0/P1 修掉", "平均等复核"]) observed[m] = "not_run";
      notes.push("390：手机布局没有指标条（collab-view.tsx !narrow && MetricsBar），M1–M5 两边都不渲染，记 not_run");
    } else {
      for (const m of ["在场 agent", "进行中", "今日完成", "审查轮次", "P0/P1 修掉", "平均等复核"]) observed[m] = await metric(page, m);
    }
    // 手机顶栏按钮、桌面大纲入口都是「待你处理 <数>」
    const w = (await page.getByRole("button", { name: /^待你处理/ }).first().innerText()).replace("待你处理", "").trim();
    observed["待你处理"] = /暂无/.test(w) ? "unknown" : /^\d/.test(w) ? "present" : "absent";
    observed["上次以来"] = (await page.getByRole("region", { name: "上次来之后" }).count()) ? "present" : narrow ? "not_run" : "absent";
    if (narrow && observed["上次以来"] === "not_run") notes.push("390：上次以来卡片只在桌面右栏概览里（Overview since=），手机首页不渲染");
    await shot("home");

    await openTask(page, home, narrow);
    Object.assign(observed, await observeTask(page, FOCUS, home.details[FOCUS]!.task.title));
    await shot("task");
    await page.keyboard.press("Escape");

    // 版本页 / 对比页：进 feature 的子 DAG，点「版本」，再点「对比」（默认上一版 → 当前版）
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    await page.getByRole("progressbar", { name: first.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button").filter({ has: page.getByText(first.title, { exact: true }) }).first().click();
    await page.getByText(home.details[FOCUS]!.task.title, { exact: true }).first().waitFor();
    observed["子 DAG 节点"] = "present";
    await page.getByRole("button", { name: /^(版本|v\d+)$/ }).first().click();
    await page.getByRole("button", { name: "对比", exact: true }).first().waitFor();
    await page.waitForFunction(`!document.body.innerText.includes("正在读取")`, undefined, { timeout: 5000 })
      .catch(() => notes.push(`${side}: 版本页 5s 后仍是「正在读取…」`));
    const rows = await page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).count();
    // 只认版本页自己的「暂无历史版本」（P1-F 的文案）：页面别处（指标条）本来就有「暂无」
    const noHistory = /暂无历史版本/.test(await page.locator("body").innerText());
    observed["版本历史"] = rows > 0 ? "present" : noHistory ? "unknown" : "absent";
    await shot("versions");
    const cmp = page.getByRole("button", { name: "对比", exact: true }).first();
    if (await cmp.isEnabled()) {
      await cmp.click();
      await page.locator("h5", { hasText: /^增 · \d/ }).first().waitFor({ timeout: 5000 }).catch(() => notes.push(`${side}: 对比页 5s 内没出差异列表`));
      observed["两版对比"] = (await page.locator("h5", { hasText: /^增 · \d/ }).count()) ? "present" : "absent";
    } else observed["两版对比"] = noHistory ? "unknown" : "absent"; // 没历史时 P1-F 把「对比」置灰
    await shot("diff");

    // 谁在干活 / 团队：中区标签（手机上团队是顶栏按钮；谁在干活在手机产品 DAG 列表里没有入口）
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    await page.getByRole("progressbar", { name: first.title, exact: true }).first().waitFor({ timeout: 15_000 });
    const workTab = page.getByRole("tab", { name: "谁在干活", exact: true });
    if (await workTab.count()) {
      await workTab.first().click();
      // 摘要行「在干活 N」：N > 0 才算有数据（大纲里也有卡标题，不能按标题判）；团队现状是假 0 + 骨架屏一直重试
      await page.waitForFunction(`/在干活\\s*[1-9]|仅主场/.test(document.body.innerText)`, undefined, { timeout: 5000 })
        .catch(() => notes.push(`${side}: 谁在干活 5s 内没有在干活的卡，也没有「仅主场」占位`));
      const body = await page.locator("body").innerText();
      observed["谁在干活"] = /在干活\s*[1-9]/.test(body) ? "present" : /仅主场/.test(body) ? "home_only" : "absent";
      await shot("work");
    } else { observed["谁在干活"] = "not_run"; notes.push(`${width}: 没有「谁在干活」标签入口`); }
    const teamBtn = narrow ? page.getByRole("button", { name: "团队", exact: true }) : page.getByRole("tab", { name: "团队", exact: true });
    const peers = page.waitForResponse((r) => r.url().includes("/api/v1/peers/contacts"), { timeout: 5000 })
      .catch(() => notes.push(`${side}: 团队标签 5s 内没有请求本机 peers`));
    await teamBtn.first().click();
    await peers;
    await settle(page);
    observed["团队成员卡（本机 peers）"] = (await page.locator("body").innerText()).includes("peer-mac") ? "present" : "absent";
    observed["团队规划"] = (await page.getByText("团队规划", { exact: true }).count()) ? "present" : "absent";
    await shot("team");
  } finally { await ctx.close(); }
  // 误调：看请求记录（本地这几条是正当请求，团队带团队键 / 本机 peers 就是误调）
  const hit = (re: RegExp) => (calls.some((c) => re.test(c)) ? "present" : "absent") as TeamState;
  const key = side === "team" ? "shared-ledger:" : home.project;
  observed["上次以来·本机接口误调"] = hit(new RegExp(`/me/last-seen/${key.replace(/[{}]/g, "")}`));
  observed["谁在干活·本机接口误调"] = hit(new RegExp(`/ledger/${key}[^?]*/work`));
  observed["团队标签·本机接口误调"] = side === "team" ? hit(/\/team\/activity\?project=shared-ledger:|\/peers\/contacts|\/team\/quota/) : hit(/\/peers\/contacts/);
  return { observed, notes, calls, external, errors };
}

async function bundleHarness(dir: string) {
  const bundle = resolve(dir, "fixture-bundle");
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/shared/fixture-harness.tsx", "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return bundle;
}
const launch = () => chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });

test.skipIf(!out)("team-parity-C: same home ledger fed to local and team, 1200/390 × light/dark matrix against §3", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), bundle = await bundleHarness(out);
  const { server, unexpected } = serve(home, bundle);
  const browser = await launch(), shots: Shot[] = [];
  const report: { scenario: string; matrix: { section: string; ref: string; local: TeamState | "not_run"; team: TeamState | "not_run" }[];
    results: MatrixResult[]; differing: string[]; notes: string[] }[] = [];
  try {
    for (const width of [1200, 390]) for (const theme of ["light", "dark"] as const) {
      const local = await runSide(browser, String(server.url), home, width, theme, "local", shots, out);
      const team = await runSide(browser, String(server.url), home, width, theme, "team", shots, out);
      const scenario = `${width}-${theme}`;
      const results = [...compareMatrix("local", local.observed), ...compareMatrix("team", team.observed)];
      report.push({ scenario, matrix: MATRIX.map((r) => ({ section: r.section, ref: r.ref, local: local.observed[r.section] ?? "not_run", team: team.observed[r.section] ?? "not_run" })),
        results, differing: differing(local.observed, team.observed), notes: [...local.notes, ...team.notes] });
      await Bun.write(resolve(out, `calls-${scenario}.json`), JSON.stringify({ local: local.calls, team: team.calls }, null, 2));
      expect({ scenario, external: [...local.external, ...team.external] }).toEqual({ scenario, external: [] });
      expect({ scenario, errors: [...local.errors, ...team.errors] }).toEqual({ scenario, errors: [] });
    }
    await Bun.write(resolve(out, "matrix.json"), JSON.stringify(report, null, 2));
    expect(unexpected).toEqual([]);
    // 已知缺口照实列出（不让它变绿），但任何 fail / stale_gap 都要红：前者是回归或夹具问题，后者说明缺口已修、该删 gap
    const bad = report.flatMap((r) => r.results.filter((x) => x.verdict === "fail" || x.verdict === "stale_gap").map((x) => ({ scenario: r.scenario, ...x })));
    expect(bad).toEqual([]);
    // 桌面上 T3 / T5 / T7 的差异必须检得出（旧夹具检不出，见下一条）
    for (const r of report.filter((x) => x.scenario.startsWith("1200"))) for (const s of ["阶段用时", "最近 3 件事", "审查"]) expect(r.differing).toContain(s);
  } finally { await browser.close(); server.stop(true); }
}, 600_000);

test.skipIf(!out)("team-parity-C old-red/new-green: team-model-fed local hides T3/T5/T7; controlled mutation is caught", async () => {
  if (!out) return;
  const home = generateHomeFixture(), bundle = await bundleHarness(out);
  const browser = await launch();
  const legacy = serve(home, bundle, true), fresh = serve(home, bundle);
  try {
    const one = async (url: string) => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${url}?side=local&project=${home.project}&team=${home.team}`);
      await page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
      await openTask(page, home, false);
      return { page, observed: await observeTask(page, FOCUS, home.details[FOCUS]!.task.title) };
    };
    const old = await one(String(legacy.server.url)), now = await one(String(fresh.server.url));
    const teamPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await teamPage.goto(`${fresh.server.url}?side=team&project=${home.project}&team=${home.team}`);
    await teamPage.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await openTask(teamPage, home, false);
    const team = await observeTask(teamPage, FOCUS, home.details[FOCUS]!.task.title);
    const t357 = ["阶段用时", "最近 3 件事", "审查"];
    // 旧红：本机由团队模型生成时，本机这三块也是空的 → 两边「一致」，差异检不出；本机期望 present 的比对报 fail
    expect(t357.filter((s) => differing(old.observed, team).includes(s))).toEqual([]);
    expect(compareMatrix("local", old.observed).filter((r) => t357.includes(r.section)).map((r) => r.verdict)).toEqual(["fail", "fail", "fail"]);
    // 新绿：本机数据双喂，三块差异都检出，本机期望全部命中
    expect(t357.filter((s) => differing(now.observed, team).includes(s))).toEqual(t357);
    expect(compareMatrix("local", now.observed).filter((r) => t357.includes(r.section)).map((r) => r.verdict)).toEqual(["pass", "pass", "pass"]);
    // 受控变异：在真实页面里删掉「最近 3 件事」区块，检测器必须看成 absent、比对必须报 fail（检测器真的在读 DOM）
    await now.page.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "最近 3 件事")?.parentElement?.remove()`);
    const mutated = await observeTask(now.page, FOCUS, home.details[FOCUS]!.task.title);
    expect(mutated["最近 3 件事"]).toBe("absent");
    expect(compareMatrix("local", mutated).find((r) => r.section === "最近 3 件事")!.verdict).toBe("fail");
    // 受控变异：把团队详情里的「审查」换成「仅主场可见」占位，检测器必须看成 home_only，已知缺口变 stale_gap
    await teamPage.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "参与者").parentElement
      .insertAdjacentHTML("beforebegin", "<div><h5>审查</h5><div>审查原文仅主场可见</div></div>")`);
    const placeholder = await observeTask(teamPage, FOCUS, home.details[FOCUS]!.task.title);
    expect(placeholder["审查"]).toBe("home_only");
    expect(compareMatrix("team", placeholder).find((r) => r.section === "审查")!.verdict).toBe("stale_gap");
    await Bun.write(resolve(out, "old-red-new-green.json"), JSON.stringify({ legacyLocal: old.observed, homeLocal: now.observed, team, mutated, placeholder }, null, 2));
  } finally { await browser.close(); legacy.server.stop(true); fresh.server.stop(true); }
}, 120_000);
