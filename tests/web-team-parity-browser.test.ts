/**
 * team-parity-C 同一份本机数据双喂的真实对照（opt-in，截图是私密证据，不进 git）：
 *   TEAM_PARITY_SHOTS_DIR=<仓库外目录> bun --no-env-file test tests/web-team-parity-browser.test.ts
 * 本地路由只吐 home-fixture-gen.ts 那一份本机台账，团队路由只吐 home-to-team-fixture.ts 从它推出的投影；回环 Bun.serve，
 * 页面上所有非回环请求一律拦掉并记账（生产 bridge / 中心 / 字体 CDN 都到不了）。1200 / 390 × 浅 / 深 × 本地 / 团队，
 * 首页、任务详情（手机先进 feature 再点卡）、版本页、对比页、谁在干活、团队标签逐个截图，DOM 检测器出
 * {section, local, team} 矩阵，按 tests/helpers/team-parity-matrix.ts 的 §3 期望逐项判 pass / known_gap / fail。
 * 另外两条证明检测是真的：旧「本机由团队模型生成」的喂法下 T2/T3 差异检不出（旧红），本机数据下检得出（新绿）；
 * 在页面里删掉一个区块（受控变异），检测器和比对必须报出来。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, homeDagBoard, homeDagDiff, homeDagFeature, homeProductBoard, homeWorkBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { compareMatrix, differing, MATRIX, unprobed, type MatrixResult, type Observed, type TeamState } from "./helpers/team-parity-matrix";
import { teamFromHome, type TeamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.TEAM_PARITY_SHOTS_DIR;
/** 手机列表会把已完成的卡折起来：选一张在返工、带 block 审查的卡，桌面 / 手机都能点到 */
const FOCUS = "i28-A5";
/** 第二轮审查中的卡：轮次真值是 2 */
const ROUND_CARD = "i28-B2";
/** 大纲行的阶段词（只需要焦点卡的） */
const STAGE_WORD: Record<string, string> = { fix: "返工中" };

/** legacy = 旧夹具的喂法：本地也由团队模型生成（teamOverview / teamDagBoard / sharedProductBoard，详情 events / timeline 为空） */
function serve(home: HomeFixture, team: TeamFromHome, bundle: string, legacy = false) {
  const files = readdirSync(bundle), p = home.project, L = `/api/v1/ledger/${p}`;
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
    // 页面挂载时的只读查询：夹具没有会话用量（上下文一律「未知」）；本人是 team-a 成员但不在任何共享项目里、没有提案记录（不出提案按钮）
    if (path === "/api/v1/team/worker-context") return json({ known: false });
    if (path === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center-fixture", teamId: home.team,
      personId: "person-fixture", instanceId: home.sourceInstanceId }, teamRole: { available: true, value: "member" },
      capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [], peers: [] });
    if (path === "/api/v1/shared-feature-proposals" && req.method === "GET") return json({ ok: true, operations: [] });
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

/** 焦点卡详情：值要和本机真值对上（head 前 8 位）才算 present */
async function observeTask(page: Page, home: HomeFixture): Promise<Observed> {
  const title = home.details[FOCUS]!.task.title, head = home.rows[FOCUS]!.headSHA!.slice(0, 8);
  const s = await detailSections(page, FOCUS), all = s.__all ?? "";
  const line = (re: RegExp) => all.split("\n").find((l) => re.test(l)) ?? null;
  const say = Object.entries(s).find(([k]) => k.startsWith("对它说"))?.[1] ?? null;
  return {
    "标题": all.includes(title) ? "present" : "absent",
    "现在·停留时长": classify(s["现在"] ?? null, (t) => /在此阶段/.test(t) && DURATION.test(t)),
    "阶段用时": classify(s["阶段与用时"] ?? null, (t) => DURATION.test(t)),
    "因果线": classify(s["它的因果线"] ?? null, (t) => /i28-/.test(t)),
    "最近 3 件事": classify(s["最近 3 件事"] ?? null, (t) => t.split("\n").length > 1),
    "回放": classify(s["回放"] ?? line(/回放/), () => true),
    "审查": classify(s["审查"] ?? null, (t) => /R\d/.test(t)),
    "参与者": classify(s["参与者"] ?? null, (t) => /执行者|PM|审查员/.test(t)),
    // 先认「对它说」区块（本机「对它说 · dev-2」、团队「对它说」里是「仅主场可见」占位）：只按行找会先撞上团队区块的标题行，把占位误判成 present
    "打开会话 / 对它说": classify(say ?? line(/打开会话|对它说|会话仅主场/), (t) => /打开会话|对它说/.test(t)),
    "步骤线": classify(s["步骤"] ?? null, () => true),
    // 团队操作区块里本来就有「全文仅在主场」（T14），不能按占位词判
    "团队操作": s["团队操作"] ? "present" : "absent",
    "head": all.includes(head) ? "present" : "absent",
    "PR": /PR #\d+/.test(all) ? "present" : "absent",
    "规格全文": /全文仅在主场/.test(all) ? "home_only" : /规格全文/.test(all) ? "present" : "absent",
  };
}

