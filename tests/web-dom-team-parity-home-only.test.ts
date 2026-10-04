/**
 * team-parity-I（docs/team/team-collab-parity-plan.md §5.1 P1-I）：同一个 CollabView / CollabDetail 真挂到 happy-dom（React 19），
 * 三种喂法看同一张卡 R1 的详情：
 *   - 本机：本机台账完整事件（建任务带 patch.stage、阶段、交付、审查、验证），有执行者会话、能对它说；
 *   - 团队：经 TeamSource 注入的真实团队源（走 /shared-ledger/features*，详情 events 为空、homeOnly 全集）；
 *   - 团队（脱敏）：测试内注入的源，同一张卡给 data.redacted 的事件（P1-F 以后才会出境的形状），homeOnly 全集，
 *     执行者代号故意和本机 agent 同名（agent-dev），证明成员代号不当本机会话凭据。
 * 旧红新绿：main 上团队详情「最近 3 件事 / 审查 / 回放 / 对它说」整块消失、参与者标题下空着；脱敏 verify 显示「线上验证失败」，
 * 同名代号出「打开会话」按钮和本机「对它说」输入框。修完给「仅主场可见」占位、按钮点不动、点遍详情里的按钮也不请求本机会话 / say 接口。
 * 本机同一张卡的文案与按钮保持（防回归）。fetch 全部拦在本文件、夹具之外一律 404；happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
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
interface Identity { center: string; team: string; person: string; project: string; machine: string }

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
    if (url.pathname === `/api/v1/ledger/${PROJECT}/tasks/${FOCUS}`) return json({ ok: true, ...detail });
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

/** 只有类型 / 时间的历史之后首次出现合法 blocked（审查 r1 blocked-unknown）：受阻前阶段没有证据 */
function blockedUnknownDetail(home: LedgerOverview): TaskDetail {
  return { ...redactedDetail(home), events: [ev("verify", { redacted: true }, "", "system"), ev("stage", { to: "blocked" }, "", "system")] };
}

/** 脱敏喂法：测试内注入的源（P1-F 以后的数据形状），overview 同一份本机台账，task 给脱敏事件，homeOnly 全集 */
function redactedSource(detail: (home: LedgerOverview) => TaskDetail = redactedDetail): CollabSource {
  return {
    homeOnly: HOME_ONLY,
    overview: async () => home,
    task: async () => detail(home),
    follow: ({ signal }) => new Promise<void>((r) => signal.addEventListener("abort", () => r())),
  };
}

type Side = "local" | "team" | "redacted" | "blocked";
/** 上一个用例断言失败时没走到 unmount：下一次挂载前先收掉，别让旧面板留在 body 里串到下一个用例 */
let leftover: (() => Promise<void>) | null = null;
async function mount(side: Side, width: number) {
  await leftover?.();
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  const project = side === "team" ? ui.sharedCollabProject(IDENTITY) : PROJECT;
  nav.openCollab(project);
  nav.openCollabTask(FOCUS);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const unmount = async () => { leftover = null; await React.act(async () => root.unmount()); host.remove(); nav.closeCollab(); };
  leftover = unmount;
  const h = React.createElement as (...a: unknown[]) => unknown;
  const view = h(ui.CollabView, { project });
  const collab = side === "team" ? h(ui.TeamSource, { identity: IDENTITY }, view)
    : side === "redacted" ? h(ui.Provider, { value: redactedSource() }, view)
    : side === "blocked" ? h(ui.Provider, { value: redactedSource(blockedUnknownDetail) }, view) : view;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.SeedAgents), collab) as never));
  // 手机详情 portal 到 body：一律在 body 里找详情面板
  const panel = () => {
    const all = Array.from(doc.body.querySelectorAll("aside"));
    return all.find((a) => (a.textContent ?? "").includes(FOCUS)) ?? null;
  };
  const text = () => panel()?.textContent ?? "";
  await until(() => /参与者|People/.test(text()) && !/正在读取|Loading/.test(text()) && calls.includes("GET /api/v1/agents?include=stopped"),
    `${side} detail`, () => doc.body.textContent ?? "");
  await tick(100);
  const sections = () => Object.fromEntries(Array.from(panel()!.querySelectorAll("h5")).map((x) => [(x.textContent ?? "").trim(), x]));
  return {
    panel, text,
    /** 某个区块（h5 标题开头）的整段文字；没有这个区块 = null */
    sec: (title: string) => {
      const hit = Object.entries(sections()).find(([k]) => k.startsWith(title));
      return hit ? ((hit[1] as unknown as { parentElement: El }).parentElement.textContent ?? "") : null;
    },
    homeOnly: () => Array.from(panel()!.querySelectorAll("[data-home-only]")).map((x) => x.getAttribute("data-home-only")).sort(),
    buttons: () => Array.from(panel()!.querySelectorAll("button")),
    hasInput: () => !!panel()!.querySelector("textarea"),
    unmount,
  };
}

/** 本机会话 / 对它说 / 写操作：团队详情里点遍按钮也不许出现的请求 */
const FORBIDDEN = (c: string) => !c.startsWith("GET ") || /\/say|\/send|\/messages|\/agents\/|\/sessions\//.test(c);

/** 点遍详情里能点的按钮（关闭除外）：返回点击期间发出的请求 */
async function clickAll(v: Awaited<ReturnType<typeof mount>>) {
  const before = calls.length;
  for (const b of v.buttons()) {
    const label = b.getAttribute("aria-label") ?? "";
    if (/关闭|Close$/.test(label)) continue;
    await React.act(async () => b.click());
    await tick(30);
  }
  return calls.slice(before);
}

