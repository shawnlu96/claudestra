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
import { serve, guardedPage, bundleHarness } from "./helpers/collab-fixture-serve";
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, homeProductBoard, homeWorkBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamWorkBoard } from "@/features/collab/team-work-model";
import { countBoardOf, countSnap, featureWords } from "@/features/collab/count-words";
import type { TeamFromHome } from "./web-team-parity-browser-center.test";
import { compareMatrix, differing, MATRIX, unprobed, type MatrixResult, type Observed, type TeamState } from "./helpers/team-parity-matrix";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.TEAM_PARITY_SHOTS_DIR;
/** 手机列表会把已完成的卡折起来：选一张在返工、带 block 审查的卡，桌面 / 手机都能点到 */
const FOCUS = "i28-A5";
/** 第二轮审查中的卡：轮次真值是 2 */
const ROUND_CARD = "i28-B2";
/** 节点卡上的阶段词（只需要焦点卡的；模块进度卡写「返工 · 第 N 轮」） */
const STAGE_WORD: Record<string, string> = { fix: "返工" };


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
    // 团队操作区块里本来就有「全文只在任务所在的机器上」（T14），不能按占位词判
    "团队操作": s["团队操作"] ? "present" : "absent",
    "head": all.includes(head) ? "present" : "absent",
    "PR": /PR #\d+/.test(all) ? "present" : "absent",
    "规格全文": /全文只在任务所在的机器上/.test(all) ? "home_only" : /规格全文/.test(all) ? "present" : "absent",
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

/**
 * 产品卡「在干活 a · 在等 b」的真值（UXNUM1，看板口径 count-words.ts）：本机 = /work 看板；团队 = 团队数据转出的看板（team-work-model.ts，
 * 夹具身份没有主场实例，不换本机行）。按看板行的 feature 归属数，产品卡按标题对上 feature
 */
function cardWords(home: HomeFixture, team: TeamFromHome, side: "local" | "team") {
  const title = home.features[0]!.title;
  if (side === "local") return featureWords(countSnap(countBoardOf(homeWorkBoard(home), false), home.overview), home.features[0]!.id);
  const details = new Map(team.details.map((d) => [d.feature.id, d])), ov = teamOverview(team.list, details, home.now);
  const dag = teamDagBoard(home.project, team.list, details, ov);
  const id = dag.features.find((f) => f.title === title)?.id ?? team.list.features[0]!.id;
  return featureWords(countSnap(countBoardOf(teamWorkBoard(dag, ov.ov, home.now), true), ov.ov), id);
}

/** 首页产品卡（第一个 feature）：进度条、预计完成和本机产品看板真值比；在干活 / 在等和看板口径真值比 */
async function observeProductCard(page: Page, home: HomeFixture, team: TeamFromHome, side: "local" | "team"): Promise<Observed> {
  const truth = homeProductBoard(home).features[0]!, bar = page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first();
  const [now, max] = [await bar.getAttribute("aria-valuenow"), await bar.getAttribute("aria-valuemax")];
  const card = await bar.locator("..").innerText(), w = cardWords(home, team, side);
  return {
    "进度条 counts": Number(now) === truth.counts.completed && Number(max) === truth.counts.total ? "present" : "absent",
    "产品卡·进行中计数": new RegExp(`在干活\\s*${w.working}(\\D|$)`).test(card) && new RegExp(`在等\\s*${w.waiting}(\\D|$)`).test(card) ? "present"
      : /暂无/.test(card) ? "unknown" : "absent",
    "产品卡·预计完成": /预计/.test(card) ? "present" : "absent",
  };
}

/**
 * 模块进度（PROJTABS1 起左大纲删了）：选中模块的节点卡看阶段和轮次（行名沿用「大纲行」），节点处理人照旧按卡上的「· 执行者 / 审查员」判；都按本机真值判。
 * 卡是 [data-focus-key]，按卡上的任务标题找；轮次卡在另一个模块时从面包屑回模块列表再进
 */