/** 因果线点第一条边看「判定依据」：显示了建立者 + 时间 = present（团队那边按契约只能是冒充的），「未记录」= unknown */
async function observeEdge(page: Page): Promise<TeamState> {
  const row = page.locator("aside h5", { hasText: "它的因果线" }).locator("..").getByRole("button").first();
  if (!(await row.count())) return "absent";
  await row.click();
  const basis = page.locator("aside h5", { hasText: "判定依据" }).first();
  await basis.waitFor();
  const text = await basis.locator("..").innerText();
  return /未记录/.test(text) ? "unknown" : /建于/.test(text) ? "present" : "absent";
}

/** 首页产品卡（第一个 feature）：进度条、进行中计数、预计完成都和本机产品看板真值比 */
async function observeProductCard(page: Page, home: HomeFixture): Promise<Observed> {
  const truth = homeProductBoard(home).features[0]!, bar = page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first();
  const [now, max] = [await bar.getAttribute("aria-valuenow"), await bar.getAttribute("aria-valuemax")];
  const card = await bar.locator("..").innerText();
  return {
    "进度条 counts": Number(now) === truth.counts.completed && Number(max) === truth.counts.total ? "present" : "absent",
    "产品卡·进行中计数": new RegExp(`(^|\\n)${truth.counts.active} 进行中`).test(card) ? "present" : /暂无/.test(card) ? "unknown" : "absent",
    "产品卡·预计完成": /预计/.test(card) ? "present" : "absent",
  };
}

/** 子 DAG 页：大纲行（桌面）看阶段和轮次，画布节点看处理人；都按本机真值判 */
async function observeFeaturePage(page: Page, home: HomeFixture, narrow: boolean): Promise<Observed> {
  const lines = (await page.locator("body").innerText()).split("\n");
  const after = (id: string) => lines.flatMap((l, i) => (l === id ? [lines[i + 2] ?? ""] : []));
  const focus = home.details[FOCUS]!.task, round = home.overview.tasks.find((t) => t.id === ROUND_CARD)!.round;
  const out: Observed = { "节点处理人/步骤": after(FOCUS).some((l) => /· (执行者|审查员)/.test(l)) ? "present" : "absent" };
  if (narrow) return { ...out, "节点阶段（大纲行）": "not_run", "轮次（大纲行）": "not_run" };
  const outline = (await page.locator("nav[aria-label='大纲']").first().innerText()).split("\n");
  const row = (id: string) => outline[outline.indexOf(id) + 2] ?? "";
  return { ...out, "节点阶段（大纲行）": row(FOCUS).startsWith(STAGE_WORD[focus.stage] ?? "?") ? "present" : "absent",
    "轮次（大纲行）": row(ROUND_CARD).includes(`第 ${round} 轮`) ? "present" : "absent" };
}

/**
 * 谁在干活：摘要行「在干活 N」N > 0 才算有数据（大纲里也有卡标题，不能按标题判）；团队视图里中区只放
 * 「V1 仅共享规划，执行操作仍在主场」状态提示（dag/use-dag-panes.tsx noWorkBoard）= home_only。只认 role=status 里的这句，
 * 页面别处（团队操作区块）的同一句不算；提示去掉又没有在干活的卡 = absent。
 */