for (const width of [1200, 390]) {
  test(`复现测试:团队详情 ${width} 宽缺数据显示仅主场占位，不整块消失、按钮点不动`, async () => {
    const v = await mount("team", width);
    expect(v.homeOnly()).toEqual(["events.text", "replay", "review.text", "say", "sessions"]);
    expect(v.sec("最近 3 件事")).toContain("仅主场可见");
    expect(v.sec("审查")).toContain("仅主场可见");
    expect(v.sec("参与者")).toContain("仅主场可见");
    expect(v.sec("对它说")).toContain("仅主场可见");
    // 规格全文：团队操作段既有的「全文仅在主场」
    expect(v.text()).toContain("全文仅在主场");
    const replay = v.buttons().find((b) => (b.textContent ?? "").includes("回放仅主场"));
    expect(replay?.disabled).toBe(true);
    expect(v.text()).not.toContain("回放这条任务");
    expect(v.text()).not.toContain("打开会话 →");
    expect(v.hasInput()).toBe(false);
    expect((await clickAll(v)).filter(FORBIDDEN)).toEqual([]);
    expect(v.text()).not.toContain("undefined");
    await v.unmount();
  });

  test(`复现测试:脱敏事件 ${width} 宽只说类型 + 仅主场，同名成员代号不挂本机打开会话 / 对它说`, async () => {
    const v = await mount("redacted", width);
    const recent = v.sec("最近 3 件事") ?? "";
    expect(recent).toContain("线上验证（结果仅主场）");
    expect(recent).toContain("审查（结论仅主场）");
    expect(recent).toContain("推进阶段（目标阶段仅主场）");
    expect(recent).toContain("原文仅主场可见");
    expect(recent).not.toContain("线上验证失败");
    expect(recent).not.toContain("线上验证通过");
    expect(v.text()).not.toContain("bait");
    expect(v.text()).not.toContain("undefined");
    // 脱敏审查不出空行：审查区块只有占位
    expect(v.sec("审查")).toContain("仅主场可见");
    expect(v.sec("审查")).not.toMatch(/R\?|R\d/);
    // 三条脱敏事件没有阶段证据：不可回放
    expect(v.buttons().find((b) => (b.textContent ?? "").includes("回放仅主场"))?.disabled).toBe(true);
    // 执行者代号照常展示，但不是本机打开会话凭据
    expect(v.sec("参与者")).toContain("dev");
    expect(v.sec("参与者")).toContain("打开会话仅主场");
    // 同名本机 agent 的模型不挂到团队执行者上
    expect(v.sec("参与者")).not.toContain("fixture-model");
    expect(v.text()).not.toContain("打开会话 →");
    expect(v.sec("对它说")).toContain("仅主场可见");
    expect(v.hasInput()).toBe(false);
    expect((await clickAll(v)).filter(FORBIDDEN)).toEqual([]);
    await v.unmount();
  });

  test(`防回归:本机同一张卡 ${width} 宽完整文案与按钮保持，没有仅主场占位`, async () => {
    const v = await mount("local", width);
    expect(v.homeOnly()).toEqual([]);
    expect(v.text()).not.toContain("仅主场");
    const recent = v.sec("最近 3 件事") ?? "";
    expect(recent).toContain("线上验证通过");
    expect(recent).toContain("审查 · 第 1 轮：要改 · P0 0 · P1 1 · P2 0：一处边界要改");
    expect(recent).toContain("dev 推到「审查」");
    expect(v.sec("审查")).toContain("一处边界要改");
    expect(v.text()).toContain("打开会话 → dev");
    expect(v.sec("参与者")).toContain("fixture-model");
    expect(v.text()).toContain("回放这条任务");
    expect(v.hasInput()).toBe(true);
    await v.unmount();
  });
}

// 阶段条不高亮开发由 web-collab-replay-evidence「未知历史后的 blocked 不应凭空高亮开发」断言（happy-dom 下 CSS module 类名为空，DOM 分不出当前段）
test("复现测试:回放里未知历史后的 blocked 提示受阻前阶段未知", async () => {
  const v = await mount("blocked", 1200);
  const open = v.buttons().find((b) => (b.textContent ?? "").includes("回放这条任务"));
  expect(open).toBeDefined();
  await React.act(async () => open!.click());
  await tick(30);
  const unknown = () => v.panel()!.querySelector("[data-stage-unknown]")?.getAttribute("data-stage-unknown") ?? null;
  expect(unknown()).toBe("stage");
  const next = v.buttons().find((b) => b.getAttribute("aria-label") === "下一步");
  await React.act(async () => next!.click());
  await tick(30);
  expect(unknown()).toBe("before");
  expect(v.text()).toContain("受阻前阶段未知");
  expect(v.text()).not.toContain("undefined");
  await v.unmount();
});

test("复现测试:英文模式团队占位走协作视图本地词表，不回落中文", async () => {
  i18n.setLang("en");
  try {
    const t = await mount("team", 1200);
    const team = { recent: t.sec("Recent 3"), replay: t.buttons().some((b) => (b.textContent ?? "").includes("Replay at home only")), text: t.text() };
    await t.unmount();
    const r = await mount("redacted", 390);
    const red = r.text();
    await r.unmount();
    expect(team.recent ?? team.text).toContain("Home only");
    expect(team.replay).toBe(true);
    expect(team.text).toContain("Full text at home only");
    expect(team.text).not.toMatch(/仅主场/);
    expect(red).toContain("Live verification (result at home only)");
    expect(red).toContain("Open session at home only");
    expect(red).not.toMatch(/仅主场|线上验证/);
  } finally {
    i18n.setLang("zh");
  }
});
