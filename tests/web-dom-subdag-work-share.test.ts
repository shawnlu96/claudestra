/**
 * team-project-SUBDAG3：「谁在干活」的看板由 use-dag-panes.tsx 读一份，标签、计数与子 DAG 共用。真挂 CollabView 到 happy-dom（React 19），
 * fetch 全部拦在本文件、只回环。本机：产品 DAG → 谁在干活 → 点产品卡进子 DAG → 谁在干活，/ledger/:p/work 全程只请求 1 次（UXNUM1 起计数也用它，
 * 产品 DAG 标签上就是这一次）；团队键（主场本机）同样只 1 次。两边「谁在干活」的 DOM 来回切换前后逐字节相同。
 * 先红不适用：UXNUM1（ee01c0379）已把看板读取提到 use-dag-panes，main 上本来就是 1 次。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { WorkBoard, WorkRow } from "../web/features/collab/work/work-types";
import { generateHomeFixture, homeDagBoard, homeDagFeature, homeProductBoard, homeWorkBoard } from "../web/features/collab/shared/home-fixture-gen";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; innerHTML: string; disabled?: boolean; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }
interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }

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

const home = generateHomeFixture({ now: Date.now() });
const LOCAL = home.project;
/** 团队键用另一个本机项目 id：两段测试的 /work 路径分开记账 */
const TEAM_LOCAL = "share-team-proj";
/** 团队键的本机实例 = 卡的执行实例（主场本机）：UXWHO1 规则下要读本机 /work */
const HOME = "a1b2c3d4e5f60718293a4b5c";
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: TEAM_LOCAL, machine: "share-machine", homeInstanceId: HOME };
const NOW = home.now, MIN = 60_000;

function teamProject(): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const cards = [["B1", "build", "开发中的卡"], ["M1", "merge", "等合并的卡"]] as const;
  const feature = { id: "F1", projectId: TEAM_LOCAL, title: "共用看板事项", description: "同一份看板", rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const,
    counts: { total: cards.length, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const tasks = cards.map(([id, stage], i) => ({ taskId: `task-${i}`, sourceTaskId: id, sourceRev: 1, sourceSeq: 9, stage, assigneeCode: null,
    executorInstanceId: HOME, pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] }));
  const detail = { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: cards.map(([id, , title]) => ({ key: id, oneLine: title, deps: [], fileGlobs: [], estimate: "" })),
      bindings: cards.map(([id], i) => ({ nodeKey: id, taskId: `task-${i}` })) }, tasks } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}
const row = (id: string, patch: Partial<WorkRow>): WorkRow => ({ taskId: id, featureId: "F1", nodeKey: id, title: `${id} 本机`, who: null, machine: "local",
  step: "write", round: 1, since: NOW - 25 * MIN, normalMinutes: 60, remainingMinutes: 35, overMinutes: 0, reason: null, code: null, estimate: "", ...patch });
const teamLocalBoard: WorkBoard = { now: NOW, asOfSeq: 1, machines: { local: 2 }, completionHours: 2, availableSlots: 2,
  working: [row("B1", { who: "agent-dev-b1" })], waiting: [row("M1", { who: "agent-dev-m1", step: "merge", reason: "合并排队：前面是 X9", code: "merge_queue" })],
  todo: { ready: [], blocked: [] } };