async function observeWork(page: Page): Promise<TeamState> {
  const body = await page.locator("body").innerText();
  if (/在干活\s*[1-9]/.test(body)) return "present";
  const hint = await page.getByRole("status").filter({ hasText: "执行操作仍在主场" }).count();
  return hint || /仅主场/.test(body) ? "home_only" : "absent";
}

/** §5.1 P1-A 验收线列的本机接口：团队视图里这些请求必须是 0 次 */
const TEAM_FORBIDDEN = [/\/me\/last-seen\//, /\/ledger\/shared-ledger:[^?]*\/work/, /\/team\/activity\?project=shared-ledger:/, /\/peers\/contacts/, /\/team\/quota/];
const forbidden = (calls: readonly string[]) => calls.filter((c) => TEAM_FORBIDDEN.some((re) => re.test(c)));

/** 误调：看请求记录（本地这几条是正当请求，团队带团队键 / 本机 peers 就是误调） */
function misCalls(calls: readonly string[], side: "local" | "team", project: string): Observed {
  const hit = (re: RegExp) => (calls.some((c) => re.test(c)) ? "present" : "absent") as TeamState;
  const key = side === "team" ? "shared-ledger:" : project;
  return {
    "上次以来·本机接口误调": hit(new RegExp(`/me/last-seen/${key.replace(/[{}]/g, "")}`)),
    "谁在干活·本机接口误调": hit(new RegExp(`/ledger/${key}[^?]*/work`)),
    "团队标签·本机接口误调": side === "team" ? hit(/\/team\/activity\?project=shared-ledger:|\/peers\/contacts|\/team\/quota/) : hit(/\/peers\/contacts/),
  };
}

/** G6：每个版本行都有提出人和「月/日 时:分」才算 present（正则不因 locale 放宽） */
const versionMeta = (vrows: readonly string[], noHistory: boolean): TeamState =>
  vrows.length ? (vrows.every((t) => /pm-a/.test(t) && /\d+\/\d+ \d+:\d+/.test(t)) ? "present" : "absent") : noHistory ? "unknown" : "absent";

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

/**
 * 每个页面都从这里开：BrowserContext 级的 HTTP 与 WebSocket 路由在建页、首次导航之前装好，非回环服务器本源的一律 abort / close 并记账。
 * 调用方断言 external 为空；tests 里的 sentinel 用例证明拦截真的生效（不同源的第二个回环服务器收不到请求）。
 */
async function guardedPage(browser: Browser, url: string, opts: { width?: number; theme?: "light" | "dark"; locale?: string } = {}) {
  const origin = new URL(url).origin, wsOrigin = origin.replace(/^http/, "ws");
  // locale 固定 zh-CN（Cf1，PM 定）：不设时 Chromium 退到 navigator.language=en-US，hhmm() 的 toLocaleString([]) 出「10/2, 13:00」，
  // 和中文夹具的 G6 检测对不上；进程 LANG 管不到 macOS Chromium。en-US 只给负探针用
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1200, height: 900 }, colorScheme: opts.theme ?? "light", timezoneId: "Asia/Shanghai",
    locale: opts.locale ?? "zh-CN" });
  const calls: string[] = [], external: string[] = [], errors: string[] = [];
  await ctx.route("**/*", (r) => {
    if (new URL(r.request().url()).origin === origin) return r.continue();
    external.push(r.request().url());
    return r.abort();
  });
  await ctx.routeWebSocket(() => true, (ws) => {
    if (new URL(ws.url()).origin === wsOrigin) return void ws.connectToServer();
    external.push(ws.url());
    return ws.close();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000);
  page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(`${r.method()} ${decodeURIComponent(new URL(r.url()).pathname + new URL(r.url()).search)}`); });
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, calls, external, errors };
}

