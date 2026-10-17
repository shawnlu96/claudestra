/**
 * team-project-UXWHO1：团队视图「谁在干活」真挂到 happy-dom（React 19），TeamSource 注入团队源，fetch 全部拦在本文件、只回环。
 * 一组团队键的本机实例 = 卡的执行实例（主场本机）：读本机 /ledger/:p/work，行上是本机 agent 名 · 本机、合并排队进「在等合并」；
 * 一组本机实例 ≠ 执行实例、一组键里没有本机实例：一次本机 /work 都不请求（验收线 2），机器写快照里的 peer 名，实例 id 不出现在可见文字里。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";
import type { WorkBoard, WorkRow } from "../web/features/collab/work/work-types";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; getAttribute(n: string): string | null;
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

const PROJECT = "parity-proj";
/** 中心投影里的执行实例原样是 24 位十六进制 */
const HOME = "a1b2c3d4e5f60718293a4b5c";
const BASE: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local" };
const NOW = Date.now(), MIN = 60_000;
const HEX = /[0-9a-f]{16,}/i;

function homeLedger(): LedgerOverview {
  const t = (id: string, stage: LedgerTaskView["stage"], title: string): LedgerTaskView =>
    ({ id, itemId: "F1", title, kind: "code", stage, round: 1, agent: null, pm: null, updatedAt: NOW, metrics: {} });
  return { exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "对照事项 parity", oneLine: "同源双喂" }],
    tasks: [t("B1", "build", "开发中的卡"), t("R1", "review", "在等审查的卡"), t("M1", "merge", "等合并的卡")], deps: [] };
}

function project(home: LedgerOverview): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const feature = { id: "F1", projectId: PROJECT, title: home.items[0]!.title, description: home.items[0]!.oneLine, rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const,
    counts: { total: home.tasks.length, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const tasks = home.tasks.map((t, i) => ({ taskId: `task-${i}`, sourceTaskId: t.id, sourceRev: 1, sourceSeq: 9, stage: t.stage, assigneeCode: `c0de${HOME}`,
    executorInstanceId: HOME, pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] }));
  const detail = { schemaVersion: 1, teamId: BASE.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: home.tasks.map((t) => ({ key: t.id, oneLine: t.title, deps: [], fileGlobs: [], estimate: "" })),
      bindings: home.tasks.map((t, i) => ({ nodeKey: t.id, taskId: `task-${i}` })) }, tasks } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: BASE.team, serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}

const row = (id: string, patch: Partial<WorkRow>): WorkRow => ({ taskId: id, featureId: "F1", nodeKey: id, title: `${id} 本机`, who: null, machine: "local",
  step: "write", round: 1, since: NOW - 25 * MIN, normalMinutes: 60, remainingMinutes: 35, overMinutes: 0, reason: null, code: null, estimate: "", ...patch });
const BOARD: WorkBoard = { now: NOW, asOfSeq: 1, machines: { local: 2 }, completionHours: 2, availableSlots: 2,
  working: [row("B1", { who: "agent-dev-b1" }), row("R1", { who: "agent-rv-1", step: "review", round: 2, since: NOW - 10 * MIN })],
  waiting: [row("M1", { who: "agent-dev-m1", step: "merge", reason: "合并排队：前面是 X9", code: "merge_queue" })], todo: { ready: [], blocked: [] } };

let localBoard: WorkBoard = BOARD;
/** 本机 shared-projects 快照：HOME 这台是 peer-mac（本机实例换成别的时才用得上） */
let localInstance = "";
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
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    if (url.pathname === `/api/v1/ledger/${PROJECT}/work`) return json(localBoard);
    if (url.pathname === "/api/v1/shared-ledger/features") return json(team.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    if (url.pathname === "/api/v1/shared-ledger/context") return json({ identities: [{ ...BASE, homeInstanceId: localInstance, localProjectId: PROJECT }] });
    if (url.pathname === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: BASE.center,
      teamId: BASE.team, personId: BASE.person, instanceId: localInstance }, teamRole: { available: true, value: "member" },
      capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [],
      peers: [{ name: "peer-mac", enabled: true, invitable: true, instanceId: HOME }] });
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