const calls: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const team = teamProject(), base = `/api/v1/ledger/${LOCAL}`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = decodeURIComponent(url.pathname);
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === base) return json({ ok: true, ...home.overview });
    if (path === `${base}/dag`) return json(homeDagBoard(home));
    if (path.startsWith(`${base}/dag/`)) return json(homeDagFeature(home, path.slice(base.length + 5)) ?? { ok: false }, 200);
    if (path === `${base}/product`) return json(homeProductBoard(home));
    if (path === `${base}/work`) return json(homeWorkBoard(home));
    const task = path.match(new RegExp(`^${base}/tasks/([\\w-]+)$`));
    if (task && home.details[task[1]!]) return json({ ok: true, ...home.details[task[1]!] });
    if (path === `/api/v1/ledger/${TEAM_LOCAL}/work`) return json(teamLocalBoard);
    if (path === "/api/v1/shared-ledger/features") return json(team.list);
    if (path === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    if (path === "/api/v1/shared-ledger/context") return json({ identities: [{ ...IDENTITY, localProjectId: TEAM_LOCAL }] });
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
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string, read: () => string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}: ${read().slice(0, 600)}`);
}

async function mount(team: boolean) {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width: 1280, height: 900 });
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  const view = h(ui.CollabView, { project: team ? ui.sharedCollabProject(IDENTITY) : LOCAL });
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, team ? h(ui.TeamSource, { identity: IDENTITY }, view) : view) as never));
  const text = () => host.textContent ?? "";
  const tab = (label: string) => Array.from(host.querySelectorAll("[role=tab]")).find((b) => (b.textContent ?? "").startsWith(label)) ?? null;
  const click = async (el: El | null, what: string) => {
    if (!el) throw new Error(`no ${what}: ${text().slice(0, 600)}`);
    await React.act(async () => el.click());
    await tick(60);
  };
  const board = () => host.querySelector("[data-work-board]");
  /** 看板出数（计数从骨架换成数字）后的整块 HTML；谁在干活 = 「模块进度」里的「按人」（PROJTABS1） */
  const workHtml = async () => {
    await click(tab("模块进度"), "模块进度 tab");
    if (tab("按人")) await click(tab("按人"), "按人 segment");
    await until(() => !!board() && !board()!.querySelector("[aria-hidden]:empty"), "work board", text);
    await tick(60);
    return board()!.innerHTML;
  };
  return { host, text, tab, click, workHtml, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const workCalls = (project: string) => calls.filter((c) => c === `GET /api/v1/ledger/${project}/work`).length;

test("[验收线 1][验收线 2][验收线 4] 本机：项目地图 → 谁在干活 → 模块的子图 → 谁在干活，/work 只请求 1 次；谁在干活 DOM 来回切换前后逐字节相同", async () => {
  calls.length = 0;
  const v = await mount(false);
  const feature = homeProductBoard(home).features[0]!;
  await v.click(v.tab("项目地图"), "项目地图 tab");
  await until(() => v.text().includes(feature.title), "product tab", v.text);
  await tick(100);
  // 产品 DAG 标签：计数（顶栏 / 产品卡）要看板，读的就是共用的这一次，不另发
  expect(workCalls(LOCAL)).toBe(1);
  const first = await v.workHtml();
  expect(first).toContain(homeWorkBoard(home).working[0]!.title);
  await v.click(v.tab("项目地图"), "项目地图 tab");
  const card = Array.from(v.host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(feature.title)) ?? null;
  await v.click(card, "product card");
  await until(() => (v.tab("模块进度")?.getAttribute("aria-selected") ?? "") === "true", "module tab", v.text);
  expect(v.host.querySelector("[data-project-pane=module] nav")?.textContent).toContain(feature.title);
  await tick(100);
  const again = await v.workHtml();
  expect(again).toBe(first);
  expect(workCalls(LOCAL)).toBe(1);
  await v.unmount();
});

test("[验收线 3][验收线 4] 团队键（主场本机）：只读一次本机 /work；谁在干活 DOM 来回切换前后逐字节相同", async () => {
  calls.length = 0;
  const v = await mount(true);
  const first = await v.workHtml();
  expect(first).toContain("agent-dev-m1");
  expect(workCalls(TEAM_LOCAL)).toBe(1);
  const other = v.tab("项目地图");
  await v.click(other, "another tab");
  expect(v.host.querySelector("[data-work-board]")).toBeNull();
  await tick(100);
  const again = await v.workHtml();
  expect(again).toBe(first);
  expect(workCalls(TEAM_LOCAL)).toBe(1);
  // 团队键下从不按团队项目 id 读本机台账（parity「本机接口误调」）
  expect(calls.filter((c) => c.includes("/ledger/shared-ledger:"))).toEqual([]);
  await v.unmount();
});
