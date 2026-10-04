/**
 * team-parity-B（docs/team/team-collab-parity-plan.md §5.1 P1-B）：真组件挂到 happy-dom（React 19）。
 * ① 边页 DepBody：团队边（建立者 / 时间 = null）显示「建立者 / 时间未记录」，不出 1970 / Invalid Date / 空名字；本机完整边文字逐字不变。
 * ② 同一个 CollabView：本机源和经 TeamSource 注入的团队源吃同一份合成台账（团队侧按 mirrorTaskProjections 的字段规则投影，
 *    多给成员代号、执行实例、head、步骤、阻塞提问）。团队详情显示「团队」段（代号、主场实例、8 位 head、阻塞提问、镜像）和步骤线，
 *    不出「打开会话 / 对它说」；本机详情没有这一段。全部 fetch 被这里拦下，夹具之外 404，不连真 bridge。
 * 旧红新绿：main 上团队边显示 feature 修改人「person-a 建于 …」、详情没有代号 / 步骤线 / 阻塞提问 / 镜像。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerDepView, LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; title: string; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }
interface Identity { center: string; team: string; person: string; project: string; machine: string }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let i18n: { setLang(l: "zh" | "en"): void };
let ui: {
  CollabView: (p: { project: string }) => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown;
  TeamSource: (p: { identity: Identity; children: unknown }) => unknown;
  sharedCollabProject: (i: Identity) => string;
  EdgePage: (p: { deps: LedgerDepView[]; ov: LedgerOverview; onPick: (id: string) => void; onClose: () => void; tr: (s: string, p?: Record<string, string | number>) => string }) => unknown;
  hhmm: (ms: number) => string;
  TeamFactsSec: (p: { id: string; ov: Pick<LedgerOverview, "tasks">; tr: (s: string, p?: Record<string, string | number>) => string }) => unknown;
  Overview: (p: Record<string, unknown>) => unknown;
  homeView: (ov: LedgerOverview, now: number) => unknown;
  openCollabTask: (id: string | null) => void;
  zh: (s: string, p?: Record<string, string | number>) => string;
};

const PROJECT = "edge-proj";
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local" };
const NOW = Date.now();
const HOME = "0f1e2d3c-4b5a-4968-a7b6-c5d4e3f2a1b0";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const T_CREATED = Date.UTC(2026, 8, 30, 3, 4), T_UPDATED = Date.UTC(2026, 9, 1, 5, 6);

/** 合成本机台账：W1 在开发、R1 在等审查（依赖 W1，本机边带建立者 / 时间） */
function homeLedger(): LedgerOverview {
  const t = (id: string, stage: LedgerTaskView["stage"], title: string): LedgerTaskView =>
    ({ id, itemId: "F1", title, kind: "code", stage, round: stage === "review" ? 2 : 0, agent: null, pm: null, updatedAt: NOW, metrics: {} });
  return {
    exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "边与字段对照 edge parity", oneLine: "同源双喂" }],
    tasks: [t("W1", "build", "开发中的前置卡"), t("R1", "review", "在等审查的卡：一个很长很长的标题，用来看换行和截断是否正常 long title")],
    deps: [{ from: "W1", to: "R1", kind: "blocks", when: "", state: null, derived: "active", effective: "active", createdBy: "pm-a", createdAt: T_CREATED, updatedAt: T_UPDATED }],
  };
}

/** mirrorTaskProjections 的字段规则：stage / 卡号 / deps 原样；成员代号、执行实例、head、步骤、提问照读口给，指标与完成时刻不出境 */
function project(home: LedgerOverview): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const feature = { id: "F1", projectId: PROJECT, title: home.items[0]!.title, description: home.items[0]!.oneLine, rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const,
    counts: { total: 2, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const tasks = [
    { taskId: "task-0", sourceTaskId: "W1", sourceRev: 1, sourceSeq: 9, stage: "build", assigneeCode: null, executorInstanceId: null, pr: null, head: null,
      deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] },
    { taskId: "task-1", sourceTaskId: "R1", sourceRev: 1, sourceSeq: 9, stage: "review", assigneeCode: "worker-a", executorInstanceId: HOME, pr: null, head: HEAD,
      deps: ["W1"], specSummary: "", specDigest: null, fullText: "home_only" as const,
      steps: [{ sourceStepId: "write:1", sourceRev: 1, sourceSeq: 9, state: "done" }, { sourceStepId: "review:1", sourceRev: 1, sourceSeq: 9, state: "done" },
        { sourceStepId: "fix:1", sourceRev: 1, sourceSeq: 9, state: "done" }, { sourceStepId: "review:2", sourceRev: 1, sourceSeq: 9, state: "assigned" }],
      asks: [{ kind: "question", state: "open", blocking: true }, { kind: "question", state: "answered", blocking: true }] },
  ];
  const detail = { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: [{ key: "W1", oneLine: home.tasks[0]!.title, deps: [], fileGlobs: ["a/**"], estimate: "" },
      { key: "R1", oneLine: home.tasks[1]!.title, deps: ["W1"], fileGlobs: ["b/**"], estimate: "" }],
      bindings: [{ nodeKey: "W1", taskId: "task-0" }, { nodeKey: "R1", taskId: "task-1" }] }, tasks } as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, features: [feature] } as FeatureList, detail };
}