/** 打开团队视图的「谁在干活」（PROJTABS1：「模块进度」里的「按人」），等到列表出现并多等几轮（让该发 / 不该发的请求都有机会发出） */
async function workTab(identity: Identity) {
  localInstance = identity.homeInstanceId ?? "";
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width: 1200, height: 900 });
  calls.length = 0;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null,
    h(ui.TeamSource, { identity }, h(ui.CollabView, { project: ui.sharedCollabProject(identity) }))) as never));
  const text = () => host.textContent ?? "";
  // 同一项目会记住上次的标签（project-tabs/tab-request.ts），不一定落在总览：等到标签条出来就点「模块进度」
  const tab = (label: string) => Array.from(host.querySelectorAll("button,[role=tab]")).find((x) => (x.textContent ?? "").trim() === label);
  await until(() => !!tab("模块进度"), "team view", text);
  await React.act(async () => tab("模块进度")!.click());
  const person = tab("按人");
  if (person) await React.act(async () => person.click());
  const board = () => host.querySelector("[data-work-board=team]");
  const column = (label: string) => Array.from(board()?.querySelectorAll("section") ?? []).find((s) => (s.querySelector("h3")?.textContent ?? "").startsWith(label));
  await until(() => (column("在等合并")?.textContent ?? "").includes("M1"), "work board", () => board()?.textContent ?? text());
  await tick(300);
  // 可见文字 = textContent（title 属性不在里面，实例 id 只放那里）
  const shown = () => board()?.textContent ?? "";
  return { shown, column: (l: string) => column(l)?.textContent ?? "", host, work: () => calls.filter((c) => /\/work$/.test(c)),
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test("主场本机（团队键 homeInstanceId = 执行实例）：读本机 /work，行上是 agent 名 · 本机、步骤与已持续；合并排队在「在等合并」", async () => {
  const v = await workTab({ ...BASE, homeInstanceId: HOME });
  await until(() => v.shown().includes("agent-dev-b1"), "local rows", v.shown);
  expect(v.work()).toEqual([`GET /api/v1/ledger/${PROJECT}/work`]);
  expect(v.column("在干活")).toContain("agent-dev-b1 · 本机");
  expect(v.column("在干活")).toContain("agent-rv-1 · 本机");
  expect(v.column("在干活")).toContain("25m");
  expect(v.column("在等合并")).toContain("合并排队：前面是 X9");
  expect(v.column("在干活")).not.toContain("M1");
  expect(HEX.test(v.shown())).toBe(false);
  await v.unmount();
});

test("[验收线 2] 本机实例不是任何一行的执行实例：不请求本机 /work；机器写快照里的 peer 名，合并卡写「等合并」", async () => {
  const v = await workTab({ ...BASE, homeInstanceId: "f00dfeedf00dfeedf00dfeed" });
  await until(() => v.shown().includes("peer-mac"), "peer names", v.shown);
  expect(v.work()).toEqual([]);
  expect(v.column("在干活")).toContain("peer-mac");
  expect(v.column("在等合并")).toContain("等合并");
  expect(v.shown()).not.toContain("队列第");
  expect(HEX.test(v.shown())).toBe(false);
  await v.unmount();
});

test("[验收线 2] 团队键里没有本机实例：同样不请求本机 /work", async () => {
  const v = await workTab(BASE);
  expect(v.work()).toEqual([]);
  expect(HEX.test(v.shown())).toBe(false);
  await v.unmount();
});

test("[验收线 2] UXCARD3 本机判老卡的主场本机卡（团队行在审查）：团队板在干活栏没有它，在「老卡 · 1」折叠里，在干活计数不含它", async () => {
  localBoard = { ...BOARD, working: [BOARD.working[0]!], legacy: [{ taskId: "R1", title: "R1 本机", stage: "review" }], legacyTotal: 1 };
  try {
    const v = await workTab({ ...BASE, homeInstanceId: HOME });
    await until(() => v.shown().includes("老卡"), "legacy fold", v.shown);
    expect(v.column("在干活")).not.toContain("R1");
    expect(v.column("在干活")).toContain("B1");
    // 板上还有别的折叠（PRIO4「当前现在做」面板），按摘要找老卡那一个
    const fold = Array.from(v.host.querySelectorAll("details")).find((d) => (d.querySelector("summary")?.textContent ?? "").startsWith("老卡"));
    expect(fold?.querySelector("summary")?.textContent).toBe("老卡 · 1");
    expect(fold?.textContent).toContain("R1");
    expect(fold?.textContent).toContain("审查");
    const tab = Array.from(v.host.querySelectorAll("[role=tab]")).find((x) => (x.textContent ?? "").startsWith("在干活"));
    expect(tab?.textContent).toBe("在干活 1");
    await v.unmount();
  } finally { localBoard = BOARD; }
});