async function runSide(browser: Browser, url: string, home: HomeFixture, width: number, theme: "light" | "dark", side: "local" | "team", shots: Shot[], dir: string | null): Promise<RunResult> {
  const narrow = width < 700, name = `${side}-${width}-${theme}`, notes: string[] = [];
  const { ctx, page, calls, external, errors } = await guardedPage(browser, url, { width, theme });
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
    Object.assign(observed, await observeProductCard(page, home));
    // 只认新鲜度文案（shared/team-ops.tsx 里的「主场镜像过期 / 最新」「尚无执行镜像」）：卡标题里本来就有「执行镜像」
    observed["镜像新鲜度"] = /主场镜像(过期|最新)|尚无执行镜像/.test(await page.locator("body").innerText()) ? "present" : narrow ? "not_run" : "absent";
    if (narrow && observed["镜像新鲜度"] === "not_run") notes.push("390：镜像新鲜度在桌面右栏概览里（v4-props.tsx MirrorSec），手机首页不渲染");
    if (narrow) {
      observed["阻塞提问"] = observed["桌面中区标签"] = "not_run";
      observed["手机顶栏按钮"] = (await page.getByRole("button", { name: "团队", exact: true }).count()) && (await page.getByRole("button", { name: /^待你处理/ }).count())
        ? "present" : "absent";
      notes.push("390：「要你定的」在桌面右栏概览里，手机首页不渲染，阻塞提问记 not_run；中区标签换成顶栏按钮（N3）");
    } else {
      // 右栏概览「要你定的」：本机列出 i28-A7 的阻塞提问；团队按投影 asks 应给「阻塞 N」，现在是「没有」
      const asks = String(await page.evaluate(`[...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent === "要你定的")?.parentElement?.innerText ?? ""`));
      observed["阻塞提问"] = /i28-A7|阻塞\s*\d/.test(asks) ? "present" : /暂无/.test(asks) ? "unknown" : "absent";
      observed["桌面中区标签"] = (await page.getByRole("tab", { name: "谁在干活", exact: true }).count()) && (await page.getByRole("tab", { name: "团队", exact: true }).count())
        ? "present" : "absent";
      observed["手机顶栏按钮"] = "not_run";
    }
    await shot("home");

    await openTask(page, home, narrow);
    Object.assign(observed, await observeTask(page, home));
    await shot("task");
    observed["依赖边·建立者/时间"] = await observeEdge(page);
    await shot("edge");
    await page.keyboard.press("Escape");

    // 版本页 / 对比页：进 feature 的子 DAG，点「版本」，再点「对比」（默认上一版 → 当前版）
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    await page.getByRole("progressbar", { name: first.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button").filter({ has: page.getByText(first.title, { exact: true }) }).first().click();
    await page.getByText(home.details[FOCUS]!.task.title, { exact: true }).first().waitFor();
    observed["子 DAG 节点"] = "present";
    Object.assign(observed, await observeFeaturePage(page, home, narrow));
    if (narrow) notes.push("390：手机子 DAG 没有大纲栏，G3 / G10 轮次记 not_run（节点处理人照测）");
    await page.getByRole("button", { name: /^(版本|v\d+)$/ }).first().click();
    await page.getByRole("button", { name: "对比", exact: true }).first().waitFor();
    await page.waitForFunction(`!document.body.innerText.includes("正在读取")`, undefined, { timeout: 5000 })
      .catch(() => notes.push(`${side}: 版本页 5s 后仍是「正在读取…」`));
    const rows = await page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).count();
    // 只认版本页自己的「暂无历史版本」（P1-F 的文案）：页面别处（指标条）本来就有「暂无」
    const noHistory = /暂无历史版本/.test(await page.locator("body").innerText());
    observed["版本历史"] = rows > 0 ? "present" : noHistory ? "unknown" : "absent";
    observed["版本元数据（提出人/时间）"] = versionMeta(await page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).allInnerTexts(), noHistory);
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
      await page.waitForFunction(`/在干活\\s*[1-9]|仅主场|执行操作仍在主场/.test(document.body.innerText)`, undefined, { timeout: 5000 })
        .catch(() => notes.push(`${side}: 谁在干活 5s 内没有在干活的卡，也没有主场占位`));
      observed["谁在干活"] = await observeWork(page);
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
  Object.assign(observed, misCalls(calls, side, home.project));
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
  const home = generateHomeFixture(), bundle = await bundleHarness(out), team = await teamFromHome(home);
  const { server, unexpected } = serve(home, team, bundle);
  const browser = await launch(), shots: Shot[] = [];
  const report: { scenario: string; matrix: { section: string; ref: string; local: TeamState | "not_run"; team: TeamState | "not_run"; limit?: string }[];
    results: MatrixResult[]; differing: string[]; notes: string[]; forbidden: { team: string[] } }[] = [];
  const seen: { local: Observed[]; team: Observed[] } = { local: [], team: [] };
  try {
    for (const width of [1200, 390]) for (const theme of ["light", "dark"] as const) {
      const local = await runSide(browser, String(server.url), home, width, theme, "local", shots, out);
      const team = await runSide(browser, String(server.url), home, width, theme, "team", shots, out);
      const scenario = `${width}-${theme}`;
      const results = [...compareMatrix("local", local.observed), ...compareMatrix("team", team.observed)];
      report.push({ scenario, matrix: MATRIX.map((r) => ({ section: r.section, ref: r.ref, local: local.observed[r.section] ?? "not_run",
        team: team.observed[r.section] ?? "not_run", ...(r.limit ? { limit: r.limit } : {}) })),
        results, differing: differing(local.observed, team.observed), notes: [...local.notes, ...team.notes], forbidden: { team: forbidden(team.calls) } });
      await Bun.write(resolve(out, `calls-${scenario}.json`), JSON.stringify({ local: local.calls, team: team.calls }, null, 2));
      expect({ scenario, external: [...local.external, ...team.external] }).toEqual({ scenario, external: [] });
      expect({ scenario, errors: [...local.errors, ...team.errors] }).toEqual({ scenario, errors: [] });
      // P1-A：团队视图对 §5.1 列的本机接口 0 次请求；本机视图照旧请求 last-seen / work / peers（本机真值不变）
      expect({ scenario, forbidden: forbidden(team.calls) }).toEqual({ scenario, forbidden: [] });
      expect({ scenario, local: forbidden(local.calls).length > 0 }).toEqual({ scenario, local: true });
      seen.local.push(local.observed); seen.team.push(team.observed);
    }
    await Bun.write(resolve(out, "matrix.json"), JSON.stringify(report, null, 2));
    // 每个没写 limit 的 §3 行两边都至少在一个场景里真测到：检测器漏一行就是基准悄悄缩水
    expect({ local: unprobed(seen.local), team: unprobed(seen.team) }).toEqual({ local: [], team: [] });
    expect(unexpected).toEqual([]);
    // 已知缺口照实列出（不让它变绿），但任何 fail / stale_gap 都要红：前者是回归或夹具问题，后者说明缺口已修、该删 gap
    const bad = report.flatMap((r) => r.results.filter((x) => x.verdict === "fail" || x.verdict === "stale_gap" || x.verdict === "unlisted").map((x) => ({ scenario: r.scenario, ...x })));
    expect(bad).toEqual([]);
    // 桌面上 T3 / T5 / T7 的差异必须检得出（旧夹具检不出，见下一条）
    for (const r of report.filter((x) => x.scenario.startsWith("1200"))) for (const s of ["阶段用时", "最近 3 件事", "审查"]) expect(r.differing).toContain(s);
  } finally { await browser.close(); server.stop(true); }
}, 600_000);

