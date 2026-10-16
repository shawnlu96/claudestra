/**
 * team-parity-A（docs/team/team-collab-parity-plan.md §5.1 P1-A）：同一个 CollabView 真挂到 happy-dom（React 19），
 * 一边是本机源，一边经 TeamSource 注入团队源（走真的共享读口 /shared-ledger/features*）。全部 fetch 都被这里拦下记路径，
 * 不连任何真 bridge。数据是同一份合成本机台账，按 mirrorTaskProjections 的字段规则投影成团队数据（stage / sourceTaskId /
 * fullText=home_only，assigneeCode 缺 meta 为 null，指标与完成时刻不出境，observedAt = 镜像刷新时刻 = 此刻）。
 *
 * 旧红新绿：main 上团队视图会用团队键请求 /me/last-seen/shared-ledger:…、/ledger/shared-ledger:…/work、
 * /team/activity?project=shared-ledger:…、/peers/contacts、/team/quota，并把 observedAt 当完成时刻显示「今日完成 3」；
 * 修完这些请求为 0。PROJTABS1 起项目页没有指标条和大纲：总览只出有来源的数格（团队不知道的今天完成整格不出），
 * 「要你定的」读不到时写读不到 + 重试；谁在干活在「模块进度 · 按人」。本机同数据的数字与请求路径保持不变。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; title: string; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }

// 根 tsc 没有 --jsx：组件在运行时由 bun 转译加载
const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let i18n: { setLang(l: "zh" | "en"): void };
/** project-tabs/tab-request.ts：同一项目记住上次的标签（模块级），每个用例冷开前清回「总览」 */
let rememberTab: (project: string, tab: string) => void;
let ui: {
  CollabView: (p: { project: string }) => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown;
  TeamSource: (p: { identity: Identity; children: unknown }) => unknown;
  sharedCollabProject: (i: Identity) => string;
};
interface Identity { center: string; team: string; person: string; project: string; machine: string }

const PROJECT = "parity-proj";
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local" };
const NOW = Date.now();
/** 3 张今天完成的卡；跨午夜跑也落在今天 */
const DONE_AT = Math.max(NOW - 1000, new Date(NOW).setHours(0, 0, 0, 1));

/** 合成本机台账：3 张今日完成（各 1 轮审查、1 个 P1）、1 张开发中、1 张在等审查（2 轮、已等 2 分钟） */
function homeLedger(): LedgerOverview {
  const done = (id: string): LedgerTaskView => ({ id, itemId: "F1", title: `已完成 ${id}`, kind: "code", stage: "done", round: 1, agent: null, pm: null,
    updatedAt: DONE_AT, metrics: { startTs: DONE_AT - 3_600_000, endTs: DONE_AT, reviewRounds: 1, p0: 0, p1: 1, p2: 0, reviewWaitPendingMs: null } });
  return {
    exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "对照事项 parity", oneLine: "同源双喂" }],
    tasks: [done("D1"), done("D2"), done("D3"),
      { id: "B1", itemId: "F1", title: "开发中的卡", kind: "code", stage: "build", round: 0, agent: null, pm: null, updatedAt: NOW, metrics: {} },
      { id: "R1", itemId: "F1", title: "在等审查的卡", kind: "code", stage: "review", round: 2, agent: null, pm: null, updatedAt: NOW,
        metrics: { reviewRounds: 2, reviewWaitPendingMs: 120_000 } }],
    deps: [],
  };
}

