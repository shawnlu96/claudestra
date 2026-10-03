/**
 * team-parity-A（docs/team/team-collab-parity-plan.md §5.1 P1-A）：同一个 CollabView 真挂到 happy-dom（React 19），
 * 一边是本机源，一边经 TeamSource 注入团队源（走真的共享读口 /shared-ledger/features*）。全部 fetch 都被这里拦下记路径，
 * 不连任何真 bridge。数据是同一份合成本机台账，按 mirrorTaskProjections 的字段规则投影成团队数据（stage / sourceTaskId /
 * fullText=home_only，assigneeCode 缺 meta 为 null，指标与完成时刻不出境，observedAt = 镜像刷新时刻 = 此刻）。
 *
 * 旧红新绿：main 上团队视图会用团队键请求 /me/last-seen/shared-ledger:…、/ledger/shared-ledger:…/work、
 * /team/activity?project=shared-ledger:…、/peers/contacts、/team/quota，并把 observedAt 当完成时刻显示「今日完成 3」；
 * 修完这些请求为 0，指标显示「暂无」（带原因 title）。本机同数据的数字与请求路径保持不变。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; title: string; getAttribute(n: string): string | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }

// 根 tsc 没有 --jsx：组件在运行时由 bun 转译加载
const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
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

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const home = homeLedger(), team = project(home);
  // 只回环夹具：拦下全部请求，记下解码后的路径；夹具之外一律 404，不出网
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = decodeURIComponent(url.pathname + url.search);
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(team.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const nav = await import(mod("collab/dag/shared-navigation.tsx"));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: nav.sharedCollabProject };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}

async function mount(side: "local" | "team", width: number) {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  calls.length = 0;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  const collab = side === "team"
    ? h(ui.TeamSource, { identity: IDENTITY }, h(ui.CollabView, { project: ui.sharedCollabProject(IDENTITY) }))
    : h(ui.CollabView, { project: PROJECT });
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, collab) as never));
  // 手机团队首页是产品 DAG（列事项），本机没有产品看板退回分组列表（列卡）
  const text = () => host.textContent ?? "";
  await until(() => text().includes("待你处理") && (text().includes("在等审查的卡") || text().includes("对照事项 parity")), `${side} view`);
  const buttons = () => Array.from(host.querySelectorAll("button,[role=tab]"));
  const click = async (label: string) => {
    const b = buttons().find((x) => (x.textContent ?? "").trim().startsWith(label));
    if (!b) throw new Error(`no ${label} button`);
    await React.act(async () => b.click());
    await tick(200);
  };
  return {
    host, click,
    /** 指标条一格：值与原因 title */
    metric: (label: string) => {
      const cell = Array.from(host.querySelectorAll("span")).find((s) => s.querySelector("b") && s.querySelector("span")?.textContent === label);
      return cell ? { value: cell.querySelector("b")!.textContent, title: cell.getAttribute("title") } : null;
    },
    button: (label: string) => buttons().find((x) => (x.textContent ?? "").trim().startsWith(label)) ?? null,
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

/** 团队视图不得用团队键碰的本机接口（P1-A 验收线） */
const LOCAL_ONLY = [/\/me\/last-seen\/shared-ledger:/, /\/ledger\/shared-ledger:.*\/work/, /\/team\/activity\?project=shared-ledger:/, /\/peers\/contacts/, /\/team\/quota/];

test("复现测试:团队 CollabView 不再请求本机 last-seen / 谁在干活 / 团队标签接口", async () => {
  const v = await mount("team", 1200);
  await v.click("谁在干活");
  await v.click("团队");
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
  expect(v.metric("今日完成")).toEqual({ value: "暂无", title: "暂无数据来源" });
  await v.unmount();
});

test("复现测试:团队未知指标与待你处理显示暂无并给原因，区别于本机「—」", async () => {
  const v = await mount("team", 1200);
  for (const k of ["在场 agent", "今日完成", "审查轮次", "P0/P1 修掉", "平均等复核"]) {
    const m = v.metric(k);
    expect({ k, value: m?.value }).toEqual({ k, value: "暂无" });
    expect(m?.title).toBeTruthy();
  }
  expect(v.metric("进行中")?.value).toBe("2");
  const waits = v.button("待你处理");
  expect(waits?.querySelector("b")?.textContent).toBe("暂无");
  expect(waits?.title).toBeTruthy();
  await v.unmount();
});

test("复现测试:团队手机顶栏「待你处理」暂无，与桌面大纲一致", async () => {
  const v = await mount("team", 390);
  const waits = v.button("待你处理");
  expect(waits?.querySelector("b")?.textContent).toBe("暂无");
  expect(waits?.title).toBeTruthy();
  expect(calls.filter((c) => LOCAL_ONLY.some((re) => re.test(c)))).toEqual([]);
  await v.unmount();
});

test("防回归:本机同一份台账数字、请求路径保持（last-seen / 谁在干活 / 团队标签照常读）", async () => {
  const v = await mount("local", 1200);
  expect(v.metric("在场 agent")).toEqual({ value: "0", title: null });
  expect(v.metric("今日完成")).toEqual({ value: "3", title: null });
  expect(v.metric("审查轮次")).toEqual({ value: "5", title: null });
  expect(v.metric("P0/P1 修掉")).toEqual({ value: "3", title: null });
  expect(v.metric("平均等复核")?.value).toBe("2分");
  expect(v.metric("平均等复核")?.title).toBeNull();
  expect(v.button("待你处理")?.querySelector("b")?.textContent).toBe("0");
  expect(v.button("待你处理")?.title ?? "").toBe("");
  await v.click("谁在干活");
  await v.click("团队");
  await tick(300);
  const paths = [...new Set(calls.map((c) => c.replace(/dayStart=\d+/, "dayStart=*").replace(/\?events=.*$/, "?events=*")))].sort();
  for (const p of [`GET /api/v1/ledger/${PROJECT}?dayStart=*`, `GET /api/v1/me/last-seen/${PROJECT}?events=*`, `GET /api/v1/ledger/${PROJECT}/work`,
    `GET /api/v1/team/activity?project=${PROJECT}`, "GET /api/v1/peers/contacts", "GET /api/v1/team/quota"]) expect(paths).toContain(p);
  await v.unmount();
});

test("防回归:本机手机今日完成分组照旧列 3 张", async () => {
  const v = await mount("local", 390);
  const h = Array.from(v.host.querySelectorAll("h5")).map((x) => (x.textContent ?? "").replace(/\s+/g, " ").trim());
  expect(h).toContain("今日完成 3");
  expect(v.button("待你处理")?.querySelector("b")?.textContent).toBe("0");
  await v.unmount();
});
