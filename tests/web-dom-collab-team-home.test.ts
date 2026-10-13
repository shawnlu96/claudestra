/**
 * team-project-TEAMVIS0：团队视图里主场就是本机（团队键 homeInstanceId = feature.homeInstanceId）时，CollabDetail 直接显示本机台账详情：
 * 「最近 3 件事 / 审查 / 参与者（打开会话）/ 对它说 / 回放」与无团队绑定的本机详情逐栏一致，没有「仅主场可见」占位。
 * 主场是别的机器（或键里没有 homeInstanceId）时照旧全是占位（与 main 一致）。
 * 旧红新绿：main 上主场 = 本机这一组同样四块「仅主场可见」、回放「回放仅主场」、没有对它说输入框。
 * 夹具同 web-dom-team-parity-home-only（合成数据，fetch 全部拦在本文件、只回环）；happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerEventView, LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";
import type { TaskDetail } from "../web/features/collab/collab-detail-model";
import type { CollabHomeOnly, CollabSource } from "../web/features/collab/team-source";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; disabled?: boolean; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let retiredFixture = false;
let archiveFailure: "empty" | "missing" | "error" | "paged" | null = null;
let historyFixture = false;
let chatApi: {
  state: { browsing: { sessionId: string } | null; messages: { content: string }[]; loadingHistory: boolean; historyError: boolean; historyHasMore: boolean };
  reloadHistory(): Promise<void>; loadOlder(): Promise<void>;
  jumpToContext(sessionId: string, seq: number, strictSession?: boolean): Promise<void>;
};
let i18n: { setLang(l: "zh" | "en"): void };
let nav: { openCollab(p: string): void; openCollabTask(t: string | null): void; closeCollab(): void };
let ui: {
  CollabView: (p: { project: string }) => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown;
  TeamSource: (p: { identity: Identity; children: unknown }) => unknown;
  Provider: unknown;
  SeedAgents: () => null;
  sharedCollabProject: (i: Identity) => string;
};
interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }

const PROJECT = "parity-proj";
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local" };
const NOW = Date.now();
const MIN = 60_000;
const FOCUS = "R1";
/** 长标题 / 空字段：标题够长、goal 空 */
const LONG_TITLE = "一张标题很长很长的在审卡：用来看手机 390 宽下占位文字和按钮会不会挤出面板或把布局撑歪掉";
const HOME_ONLY: ReadonlySet<CollabHomeOnly> = new Set(["events.text", "review.text", "sessions", "say", "spec.full", "replay"]);

function homeLedger(): LedgerOverview {
  return {
    exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "对照事项 parity", oneLine: "同源双喂" }],
    tasks: [
      { id: FOCUS, itemId: "F1", title: LONG_TITLE, kind: "code", stage: "review", round: 1, agent: "agent-dev", pm: null, updatedAt: NOW, metrics: {} },
      { id: "B1", itemId: "F1", title: "开发中的卡", kind: "code", stage: "build", round: 0, agent: null, pm: null, updatedAt: NOW, metrics: {} },
    ] as LedgerTaskView[],
    deps: [],
  };
}

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, text = "", actor = "agent-dev", at = NOW - 30 * MIN): LedgerEventView =>
  ({ seq: ++seq, ts: at + seq * MIN, actor, target: FOCUS, kind, text, data });

/** 本机完整事件（真实 bridge 形状：建任务带 patch.stage） */
function homeDetail(home: LedgerOverview): TaskDetail {
  const task = home.tasks[0]!;
  return {
    task, now: NOW, timeline: [],
    events: [
      ev("task", { op: "new", patch: { stage: "spec", title: task.title }, rev: 1 }, task.title, "agent-pm"),
      ev("stage", { from: "spec", to: "build" }),
      ev("deliver", { headSHA: "0b7b79c1234" }),
      ev("stage", { from: "build", to: "review" }),
      ev("review", { round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0, reviewer: "agent-review" }, "一处边界要改", "agent-review"),
      ev("verify", { result: "pass" }, "", "system"),
    ],
    sessions: { author: { agent: "agent-dev" } },
  };
}