async function observeFeaturePage(page: Page, home: HomeFixture, narrow: boolean): Promise<Observed> {
  const lines = (await page.locator("body").innerText()).split("\n");
  const after = (id: string) => lines.flatMap((l, i) => (l === id ? [lines[i + 2] ?? ""] : []));
  const focus = home.details[FOCUS]!.task, roundTask = home.overview.tasks.find((t) => t.id === ROUND_CARD)!;
  const out: Observed = { "节点处理人/步骤": after(FOCUS).some((l) => /· (执行者|审查员)/.test(l)) ? "present" : "absent" };
  if (narrow) return { ...out, "节点阶段（大纲行）": "not_run", "轮次（大纲行）": "not_run" };
  const card = async (title: string) => (await page.locator("[data-focus-key]").filter({ hasText: title }).allInnerTexts()).join("\n");
  const stage = (await card(focus.title)).includes(STAGE_WORD[focus.stage] ?? "?") ? "present" : "absent";
  let roundText = await card(roundTask.title);
  if (!roundText) {
    const f = home.features.find((x) => x.versions.some((v) => v.nodes.some((n) => n.taskId === ROUND_CARD)))!;
    await page.locator("[data-project-pane=module] nav button").first().click();
    await page.locator("[data-module]").filter({ hasText: f.title }).first().click(); // 团队源的模块 id 是中心的，按标题找
    await page.locator("[data-focus-key]").filter({ hasText: roundTask.title }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    roundText = await card(roundTask.title);
  }
  return { ...out, "节点阶段（大纲行）": stage, "轮次（大纲行）": roundText.includes(`第 ${roundTask.round} 轮`) ? "present" : "absent" };
}

/**
 * 谁在干活：看板栏标题「在干活 N」N > 0 才算有数据（大纲里也有卡标题，不能按标题判）；团队视图同一块（WorkBoardContent team，
 * 数据来自 team-work-model.ts）。只放「执行操作仍在主场」状态提示的旧形态 = home_only（只认 role=status 里的这句，
 * 页面别处团队操作区块的同一句不算）；两样都没有 = absent。
 */
async function observeWork(page: Page): Promise<TeamState> {
  const body = await page.locator("body").innerText();
  // 只认看板自己的栏数：顶栏也有「在干活 N」（UXNUM1），删掉看板后不能靠顶栏判 present
  if (/在干活\s*[1-9]/.test((await page.locator("[data-work-board]").allInnerTexts()).join("\n"))) return "present";
  const hint = await page.getByRole("status").filter({ hasText: "执行操作仍在主场" }).count();
  return hint || /仅主场/.test(body) ? "home_only" : "absent";
}

/** §5.1 P1-A 验收线列的本机接口：团队视图里这些请求必须是 0 次 */
const TEAM_FORBIDDEN = [/\/me\/last-seen\//, /\/ledger\/shared-ledger:[^?]*\/work/, /\/team\/(?:activity|roster)\?project=shared-ledger:/, /\/peers\/contacts/, /\/team\/quota/];
const forbidden = (calls: readonly string[]) => calls.filter((c) => TEAM_FORBIDDEN.some((re) => re.test(c)));

/** 误调：看请求记录（本地这几条是正当请求，团队带团队键 / 本机 peers 就是误调） */
function misCalls(calls: readonly string[], side: "local" | "team", project: string): Observed {
  const hit = (re: RegExp) => (calls.some((c) => re.test(c)) ? "present" : "absent") as TeamState;
  const key = side === "team" ? "shared-ledger:" : project;
  return {
    "上次以来·本机接口误调": hit(new RegExp(`/me/last-seen/${key.replace(/[{}]/g, "")}`)),
    "谁在干活·本机接口误调": hit(new RegExp(`/ledger/${key}[^?]*/work`)),
    "团队标签·本机接口误调": side === "team" ? hit(/\/team\/(?:activity|roster)\?project=shared-ledger:|\/peers\/contacts|\/team\/quota/) : hit(/\/peers\/contacts/),
  };
}

/** G6：每个版本行都有提出人和「月/日 时:分」才算 present（正则不因 locale 放宽） */
const versionMeta = (vrows: readonly string[], noHistory: boolean): TeamState =>
  vrows.length ? (vrows.every((t) => /pm-a/.test(t) && /\d+\/\d+ \d+:\d+/.test(t)) ? "present" : "absent") : noHistory ? "unknown" : "absent";

/** 总览数格（overview-tab.tsx data-cell）：暂无 → unknown；数字 → present；整格不出 → absent（PROJTABS1 起顶栏指标条删了） */
async function metric(page: Page, cell: string): Promise<TeamState> {
  const el = page.locator(`[data-cell=${cell}] b`).first();
  if (!(await el.count())) return "absent";
  const text = (await el.innerText()).trim();
  return /暂无/.test(text) ? "unknown" : /^\d+$/.test(text) ? "present" : "absent";
}

/** M2「进行中」= 总览「合并队列」「审查中」两格都有数（count-words.ts 的阶段列） */
async function activeMetric(page: Page): Promise<TeamState> {
  const [a, b] = [await metric(page, "merge"), await metric(page, "review")];
  return a === b ? a : "absent";
}

/** M6 周额度：项目页任何地方写了「周额度」+ 百分比就算 present（PROJTABS1 起两边都不该有） */
async function quotaMetric(page: Page): Promise<TeamState> {
  return /周额度|Claude \d+%/.test(await page.locator("body").innerText()) ? "present" : "absent";
}

/** 项目页上已经没有显示位置的指标（矩阵记 limit） */
const GONE_METRICS = ["在场 agent", "审查轮次", "P0/P1 修掉", "平均等复核"];

/** 冷开落总览：一句话状态出来才算到了 */
const overview = (page: Page) => page.locator("[data-headline]").first().waitFor({ timeout: 15_000 });
/** 「项目地图」标签：等第一个产品卡出来 */
async function toMap(page: Page, home: HomeFixture) {
  await page.locator("[data-project-tab=map]").first().click();
  await page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
}

type Shot = { name: string; png: Buffer };
interface RunResult { observed: Observed; notes: string[]; calls: string[]; external: string[]; errors: string[] }

async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

/** 项目地图点焦点卡所在的模块，进模块进度再点那张卡（PROJTABS1 起桌面没有大纲，和手机同一条路） */
async function openTask(page: Page, home: HomeFixture, _narrow: boolean) {
  const task = home.details[FOCUS]!.task;
  await toMap(page, home);
  const f = home.features.find((x) => x.id === task.itemId)!;
  await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
  await page.getByText(task.title, { exact: true }).first().click();
  await page.locator("aside h5", { hasText: "现在" }).first().waitFor();
  // 详情是异步读的：等到「正在读取…」消失再测
  await page.waitForFunction(`![...document.querySelectorAll("aside")].some((a) => a.innerText.includes("正在读取"))`);
  await settle(page);
}

async function runSide(browser: Browser, url: string, home: HomeFixture, team: TeamFromHome, width: number, theme: "light" | "dark", side: "local" | "team", shots: Shot[],
  dir: string | null): Promise<RunResult> {
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
    // PROJTABS1：冷开落总览（待办、上次来之后、数格都在这里，桌面手机同一套）；产品卡在「项目地图」
    await overview(page);
    await ready;
    await settle(page);
    for (const m of GONE_METRICS) observed[m] = "not_run";
    // 数字一次出（UXNUM1）：先等骨架退掉再测；读不到看板的源两格整格不出，等到超时照实记
    await page.locator("[data-cell=merge] b").filter({ hasText: /^\d+$/ }).first().waitFor({ timeout: 25_000 }).catch(() => notes.push(`${side}: 总览数格 25s 内没出数`));
    observed["今日完成"] = await metric(page, "todayDone");
    observed["进行中"] = await activeMetric(page);
    observed["周额度"] = await quotaMetric(page);
    // 总览「要你定的」：读不到（团队键解析不出本机项目）→ unknown；列出或写「没有要你定的」→ present
    const asks = String(await page.evaluate(`[...document.querySelectorAll("h5")].find((e) => e.textContent === "要你定的")?.parentElement?.innerText ?? ""`));
    observed["待你处理"] = (await page.locator("[data-waits=unknown]").count()) ? "unknown" : asks ? "present" : "absent";
    observed["上次以来"] = (await page.getByRole("region", { name: "上次来之后" }).count()) ? "present" : "absent";
    // 只看焦点卡的要你定的：本机列出 i28-A7 的阻塞提问；团队按投影 asks 应给「阻塞 N」，现在是「没有」
    observed["阻塞提问"] = /i28-A7|阻塞\s*\d/.test(asks) ? "present" : /暂无/.test(asks) ? "unknown" : "absent";
    // UXHOME1：新鲜度只在页头那一行「团队版 · …」（collab-page-head.tsx，桌面 / 手机都有）；本机源没有这一行
    const head = page.locator("[data-collab-head]");
    observed["镜像新鲜度"] = (await head.count()) && /^团队版 · .*(同步|不是最新|还没收到)/.test((await head.first().innerText()).trim()) ? "present" : "absent";
    const tabs = (await page.locator("[data-project-tab]").allInnerTexts()).map((t) => t.trim());
    const four = ["总览", "项目地图", "模块进度", "团队"].every((t) => tabs.includes(t));
    // 桌面中区标签（N2）= 四个标签里有模块进度和团队；手机顶栏按钮（N3）被四个标签取代 = 手机上四个都在
    observed["桌面中区标签"] = narrow ? "not_run" : four ? "present" : "absent";
    observed["手机顶栏按钮"] = narrow ? (four ? "present" : "absent") : "not_run";
    await shot("home");
    await toMap(page, home);
    await settle(page);
    observed["产品 DAG 卡片"] = "present";
    await page.locator("[data-product-words=working]").filter({ hasText: /\d/ }).first().waitFor({ timeout: 25_000 });
    Object.assign(observed, await observeProductCard(page, home, team, side));
    await shot("map");

    await openTask(page, home, narrow);
    Object.assign(observed, await observeTask(page, home));
    await shot("task");
    observed["依赖边·建立者/时间"] = await observeEdge(page);
    await shot("edge");
    await page.keyboard.press("Escape");

    // 版本页 / 对比页：进 feature 的子 DAG，点「版本」，再点「对比」（默认上一版 → 当前版）
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    await overview(page);
    await toMap(page, home);
    await page.getByRole("button").filter({ has: page.getByText(first.title, { exact: true }) }).first().click();
    await page.getByText(home.details[FOCUS]!.task.title, { exact: true }).first().waitFor();
    observed["子 DAG 节点"] = "present";
    Object.assign(observed, await observeFeaturePage(page, home, narrow));
    if (narrow) notes.push("390：G3 / G10 轮次在桌面模块进度测，手机记 not_run（节点处理人照测）");
    // 轮次卡在别的模块时 observeFeaturePage 换过模块：回到焦点卡所在模块再点版本
    if (!(await page.getByText(home.details[FOCUS]!.task.title, { exact: true }).count())) {
      await page.locator("[data-project-pane=module] nav button").first().click();
      await page.locator("[data-module]").filter({ hasText: first.title }).first().click();
    }
    await page.getByRole("button", { name: /^(版本|v\d+)$/ }).first().click();
    await page.getByRole("button", { name: "对比", exact: true }).first().waitFor();
    await page.waitForFunction(`!document.body.innerText.includes("正在读取")`, undefined, { timeout: 5000 })
      .catch(() => notes.push(`${side}: 版本页 5s 后仍是「正在读取…」`));
    const rows = await page.locator("button[aria-pressed]").filter({ hasText: /^v\d/ }).count();
    // 只认版本页自己的「暂无历史版本」（P1-F 的文案）：页面别处本来就可能有「暂无」
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

    // 谁在干活 = 「模块进度」的「按人」；团队 = 「团队」标签（PROJTABS1：桌面手机同一套）
    await page.goto(`${url}?side=${side}&theme=${theme}&project=${home.project}&team=${home.team}`);
    await overview(page);
    await page.locator("[data-project-tab=module]").first().click();
    const workTab = page.getByRole("tab", { name: "按人", exact: true });
    if (await workTab.count()) {
      await workTab.first().click();
      await page.waitForFunction(`/在干活\\s*[1-9]|仅主场|执行操作仍在主场/.test(document.body.innerText)`, undefined, { timeout: 5000 })
        .catch(() => notes.push(`${side}: 谁在干活 5s 内没有在干活的卡，也没有主场占位`));
      observed["谁在干活"] = await observeWork(page);
      await shot("work");
    } else { observed["谁在干活"] = "not_run"; notes.push(`${width}: 模块进度里没有「按人」入口`); }
    const teamBtn = page.locator("[data-project-tab=team]");
    const peers = page.waitForResponse((r) => r.url().includes("/api/v1/peers/contacts"), { timeout: 5000 })
      .catch(() => notes.push(`${side}: 团队标签 5s 内没有请求本机 peers`));
    await teamBtn.first().click();
    await peers;
    const childTab = page.getByRole("tab", { name: side === "local" ? "往来" : "规划与提案", exact: true });
    if (await childTab.count()) await childTab.click();
    await settle(page);
    observed["团队成员卡（本机 peers）"] = (await page.locator("body").innerText()).includes("peer-mac") ? "present" : "absent";
    observed["团队规划"] = (await page.getByText("团队规划", { exact: true }).count()) ? "present" : "absent";
    await shot("team");
  } finally { await ctx.close(); }
  Object.assign(observed, misCalls(calls, side, home.project));
  return { observed, notes, calls, external, errors };
}


const launch = () => chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });

test.skipIf(!out)("team-parity-C: same home ledger fed to local and team, 1200/390 × light/dark matrix against §3", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), bundle = await bundleHarness(out), teamData = await teamFromHome(home);
  const { server, unexpected } = serve(home, teamData, bundle);
  const browser = await launch(), shots: Shot[] = [];
  const report: { scenario: string; matrix: { section: string; ref: string; local: TeamState | "not_run"; team: TeamState | "not_run"; limit?: string }[];
    results: MatrixResult[]; differing: string[]; notes: string[]; forbidden: { team: string[] } }[] = [];
  const seen: { local: Observed[]; team: Observed[] } = { local: [], team: [] };
  try {
    for (const width of [1200, 390]) for (const theme of ["light", "dark"] as const) {
      const local = await runSide(browser, String(server.url), home, teamData, width, theme, "local", shots, out);
      const team = await runSide(browser, String(server.url), home, teamData, width, theme, "team", shots, out);
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
    // UXINBOX1：团队视图为「待你处理」读一次本机绑定（/shared-ledger/context）。夹具里本人不在任何共享项目里，回 404 = 没绑定，
    // 团队键解析不出本机项目，「待你处理」照旧是「暂无」（矩阵那一行不变）；这一条读取不算夹具外的请求
    expect(unexpected.filter((u) => u !== "GET /api/v1/shared-ledger/context" && u !== "GET /api/v1/team/roster")).toEqual([]);
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
      await overview(g.page);
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
    await overview(page);
    await settle(page);
    // 真实团队页：没数据的指标整格不出（UXNUM1，absent），按矩阵直接 pass；PROJTABS1 起只剩总览「今天完成」这一格可测
    await page.locator("[data-cell=merge] b").filter({ hasText: /^\d+$/ }).first().waitFor({ timeout: 25_000 });
    const metrics: Observed = { "今日完成": await metric(page, "todayDone") };
    expect(Object.keys(metrics).map((k) => verdict(metrics, k).verdict)).toEqual(["pass"]);
    // 受控变异：在总览补回一格假的「今天完成 3」→ present → fail（检测器真的在读总览数格）
    await page.evaluate(`document.querySelector("[data-overview]").insertAdjacentHTML("afterbegin", "<span data-cell=todayDone><b>3</b><span>今天完成</span></span>")`);
    const fake = { ...metrics, "今日完成": await metric(page, "todayDone") };
    expect(verdict(fake, "今日完成")).toMatchObject({ observed: "present", verdict: "fail" });

    // 谁在干活：团队只读列表（N8B5）有在干活的卡 = present → pass；受控变异：删掉团队这一块 → absent → fail
    await page.locator("[data-project-tab=module]").first().click();
    if (await page.getByRole("tab", { name: "按人", exact: true }).count()) await page.getByRole("tab", { name: "按人", exact: true }).first().click();
    await page.locator("[data-work-board=team]").first().waitFor({ timeout: 5000 });
    await page.waitForFunction(`/在干活\\s*[1-9]/.test(document.body.innerText)`, undefined, { timeout: 5000 });
    const work: Observed = { "谁在干活": await observeWork(page) };
    expect(verdict(work, "谁在干活")).toMatchObject({ observed: "present", verdict: "pass" });
    await page.evaluate(`document.querySelectorAll("[data-work-board=team]").forEach((e) => e.remove())`);
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
    await overview(page);
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
      await overview(g.page);
      await toMap(g.page, home);
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
    await overview(g.page);
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