/** 同一份台账按 mirrorTaskProjections（src/lib/shared-ledger-projector.ts）的字段规则投影：只出 stage / 卡号 / pr / deps，指标与完成时刻不出境 */
function project(home: LedgerOverview): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const feature = { id: "F1", projectId: PROJECT, title: home.items[0]!.title, description: home.items[0]!.oneLine, rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: "home-1", executorInstanceIds: ["home-1"], status: "active" as const,
    counts: { total: home.tasks.length, completed: 3, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: "home-1", sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const tasks = home.tasks.map((t, i) => ({ taskId: `task-${i}`, sourceTaskId: t.id, sourceRev: 1, sourceSeq: 9, stage: t.stage, assigneeCode: null,
    executorInstanceId: "home-1", pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] }));
  const detail: FeatureDetail = { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: home.tasks.map((t) => ({ key: t.id, oneLine: t.title, deps: [], fileGlobs: [], estimate: "" })),
      bindings: home.tasks.map((t, i) => ({ nodeKey: t.id, taskId: `task-${i}` })) }, tasks } as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, features: [feature] } as FeatureList, detail };
}

const calls: string[] = [];
const realFetch = globalThis.fetch;
/** 团队那一份夹具（UXHOME1 的页头用例要改它的镜像观测时刻；list 与 detail 里是同一个 feature 对象） */
let fixture: ReturnType<typeof project>;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const home = homeLedger(), team = project(home);
  fixture = team;
  // 只回环夹具：拦下全部请求，记下解码后的路径；夹具之外一律 404，不出网
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = decodeURIComponent(url.pathname + url.search);
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    if (url.pathname === "/api/v1/asks") return json({ ok: true, asks: [], full: true, now: NOW }); // 完整的空列表 = 已知 0（UXCARD3：不完整且为空算不知道）
    if (url.pathname === "/api/v1/shared-ledger/features") return json(team.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  // 生产由外壳 start 待办 store；这里读一次完整的空列表，本机「待你处理」才是已知 0（UXCARD3：没读到算不知道）
  await (await import(mod("asks/asks-store.ts"))).asksStore.refresh();
  i18n = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href);
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const nav = await import(mod("collab/dag/shared-navigation.tsx"));
  ({ rememberTab } = await import(mod("collab/project-tabs/tab-request.ts")));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: nav.sharedCollabProject };
});