/** 同一张卡的脱敏事件：只有类型和时间；data 里的诱饵（to / verdict / result / reviewer）不许被读出来 */
function redactedDetail(home: LedgerOverview): TaskDetail {
  const r = (kind: string, bait: Record<string, unknown> = {}) => ev(kind, { redacted: true, ...bait }, "", "agent-bait");
  return {
    task: home.tasks[0]!, now: NOW, timeline: [],
    events: [r("stage", { to: "build" }), r("review", { verdict: "pass", reviewer: "agent-bait" }), r("verify", { result: "pass" })],
    sessions: { author: { agent: "agent-dev" } },
  };
}

function project(home: LedgerOverview): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const feature = { id: "F1", projectId: PROJECT, title: home.items[0]!.title, description: home.items[0]!.oneLine, rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: "home-1", executorInstanceIds: ["home-1"], status: "active" as const,
    counts: { total: home.tasks.length, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: "home-1", sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const tasks = home.tasks.map((t, i) => ({ taskId: `task-${i}`, sourceTaskId: t.id, sourceRev: 1, sourceSeq: 9, stage: t.stage, assigneeCode: null,
    executorInstanceId: "home-1", pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] }));
  const detail = { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: home.tasks.map((t) => ({ key: t.id, oneLine: t.title, deps: [], fileGlobs: [], estimate: "" })),
      bindings: home.tasks.map((t, i) => ({ nodeKey: t.id, taskId: `task-${i}` })) }, tasks } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: IDENTITY.team, serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}