test.skipIf(!out)("team-parity-C old-red/new-green: team-model-fed local hides T2/T3; controlled mutation is caught", async () => {
  if (!out) return;
  const home = generateHomeFixture(), bundle = await bundleHarness(out), teamData = await teamFromHome(home);
  const browser = await launch();
  const legacy = serve(home, teamData, bundle, true), fresh = serve(home, teamData, bundle);
  const pages: Awaited<ReturnType<typeof guardedPage>>[] = [];
  try {
    const one = async (url: string, side: "local" | "team") => {
      const g = await guardedPage(browser, url);
      pages.push(g);
      await g.page.goto(`${url}?side=${side}&project=${home.project}&team=${home.team}`);
      await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
      await openTask(g.page, home, false);
      return { page: g.page, observed: await observeTask(g.page, home) };
    };
    const old = await one(String(legacy.server.url), "local"), now = await one(String(fresh.server.url), "local");
    const { page: teamPage, observed: team } = await one(String(fresh.server.url), "team");
    // 团队详情给「最近 3 件事」「审查」放了「仅主场可见」占位（home_only），旧喂法下本机是空的（absent），两边本来就不一样，不再能当旧红；
    // 仍然成立的是 T2 / T3：契约没有阶段时间线，团队是 absent，旧喂法下本机也是 absent
    const t23 = ["现在·停留时长", "阶段用时"];
    // 旧红：本机由团队模型生成时，本机这两块也是空的 → 两边「一致」，差异检不出；本机期望 present 的比对报 fail
    expect(t23.filter((s) => differing(old.observed, team).includes(s))).toEqual([]);
    expect(compareMatrix("local", old.observed).filter((r) => t23.includes(r.section)).map((r) => r.verdict)).toEqual(["fail", "fail"]);
    // 新绿：本机数据双喂，两块差异都检出，本机期望全部命中
    expect(t23.filter((s) => differing(now.observed, team).includes(s))).toEqual(t23);
    expect(compareMatrix("local", now.observed).filter((r) => t23.includes(r.section)).map((r) => r.verdict)).toEqual(["pass", "pass"]);
    // 受控变异：在真实页面里删掉「最近 3 件事」区块，检测器必须看成 absent、比对必须报 fail（检测器真的在读 DOM）
    await now.page.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "最近 3 件事")?.parentElement?.remove()`);
    const mutated = await observeTask(now.page, home);
    expect(mutated["最近 3 件事"]).toBe("absent");
    expect(compareMatrix("local", mutated).find((r) => r.section === "最近 3 件事")!.verdict).toBe("fail");
    // 受控变异：r1 新增的检测器同样读 DOM——去掉本机详情里的 PR 链接，T12 必须变 absent / fail
    expect(mutated["PR"]).toBe("present");
    await now.page.evaluate(`document.querySelectorAll("aside a[href*='/pull/']").forEach((a) => a.remove())`);
    const noPr = await observeTask(now.page, home);
    expect(compareMatrix("local", noPr).find((r) => r.section === "PR")).toMatchObject({ observed: "absent", verdict: "fail" });
    // 受控变异：团队详情的「审查」是「仅主场可见」占位 = home_only → pass；删掉这个区块，检测器必须看成 absent、比对报 fail
    expect(team["审查"]).toBe("home_only");
    expect(compareMatrix("team", team).find((r) => r.section === "审查")!.verdict).toBe("pass");
    await teamPage.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "审查")?.parentElement?.remove()`);
    const placeholder = await observeTask(teamPage, home);
    expect(compareMatrix("team", placeholder).find((r) => r.section === "审查")).toMatchObject({ observed: "absent", verdict: "fail" });
    // 三个页面（旧本机 / 新本机 / 团队）都在受限上下文里，出站请求为零
    expect(pages.map((g) => ({ external: g.external, errors: g.errors }))).toEqual(pages.map(() => ({ external: [], errors: [] })));
    await Bun.write(resolve(out, "old-red-new-green.json"), JSON.stringify({ legacyLocal: old.observed, homeLocal: now.observed, team, mutated, noPr, placeholder }, null, 2));
  } finally { for (const g of pages) await g.ctx.close(); await browser.close(); legacy.server.stop(true); fresh.server.stop(true); }
}, 180_000);