const calls: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const home = homeLedger(), team = project(home);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname + url.search)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    if (url.pathname === `/api/v1/ledger/${PROJECT}/tasks/R1`) return json({ ok: true, task: home.tasks[1], events: [], timeline: [], now: NOW });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(team.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  i18n = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href);
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const nav = await import(mod("collab/dag/shared-navigation.tsx"));
  const props = await import(mod("collab/v4/v4-props.tsx"));
  const cnav = await import(mod("collab/collab-nav.ts"));
  const fill = await import(new URL("../web/lib/i18n-fill.ts", import.meta.url).href);
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: nav.sharedCollabProject,
    EdgePage: props.EdgePage, hhmm: props.hhmm, TeamFactsSec: props.TeamFactsSec, Overview: props.Overview,
    homeView: (await import(mod("collab/collab-model.ts"))).homeView, openCollabTask: cnav.openCollabTask, zh: fill.fillParams };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  i18n.setLang("zh");
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}
const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);

async function render(node: unknown) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, node) as never));
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

const edge = (meta: Pick<LedgerDepView, "createdBy" | "createdAt" | "updatedAt">): LedgerDepView =>
  ({ from: "W1", to: "R1", kind: "blocks", when: "", state: null, derived: "active", effective: "active", ...meta });

test("复现测试：团队边（建立者 / 时间 null）显示「未记录」，不出 1970 / Invalid / 空名字 / feature 修改人", async () => {
  for (const meta of [{ createdBy: null, createdAt: null, updatedAt: null }, { createdBy: "", createdAt: 0, updatedAt: 0 }]) {
    const v = await render(h(ui.EdgePage, { deps: [edge(meta)], ov: homeLedger(), onPick: () => {}, onClose: () => {}, tr: ui.zh }));
    const text = v.host.textContent ?? "";
    expect(text).toContain("建立者 / 时间未记录（团队数据没有边级元数据）");
    for (const bad of ["1970", "Invalid", "null", "建于", "person-a"]) expect({ meta, bad, hit: text.includes(bad) }).toEqual({ meta, bad, hit: false });
    await v.unmount();
  }
});

test("防回归：本机完整边「判定依据」文字逐字不变", async () => {
  const v = await render(h(ui.EdgePage, { deps: [homeLedger().deps![0]!], ov: homeLedger(), onPick: () => {}, onClose: () => {}, tr: ui.zh }));
  expect(v.host.textContent).toContain(`pm-a 建于 ${ui.hhmm(T_CREATED)}，最后改于 ${ui.hhmm(T_UPDATED)}`);
  expect(v.host.textContent).not.toContain("未记录");
  await v.unmount();
});

async function mountView(side: "local" | "team", width: number) {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  calls.length = 0;
  ui.openCollabTask(null);
  const v = await render(side === "team"
    ? h(ui.TeamSource, { identity: IDENTITY }, h(ui.CollabView, { project: ui.sharedCollabProject(IDENTITY) }))
    : h(ui.CollabView, { project: PROJECT }));
  // 手机详情 portal 到 body：读整页文字
  const text = () => doc.body.textContent ?? "";
  await until(() => text().includes("待你处理") || text().includes("For you"), `${side} view`);
  return { ...v, text };
}

/** P1-A 已验证的禁止项：团队视图不得用团队键碰本机接口 */
const LOCAL_ONLY = [/\/me\/last-seen\/shared-ledger:/, /\/ledger\/shared-ledger:.*\/work/, /\/team\/activity\?project=shared-ledger:/,
  /\/peers\/contacts/, /\/team\/quota/, /\/ledger\/shared-ledger:/];

test("复现测试：团队总览显示镜像状态；本机总览没有", async () => {
  const team = await mountView("team", 1200);
  await until(() => team.text().includes("主场镜像最新"), "mirror section");
  await team.unmount();
  const local = await mountView("local", 1200);
  expect(local.text()).not.toMatch(/主场镜像/);
  await local.unmount();
});