const calls: string[] = [];
const realFetch = globalThis.fetch;
let home: LedgerOverview;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  home = homeLedger();
  const team = project(home), detail = homeDetail(home);
  // 只回环夹具：拦下全部请求、记路径；夹具之外一律 404，不出网
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname + url.search)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    if (url.pathname === `/api/v1/ledger/${PROJECT}/tasks/${FOCUS}`) return json({ ok: true, ...detail,
      ...(historyFixture ? { sessions: { author: { agent: "agent-dev" }, history: [
        { role: "reviewer", agent: "agent-rv-history", sessionId: "retired-review", state: "retired", source: "local" },
        { role: "reviewer", agent: "agent-dev", sessionId: "remote-review", state: "retired", source: "peer_claim" },
      ] } } : {}),
      ...(retiredFixture ? { sessions: { author: { agent: "agent-dev", sessionId: "retired-session", state: "retired", source: "local" } } } : {}) });
    if (retiredFixture && url.pathname === "/api/v1/agents/dev/history") return json({ sessions:
      ["new-session", "retired-session", "older-session"].map((sessionId) => ({ sessionId })) });
    if (retiredFixture && url.pathname.endsWith("/history/retired-session") && archiveFailure) {
      if (archiveFailure === "paged") return json({ messages: Number(url.searchParams.get("before")) > 300 ?
        Array.from({ length: 300 }, (_, n) => ({ seq: n + 1, role: n % 2 ? "assistant" : "user", text: `archive ${n}`, ts: new Date(NOW).toISOString() })) : [] });
      return archiveFailure === "empty" ? json({ messages: [] }) : json({ error: "archive unavailable" }, archiveFailure === "missing" ? 404 : 500);
    }
    if (retiredFixture && /\/agents\/dev\/history\//.test(url.pathname)) return json({ messages: [
      { seq: 50, role: "user", text: url.pathname.endsWith("retired-session") ? "archive transcript" : "new transcript", ts: new Date(NOW).toISOString() },
    ] });
    // 本机会话列表里真有一个同名 agent-dev（模型 fixture-model）：团队代号撞名也不能借它打开会话 / 对它说
    if (url.pathname === "/api/v1/agents") return json({ ok: true, agents: [{ name: "agent-dev", model: "fixture-model", status: "idle" }] });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(team.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(team.detail);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  i18n = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href);
  nav = await import(mod("collab/collab-nav.ts"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const ctx = await import(mod("collab/team-source-context.ts"));
  const sharedNav = await import(mod("collab/dag/shared-navigation.tsx"));
  const SeedAgents = () => {
    const api = store.useChatStoreApi();
    chatApi = api;
    React.useEffect(() => void api.loadAgents(), [api]);
    return null;
  };
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, SeedAgents,
    Provider: ctx.CollabSourceContext.Provider, sharedCollabProject: sharedNav.sharedCollabProject };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  nav.closeCollab();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string, read: () => string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}: ${read().slice(0, 600)}`);
}


type Side = "local" | "home" | "away" | "nokey";
const IDS: Record<Exclude<Side, "local">, Identity> = {
  home: { ...IDENTITY, homeInstanceId: "home-1" },
  away: { ...IDENTITY, homeInstanceId: "other-instance" },
  nokey: IDENTITY,
};
let leftover: (() => Promise<void>) | null = null;
async function mount(side: Side, width: number) {
  await leftover?.();
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  const identity = side === "local" ? null : IDS[side];
  const project = identity ? ui.sharedCollabProject(identity) : PROJECT;
  nav.openCollab(project);
  nav.openCollabTask(FOCUS);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const unmount = async () => { leftover = null; await React.act(async () => root.unmount()); host.remove(); nav.closeCollab(); };
  leftover = unmount;
  const h = React.createElement as (...a: unknown[]) => unknown;
  const view = h(ui.CollabView, { project });
  const collab = identity ? h(ui.TeamSource, { identity }, view) : view;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.SeedAgents), collab) as never));
  const panel = () => Array.from(doc.body.querySelectorAll("aside")).find((a) => (a.textContent ?? "").includes(FOCUS)) ?? null;
  const text = () => panel()?.textContent ?? "";
  await until(() => /参与者|People/.test(text()) && !/正在读取|Loading/.test(text()) && calls.includes("GET /api/v1/agents?include=stopped"),
    `${side} detail`, () => doc.body.textContent ?? "");
  await tick(100);
  const sections = () => Object.fromEntries(Array.from(panel()!.querySelectorAll("h5")).map((x) => [(x.textContent ?? "").trim(), x]));
  return {
    panel, text,
    sec: (title: string) => {
      const hit = Object.entries(sections()).find(([k]) => k.startsWith(title));
      return hit ? ((hit[1] as unknown as { parentElement: El }).parentElement.textContent ?? "") : null;
    },
    homeOnly: () => Array.from(panel()!.querySelectorAll("[data-home-only]")).map((x) => x.getAttribute("data-home-only")).sort(),
    buttons: () => Array.from(panel()!.querySelectorAll("button")).map((b) => b.textContent ?? ""),
    hasInput: () => !!panel()!.querySelector("textarea"),
    unmount,
  };
}

/** 逐栏取文：最近 3 件事 / 审查 / 参与者 / 对它说 + 回放与打开会话按钮 + 输入框 */
async function columns(side: Side, width: number) {
  const v = await mount(side, width);
  const out = {
    homeOnly: v.homeOnly(), recent: v.sec("最近 3 件事"), review: v.sec("审查"), people: v.sec("参与者"), say: v.sec("对它说"),
    buttons: v.buttons().filter((b) => /回放|打开会话/.test(b)), input: v.hasInput(),
  };
  await v.unmount();
  return out;
}

for (const width of [1280, 390]) {
  test(`复现测试:主场 = 本机 ${width} 宽详情与本机协作视图逐栏一致，没有仅主场占位`, async () => {
    const local = await columns("local", width);
    const home = await columns("home", width);
    expect(home.homeOnly).toEqual([]);
    expect(home).toEqual(local);
    // 本机那份确实有内容（不是两边一起空）
    expect(local.recent).toContain("一处边界要改");
    expect(local.people).toContain("fixture-model");
    expect(local.buttons).toContain("回放这条任务");
    expect(local.buttons.some((b) => b.includes("打开会话 → dev"))).toBe(true);
    expect(local.say).toContain("对它说 · dev");
    expect(local.input).toBe(true);
  });

  test(`防回归:主场 ≠ 本机 / 键里没有 homeInstanceId ${width} 宽照旧仅主场占位`, async () => {
    for (const side of ["away", "nokey"] as const) {
      const c = await columns(side, width);
      expect(c.homeOnly).toEqual(["events.text", "replay", "review.text", "say", "sessions"]);
      expect(c.recent).toContain("仅主场可见");
      expect(c.say).toContain("仅主场可见");
      expect(c.buttons).toEqual(["回放仅主场"]);
      expect(c.input).toBe(false);
    }
  });
}