/** 本文件挂上的根：用例中途失败（含 mount 里等不到首屏）也在 afterEach 卸掉，先卸根、afterAll 再注销 happy-dom */
const live = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const off of [...live]) await off();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null); // 模块级缓存：别把夹具的 app-config 留给后面的测试文件
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}: ${(doc.body.textContent ?? "").slice(0, 400)}`);
}

async function mount(side: "local" | "team", width: number) {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  calls.length = 0;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await React.act(async () => root.unmount());
    host.remove();
  };
  live.add(unmount);
  const h = React.createElement as (...a: unknown[]) => unknown;
  rememberTab(PROJECT, "overview");
  rememberTab(ui.sharedCollabProject(IDENTITY), "overview");
  const collab = side === "team"
    ? h(ui.TeamSource, { identity: IDENTITY }, h(ui.CollabView, { project: ui.sharedCollabProject(IDENTITY) }))
    : h(ui.CollabView, { project: PROJECT });
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, collab) as never));
  // 冷开落总览：一句话状态出来、待办读完（要你定的写了「没有」或「读不到」）才算就绪
  const text = () => host.textContent ?? "";
  await until(() => !!host.querySelector("[data-headline]") && (!!host.querySelector("[data-waits=unknown]") || /没有要你定的|Nothing needs your call/.test(text())), `${side} view`);
  const buttons = () => Array.from(host.querySelectorAll("button,[role=tab]"));
  const click = async (label: string) => {
    const b = buttons().find((x) => (x.textContent ?? "").trim().startsWith(label));
    if (!b) throw new Error(`no ${label} button`);
    await React.act(async () => b.click());
    await tick(200);
  };
  return {
    host, click,
    /** 总览数格（overview-tab.tsx data-cell）：值；整格不出 = null */
    cell: (key: string) => host.querySelector(`[data-cell=${key}] b`)?.textContent ?? null,
    /** 谁在干活：「模块进度」标签里的「按人」分段（没有可列的模块时直接就是按人） */
    work: async () => {
      const tab = buttons().find((x) => /^(模块进度|Module progress)$/.test((x.textContent ?? "").trim()));
      if (!tab) throw new Error("no module tab");
      await React.act(async () => tab.click());
      await tick(200);
      const person = buttons().find((x) => /^(按人|By person)$/.test((x.textContent ?? "").trim()));
      if (person) { await React.act(async () => person.click()); await tick(200); }
    },
    button: (label: string) => buttons().find((x) => (x.textContent ?? "").trim().startsWith(label)) ?? null,
    unmount,
  };
}

/** 团队视图不得用团队键碰的本机接口（P1-A 验收线） */
const LOCAL_ONLY = [/\/me\/last-seen\/shared-ledger:/, /\/ledger\/shared-ledger:.*\/work/, /\/team\/activity\?project=shared-ledger:/, /\/peers\/contacts/, /\/team\/quota/];

test("复现测试:团队 CollabView 不再请求本机 last-seen / 谁在干活 / 团队标签接口", async () => {
  const v = await mount("team", 1200);
  await v.work();
  await v.click("团队");
  await v.click("规划与提案");
  await tick(300);
  const hits = calls.filter((c) => LOCAL_ONLY.some((re) => re.test(c)));
  expect(hits).toEqual([]);
  // 合法团队读口照常（同一会话、同一路径）
  expect(calls).toContain("GET /api/v1/shared-ledger/features");
  expect(calls).toContain("GET /api/v1/shared-ledger/features/F1");
  // 团队标签只留团队规划，没有本机成员卡；谁在干活给主场提示
  expect(v.host.textContent).toContain("团队规划");
  expect(v.host.textContent).not.toContain("最近 10 分钟");
  await v.unmount();
});

test("复现测试:团队 3 张 done、observedAt=now 不显示今日完成 3", async () => {
  const v = await mount("team", 1200);
  // 夹具 3 张 done 的镜像刚刷新（observedAt = 此刻）：observedAt 不是完成时刻，不能数成「今日完成 3」
  // UXNUM1：不知道的指标整格不出（不是 3，也不是「暂无」）；总览「今天完成」同一规则
  expect(v.cell("todayDone")).toBeNull();
  await v.unmount();
});

test("复现测试:团队未知指标整格不出；要你定的读不到时写读不到 + 重试，区别于本机「没有」", async () => {
  const v = await mount("team", 1200);
  // PROJTABS1：项目页没有指标条，在场 / 审查轮次 / P0P1 / 平均等复核不再出；总览只出有来源的格
  expect(v.host.querySelector("[data-metrics], [data-metric]")).toBeNull();
  expect(v.cell("todayDone")).toBeNull();
  expect([v.cell("merge"), v.cell("review")].every((x) => /^\d+$/.test(x ?? ""))).toBe(true);
  expect(v.host.querySelector("[data-waits=unknown]")?.textContent).toBe("读不到 重试");
  expect(v.host.textContent).not.toContain("暂无");
  await v.unmount();
});

test("复现测试:团队手机同一套总览：要你定的读不到，不碰本机接口", async () => {
  const v = await mount("team", 390);
  expect(v.host.querySelector("[data-waits=unknown]")?.textContent).toBe("读不到 重试");
  expect(v.button("待你处理")).toBeNull();
  expect(calls.filter((c) => LOCAL_ONLY.some((re) => re.test(c)))).toEqual([]);
  await v.unmount();
});

test("防回归:本机同一份台账数字、请求路径保持（last-seen / 谁在干活 / 团队标签照常读）", async () => {
  const v = await mount("local", 1200);
  expect(v.cell("todayDone")).toBe("3");
  expect(v.host.textContent).toContain("没有要你定的");
  expect(v.host.querySelector("[data-waits=unknown]")).toBeNull();
  await v.work();
  await v.click("团队");
  await tick(300);
  const paths = [...new Set(calls.map((c) => c.replace(/dayStart=\d+/, "dayStart=*").replace(/\?events=.*$/, "?events=*")))].sort();
  for (const p of [`GET /api/v1/ledger/${PROJECT}?dayStart=*`, `GET /api/v1/me/last-seen/${PROJECT}?events=*`, `GET /api/v1/ledger/${PROJECT}/work`,
    `GET /api/v1/team/activity?project=${PROJECT}`, "GET /api/v1/peers/contacts", "GET /api/v1/team/quota"]) expect(paths).toContain(p);
  await v.unmount();
});

test("防回归:本机手机今日完成分组照旧列 3 张", async () => {
  const v = await mount("local", 390);
  expect(v.cell("todayDone")).toBe("3");
  // 本机没有产品看板：手机「项目地图」退回分组列表
  await v.click("项目地图");
  const h = Array.from(v.host.querySelectorAll("h5")).map((x) => (x.textContent ?? "").replace(/\s+/g, " ").trim());
  expect(h).toContain("今日完成 3");
  await v.unmount();
});

test("复现测试:英文模式团队谁在干活是只读列表、界面词不漏中文；要你定的读不到走英文", async () => {
  i18n.setLang("en");
  try {
    const EXEC = "View and plan only here; start and merge on the machine running the task";
    const v = await mount("team", 1200);
    const waits = v.host.querySelector("[data-waits=unknown]")?.textContent;
    await v.work();
    // 团队「谁在干活」是只读列表（PM 定 1）：栏名、分段、分组、镜像标注走英文词条，界面词不漏中文（卡标题是夹具数据，不在检查范围）
    const el = v.host.querySelector("[data-work-board=team]");
    const chrome = el ? Array.from(el.querySelectorAll("h3, [role=tab]")).map((x) => x.textContent ?? "").join("|") : "";
    const board = el?.textContent ?? "";
    const work = { board: ["Working", "Waiting", "To do", "Sync ·", "Ready to start ·"].every((w) => board.includes(w)), zhUi: /[\u4e00-\u9fff]/.test(chrome),
      hint: (v.host.querySelector("[role=status] p")?.textContent ?? "").includes(EXEC) };
    const zhLeft = (v.host.textContent ?? "").includes("执行操作仍在主场");
    await v.unmount();
    const m = await mount("team", 390);
    const phone = m.host.querySelector("[data-waits=unknown]")?.textContent;
    await m.unmount();
    expect({ waits, work, zhLeft, phone }).toEqual({ waits: "Couldn't read Retry", work: { board: true, zhUi: false, hint: false }, zhLeft: false, phone: "Couldn't read Retry" });
  } finally {
    i18n.setLang("zh");
  }
});

test("复现测试:英文模式团队未知数值整格不出（不回落中文「暂无」），本机已知数字不变", async () => {
  i18n.setLang("en");
  try {
    const v = await mount("team", 1200);
    const team = { today: v.cell("todayDone"), zh: /暂无/.test(v.host.textContent ?? ""), tabs: tabs(v.host).slice(0, 4) };
    await v.unmount();
    expect(team).toEqual({ today: null, zh: false, tabs: ["Overview", "Project map", "Module progress", "Team"] });
    // 本机同数据：已知数字照旧，要你定的是「没有」
    const l = await mount("local", 1200);
    expect(l.cell("todayDone")).toBe("3");
    expect(l.host.textContent).toContain("Nothing needs your call");
    await l.unmount();
  } finally {
    i18n.setLang("zh");
  }
});

/** 页头那一行（collab-page-head.tsx）；本机源没有 */
const headLine = (host: El) => host.querySelector("[data-collab-head]");
const tabs = (host: El) => Array.from(host.querySelectorAll("[role=tab]")).map((x) => (x.textContent ?? "").trim());
const mirrorSec = (host: El) => Array.from(host.querySelectorAll("section")).find((x) => x.querySelector("h5")?.textContent === "镜像");

test("[验收线 5] 团队视图页头写『团队版 · N 分钟前同步』，右栏没有『镜像』节；标签叫『团队』，规划在子标签、不读本机往来", async () => {
  const v = await mount("team", 1200);
  await until(() => headLine(v.host) !== null, "page head line");
  expect([headLine(v.host)!.getAttribute("data-collab-head"), headLine(v.host)!.textContent]).toEqual(["fresh", "团队版 · 刚刚同步"]);
  expect(mirrorSec(v.host)).toBeUndefined();
  expect(v.host.textContent).not.toMatch(/主场镜像/);
  expect(tabs(v.host)).toContain("团队");
  expect(tabs(v.host)).not.toContain("规划与提案");
  await v.click("团队");
  await v.click("规划与提案");
  expect(v.host.textContent).toContain("团队规划");
  expect(v.host.textContent).not.toMatch(/最近 10 分钟|加载团队|peer-mac/);
  await v.unmount();
});

test("[验收线 5] 有过期：页头写过期个数（按钮），点开原地列出过期的那几个，再点收起；一份都没收到写还没收到", async () => {
  const feature = fixture.list.features[0]!, was = feature.projection;
  try {
    feature.projection = { ...was!, observedAt: NOW - 30 * 60_000, receivedAt: NOW - 30 * 60_000 };
    const v = await mount("team", 1200);
    await until(() => headLine(v.host)?.getAttribute("data-collab-head") === "stale", "stale head line");
    const line = headLine(v.host)!, list = v.host.querySelector("[data-collab-head-stale]")!;
    expect([line.textContent, line.getAttribute("aria-expanded"), list.hasAttribute("inert")]).toEqual(["团队版 · 1 个模块的进度可能不是最新的", "false", true]);
    await React.act(async () => line.click());
    expect([line.getAttribute("aria-expanded"), list.hasAttribute("inert"), list.textContent]).toEqual(["true", false, "对照事项 parity"]);
    await React.act(async () => line.click());
    expect([line.getAttribute("aria-expanded"), list.hasAttribute("inert")]).toEqual(["false", true]);
    expect(mirrorSec(v.host)).toBeUndefined();
    await v.unmount();

    feature.projection = null as never;
    const n = await mount("team", 1200);
    await until(() => headLine(n.host) !== null, "empty head line");
    expect([headLine(n.host)!.getAttribute("data-collab-head"), headLine(n.host)!.textContent]).toEqual(["none", "团队版 · 还没收到任务所在机器的进度"]);
    await n.unmount();
  } finally {
    feature.projection = was;
  }
});

test("[验收线 5] 手机：团队源四个标签都在，「团队」标签直接是名册（不再走顶栏按钮整屏页），页头同样写团队版", async () => {
  const v = await mount("team", 390);
  await until(() => headLine(v.host) !== null, "page head line");
  expect(headLine(v.host)!.textContent).toBe("团队版 · 刚刚同步");
  expect(tabs(v.host).slice(0, 4)).toEqual(["总览", "项目地图", "模块进度", "团队"]);
  expect(v.button("规划与提案")).toBeNull();
  await v.click("团队");
  expect(v.host.querySelector("[data-project-pane=team]")).not.toBeNull();
  expect(v.host.textContent ?? "").not.toContain("最近 10 分钟的真实往来");
  await v.unmount();
});

test("[验收线 5] 本机源请求不变：页头只有项目名，桌面手机标签都叫『团队』，成员面板照常读本机接口", async () => {
  const v = await mount("local", 1200);
  expect(headLine(v.host)).toBeNull();
  expect(v.host.textContent).not.toMatch(/团队版|规划与提案/);
  expect(tabs(v.host)).toContain("团队");
  await v.click("团队");
  await tick(300);
  expect(calls).toContain("GET /api/v1/peers/contacts"); // 成员面板在
  await v.unmount();
  const m = await mount("local", 390);
  expect(headLine(m.host)).toBeNull();
  expect(m.button("规划与提案")).toBeNull();
  await m.click("团队");
  expect(m.host.querySelector("[data-project-pane=team]")).not.toBeNull();
  expect(m.host.textContent ?? "").not.toContain("规划与提案");
  await m.unmount();
});