test("复现测试：团队详情显示成员代号 / 主场实例 / 8 位 head / 阻塞提问 / 镜像和步骤线，不出打开会话、对它说，不碰本机接口", async () => {
  const v = await mountView("team", 1200);
  await React.act(async () => ui.openCollabTask("R1"));
  await until(() => v.text().includes("成员代号"), "team facts");
  const facts = Object.fromEntries(Array.from(v.host.querySelectorAll("[data-team-fact]")).map((e) => [e.getAttribute("data-team-fact"), e.textContent]));
  expect(facts).toEqual({ 成员代号: "成员代号：worker-a", 执行实例: "执行实例：主场实例", head: "head：89abcdef", 阻塞提问: "阻塞提问：1", 镜像: "镜像：主场镜像最新" });
  expect(v.text()).not.toContain(HOME);
  expect(v.text()).not.toContain(HEAD);
  expect(v.text()).toContain("主场有 1 个阻塞提问");
  // 步骤线：审查第 2 轮是当前步，执行者不知道显示「—」，没有编出来的结论
  expect(v.host.querySelector('[data-step="review"][aria-current="step"]')?.textContent).toContain("R2");
  expect(v.host.querySelector('[data-step="fix"]')?.textContent).toContain("已完成");
  expect(v.text()).not.toMatch(/打开会话|对它说|要改|拦下/);
  expect(calls.filter((c) => LOCAL_ONLY.some((re) => re.test(c)))).toEqual([]);
  expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  await v.unmount();
});

test("复现测试：缺字段 / 没有镜像证据显示暂无，不补成最新；阻塞提问真 0 显示 0", async () => {
  const task = { ...homeLedger().tasks[1]!, team: { assigneeCode: null, executorInstanceId: null, head: null, blockingAsks: 0, mirror: null } };
  const v = await render(h(ui.TeamFactsSec, { id: task.id, ov: { tasks: [task] }, tr: ui.zh }));
  const facts = Object.fromEntries(Array.from(v.host.querySelectorAll("[data-team-fact]")).map((e) => [e.getAttribute("data-team-fact"), e.textContent]));
  expect(facts).toEqual({ 成员代号: "成员代号：暂无", 执行实例: "执行实例：暂无", head: "head：暂无", 阻塞提问: "阻塞提问：0", 镜像: "镜像：暂无" });
  await v.unmount();
  // 总览：有 feature 还没有镜像 → 暂无；有过期 → 报过期数
  for (const [mirror, want, not] of [[{ stale: 0, fresh: 1, none: 1 }, "暂无", "主场镜像最新"], [{ stale: 2, fresh: 1, none: 0 }, "2 个 feature 主场镜像过期", "主场镜像最新"]] as const) {
    const ov = { ...homeLedger(), mirror };
    const o = await render(h(ui.Overview, { ov, view: ui.homeView(ov, NOW), waits: [], projectName: "p", onPick: () => {}, tr: ui.zh }));
    const sec = Array.from(o.host.querySelectorAll("section")).find((x) => x.querySelector("h5")?.textContent === "镜像");
    expect(sec?.textContent).toContain(want);
    expect(sec?.textContent).not.toContain(not);
    await o.unmount();
  }
});

test("复现测试：英文界面团队段与边页文案有译文", async () => {
  i18n.setLang("en");
  const v = await mountView("team", 390);
  await React.act(async () => ui.openCollabTask("R1"));
  await until(() => v.text().includes("Member code"), "team facts en");
  for (const s of ["Executor instance", "Home instance", "Blocking questions", "Home mirror is fresh", "1 blocking question(s) at home"]) expect(v.text()).toContain(s);
  await v.unmount();
  const { tIn } = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href);
  expect(tIn("en", "建立者 / 时间未记录（团队数据没有边级元数据）")).toBe("Creator / time not recorded (team data has no edge-level metadata)");
  i18n.setLang("zh");
});

test("防回归：本机详情没有「团队」段", async () => {
  const v = await mountView("local", 1200);
  await React.act(async () => ui.openCollabTask("R1"));
  await until(() => v.text().includes("在等审查的卡") && !v.text().includes("正在读取"), "local detail");
  await tick(100);
  expect(v.host.querySelectorAll("[data-team-fact]").length).toBe(0);
  expect(v.host.textContent).not.toMatch(/成员代号|主场镜像|阻塞提问/); // 桌面详情在 host 里，不读别的用例残留的 body
  await v.unmount();
});