test.skipIf(!out)("team-parity-Cf1: P1-A gaps gone in the real team page; a restored fake number / home request fails, unresolved gaps still go stale", async () => {
  if (!out) return;
  const home = generateHomeFixture(), bundle = await bundleHarness(out), teamData = await teamFromHome(home);
  const { server } = serve(home, teamData, bundle), browser = await launch(), url = String(server.url);
  const g = await guardedPage(browser, url);
  const verdict = (o: Observed, sec: string) => compareMatrix("team", o).find((r) => r.section === sec)!;
  try {
    const { page, calls } = g;
    await page.goto(`${url}?side=team&project=${home.project}&team=${home.team}`);
    await page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await settle(page);
    // 真实团队页：P1-A 的指标是「暂无」，按删掉 gap 后的矩阵直接 pass
    const metrics: Observed = { "在场 agent": await metric(page, "在场 agent"), "今日完成": await metric(page, "今日完成"), "平均等复核": await metric(page, "平均等复核") };
    expect(Object.keys(metrics).map((k) => verdict(metrics, k).verdict)).toEqual(["pass", "pass", "pass"]);
    // 受控变异：把「今日完成」恢复成 P1-A 之前的假数字 → present → fail（gap 已删，不再有 known_gap 兜底）
    await page.evaluate(`[...document.querySelectorAll("span")].find((e) => e.childElementCount === 0 && e.textContent === "今日完成").previousElementSibling.textContent = "3"`);
    const fake = { ...metrics, "今日完成": await metric(page, "今日完成") };
    expect(verdict(fake, "今日完成")).toMatchObject({ observed: "present", verdict: "fail" });

    // 谁在干活：真实提示「执行操作仍在主场」= home_only → pass；去掉提示 → absent → fail
    await page.getByRole("tab", { name: "谁在干活", exact: true }).first().click();
    await page.getByRole("status").filter({ hasText: "执行操作仍在主场" }).first().waitFor({ timeout: 5000 });
    const work: Observed = { "谁在干活": await observeWork(page) };
    expect(verdict(work, "谁在干活")).toMatchObject({ observed: "home_only", verdict: "pass" });
    await page.evaluate(`[...document.querySelectorAll("[role=status]")].filter((e) => e.textContent.includes("执行操作仍在主场")).forEach((e) => e.remove())`);
    const noHint: Observed = { "谁在干活": await observeWork(page) };
    expect(verdict(noHint, "谁在干活")).toMatchObject({ observed: "absent", verdict: "fail" });

    // 到这里团队页没有任何本机接口请求；受控变异：页面里补发一条本机 peers / last-seen 请求 → 误调 present → fail
    expect(forbidden(calls)).toEqual([]);
    const clean = misCalls(calls, "team", home.project);
    expect(Object.keys(clean).map((k) => verdict(clean, k).verdict)).toEqual(["pass", "pass", "pass"]);
    await page.evaluate(`Promise.all([fetch("/api/v1/peers/contacts"), fetch("/api/v1/me/last-seen/shared-ledger:" + ${JSON.stringify(home.team)})])`);
    const leaked = misCalls(calls, "team", home.project);
    expect(forbidden(calls).length).toBe(2);
    expect([verdict(leaked, "团队标签·本机接口误调").verdict, verdict(leaked, "上次以来·本机接口误调").verdict, verdict(leaked, "谁在干活·本机接口误调").verdict])
      .toEqual(["fail", "fail", "pass"]);

    // 真实详情里「步骤」已有 = pass（gap 已删）；删掉步骤区块 → absent → fail，不再有 known_gap 兜底
    await page.goto(`${url}?side=team&project=${home.project}&team=${home.team}`);
    await page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
    await openTask(page, home, false);
    const task = await observeTask(page, home);
    expect(verdict(task, "步骤线")).toMatchObject({ observed: "present", verdict: "pass" });
    // 没修的 gap 照旧：「参与者」是「仅主场可见」占位 = known_gap（P1-B）；换成真的参与者行（模拟真修好）→ stale_gap，检测没被取消
    expect(verdict(task, "参与者")).toMatchObject({ observed: "home_only", verdict: "known_gap", node: "P1-B" });
    await page.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "参与者").parentElement.innerHTML = "<h5>参与者</h5><div>m-02 执行者</div>"`);
    const fixedPeople = await observeTask(page, home);
    expect(verdict(fixedPeople, "参与者")).toMatchObject({ observed: "present", verdict: "stale_gap", node: "P1-B" });
    await page.evaluate(`[...document.querySelectorAll("aside h5")].find((h) => h.textContent === "步骤")?.parentElement?.remove()`);
    const noSteps = await observeTask(page, home);
    expect(verdict(noSteps, "步骤线")).toMatchObject({ observed: "absent", verdict: "fail" });
    expect({ external: g.external, errors: g.errors }).toEqual({ external: [], errors: [] });
    await Bun.write(resolve(out, "cf1-mutations.json"), JSON.stringify({ metrics, fake, work, noHint, clean, leaked, calls, task, fixedPeople, noSteps }, null, 2));
  } finally { await g.ctx.close(); await browser.close(); server.stop(true); }
}, 120_000);

test.skipIf(!out)("team-parity-Cf1 locale negative probe: an en-US context still reads local G6 as absent (the detector was not loosened)", async () => {
  if (!out) return;
  const home = generateHomeFixture(), bundle = await bundleHarness(out), teamData = await teamFromHome(home);
  const { server } = serve(home, teamData, bundle), browser = await launch(), url = String(server.url);
  const pages: Awaited<ReturnType<typeof guardedPage>>[] = [];
  try {
    const versions = async (locale?: string) => {
      const g = await guardedPage(browser, url, locale ? { locale } : {});
      pages.push(g);
      const first = home.features[0]!;
      await g.page.goto(`${url}?side=local&project=${home.project}&team=${home.team}`);
      await g.page.getByRole("progressbar", { name: first.title, exact: true }).first().waitFor({ timeout: 15_000 });
      await g.page.getByRole("button").filter({ has: g.page.getByText(first.title, { exact: true }) }).first().click();
      await g.page.getByRole("button", { name: /^(版本|v\d+)$/ }).first().click();
      await g.page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).first().waitFor();
      const lang = String(await g.page.evaluate("navigator.language"));
      const rows = await g.page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).allInnerTexts();
      return { lang, rows, g6: versionMeta(rows, false) };
    };
    const zh = await versions(), en = await versions("en-US");
    // 默认上下文 = zh-CN：「10/2 13:00」→ present；en-US：「10/2, 13:00」→ 同一条正则判 absent，本机期望 present 的比对报 fail
    expect({ lang: zh.lang, g6: zh.g6 }).toEqual({ lang: "zh-CN", g6: "present" });
    expect({ lang: en.lang, g6: en.g6, comma: en.rows.every((t) => /\d+\/\d+, \d+:\d+/.test(t)) }).toEqual({ lang: "en-US", g6: "absent", comma: true });
    expect(compareMatrix("local", { "版本元数据（提出人/时间）": en.g6 }).find((r) => r.section === "版本元数据（提出人/时间）")!.verdict).toBe("fail");
    expect(pages.map((g) => ({ external: g.external, errors: g.errors }))).toEqual(pages.map(() => ({ external: [], errors: [] })));
    await Bun.write(resolve(out, "cf1-locale-probe.json"), JSON.stringify({ zh, en }, null, 2));
  } finally { for (const g of pages) await g.ctx.close(); await browser.close(); server.stop(true); }
}, 120_000);

test.skipIf(!out)("team-parity-C egress sentinel: a page in the guarded context cannot reach a second loopback origin", async () => {
  if (!out) return;
  const home = generateHomeFixture(), bundle = await bundleHarness(out), teamData = await teamFromHome(home);
  let hits = 0;
  // 另一个回环端口 = 另一个源：拦截按源判，所以它代表「任何外部地址」，又保证测试本身不出本机
  const sentinel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return new Response("hit"); },
    websocket: { message() {} } });
  const { server } = serve(home, teamData, bundle), browser = await launch();
  const g = await guardedPage(browser, String(server.url));
  try {
    await g.page.goto(`${server.url}?side=team&project=${home.project}&team=${home.team}`);
    await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
    const target = String(sentinel.url), ws = target.replace(/^http/, "ws");
    // 每个探针 3s 内没有结论就记 timeout（断言会红），不让页面里的悬挂拖到用例超时
    const probe = await g.page.evaluate(`(() => {
      const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
      return Promise.all([
        cap(fetch(${JSON.stringify(target)}, { mode: "no-cors" }).then(() => "reached", () => "blocked")),
        cap(new Promise((r) => { const s = new WebSocket(${JSON.stringify(ws)}); s.onopen = () => r("reached"); s.onerror = s.onclose = () => r("blocked"); })),
        cap(new Promise((r) => { const i = new Image(); i.onload = () => r("reached"); i.onerror = () => r("blocked"); i.src = ${JSON.stringify(`${target}img.png`)}; })),
      ]);
    })()`);
    expect({ probe, hits }).toEqual({ probe: ["blocked", "blocked", "blocked"], hits: 0 });
    expect(g.external.map((u) => new URL(u).origin).sort()).toEqual([new URL(target).origin, new URL(target).origin, new URL(ws).origin].sort());
    // 对照：同一个 sentinel 不经过受限上下文时确实能被打到（证明上面的 0 不是 sentinel 本身坏了）
    expect(await (await fetch(target)).text()).toBe("hit");
    expect(hits).toBe(1);
  } finally { await g.ctx.close(); await browser.close(); server.stop(true); sentinel.stop(true); }
}, 120_000);
