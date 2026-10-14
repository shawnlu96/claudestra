/**
 * team-project-UXCARD1：任务详情 DOM。本机审查卡「现在」写谁在审第几轮、多久、下一步；开发卡有「叫停这一轮」（点一次不发，5 秒内再点发一次 interrupt）；
 * 标题灰字只写卡自己的目标句（没有就不显示，不退回事项一句话）；「阶段与用时」不出「—」；别的机器为主场的卡「对它说」写机器名和原因、
 * 参与者机器名来自 team-instance-names.ts、没有叫停、可见文字不含长十六进制；文件范围在卡片详情里折叠、计划节点页展开。
 * 合成数据，fetch 全部拦在本文件、只回环；happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";
import type { LedgerEventView, LedgerOverview, LedgerTaskView } from "../web/features/collab/collab-model";
import type { BoardNode, FeatureCard } from "../web/features/collab/dag/dag-types";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; disabled?: boolean; parentElement: El; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }
interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let nav: { openCollab(p: string): void; openCollabTask(t: string | null): void; closeCollab(): void };
let ui: Record<string, unknown> & { sharedCollabProject: (i: Identity) => string };

const PROJECT = "now-proj";
const NOW = Date.now();
const MIN = 60_000;
const HOME = "9f3c2a7b5d1e4f6a8b0c2d4e";
const FEATURE_LINE = "这是事项很长的一句描述：owner 当初的原话抱怨，不是这张卡要做的事";
const GOAL = "审查卡自己的目标句：详情一眼看出谁在审";
const GLOBS = Array.from({ length: 19 }, (_, i) => `web/features/collab/file-${i}.tsx`);
// machine 用本文件独有的名字：peer 名表按 machine 缓存在模块里（work/use-work-board.ts readNames），和别的测试文件共进程时不串
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "now-machine", homeInstanceId: "mine-1" };

function ledger(): LedgerOverview {
  const t = (p: Partial<LedgerTaskView>): LedgerTaskView => ({ itemId: "F1", kind: "code", round: 0, pm: "agent-pm", updatedAt: NOW, metrics: {}, ...p } as LedgerTaskView);
  return {
    exists: true, now: NOW, meta: { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "详情事项", oneLine: FEATURE_LINE }],
    tasks: [
      t({ id: "RV1", title: "在审的卡", stage: "review", round: 2, agent: "agent-dev", stageSince: NOW - 40 * MIN, extra: { goal: GOAL } }),
      t({ id: "BD1", title: "开发中的卡", stage: "build", round: 0, agent: "agent-dev", stageSince: NOW - 12 * MIN }),
      // UXCARD3：出借写卡（tasks.agent 是本机占位会话）、退回人工的返工卡、没有调度记录的老卡
      t({ id: "LD1", title: "出借写卡", stage: "build", round: 1, agent: "agent-lend-ph", stageSince: NOW - 15 * MIN }),
      t({ id: "MN1", title: "退回人工的卡", stage: "fix", round: 5, agent: "agent-dev", stageSince: NOW - 50 * MIN }),
      t({ id: "OLD1", title: "老卡", stage: "review", round: 1, agent: "agent-dev", stageSince: NOW - 336 * 60 * MIN }),
    ],
    deps: [],
  } as unknown as LedgerOverview;
}

let seq = 0;
const ev = (target: string, kind: string, data: Record<string, unknown>, at: number): LedgerEventView => ({ seq: ++seq, ts: at, actor: "scheduler", target, kind, text: "", data });
function detail(home: LedgerOverview, id: string) {
  const task = home.tasks.find((t) => t.id === id)!;
  if (id === "RV1") {
    return { ok: true, task, now: NOW, events: [
      ev(id, "stage", { from: "build", to: "review" }, NOW - 40 * MIN),
      ev(id, "scheduler", { op: "plan", action: "review", node: "adversarial_review", recipient: "agent-rv-x" }, NOW - 23 * MIN),
    ], timeline: [{ stage: "build", from: NOW - 90 * MIN, to: NOW - 40 * MIN }, { stage: "review", from: NOW - 40 * MIN, to: NOW }],
    sessions: { author: { agent: "agent-dev" }, reviewer: { agent: "agent-rv-x", state: "active" } } };
  }
  return { ok: true, task, now: NOW, events: [], timeline: [], sessions: { author: { agent: "agent-dev" } } };
}

function center(): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true } };
  const feature = { id: "F1", projectId: PROJECT, title: "详情事项", description: FEATURE_LINE, rev: 1, version: 1, authorityMode: "planning" as const,
    homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const, counts: { total: 1, completed: 0, blocked: 0, missing: 0 },
    updatedBy: "person-a", updatedAt: NOW, projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const task = { taskId: "task-1", sourceTaskId: "MG1", sourceRev: 1, sourceSeq: 9, stage: "merge", assigneeCode: "peer-dev", executorInstanceId: HOME,
    pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] };
  const detail = { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: [{ key: "MG1", oneLine: "别的机器的合并卡", deps: [], fileGlobs: [], estimate: "" }], bindings: [{ nodeKey: "MG1", taskId: "task-1" }] },
    tasks: [task] } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}

/** 本机 /work（UXCARD3）：只放 BD1 和三张新卡，RV1 不在快照里走回退；workOn = false 时回 404（快照没到） */
const wrow = (id: string, p: Record<string, unknown>) => ({ taskId: id, featureId: null, nodeKey: null, title: id, who: "agent-dev", machine: "local", step: "write",
  round: 1, since: NOW - 12 * MIN, normalMinutes: 60, remainingMinutes: 40, overMinutes: 0, reason: null, code: null, estimate: "", ...p });
const WORK = { now: NOW, asOfSeq: 1, machines: { local: 1, alice: 1 }, completionHours: null, availableSlots: 1,
  working: [wrow("BD1", {}), wrow("LD1", { who: "peer:alice · codex", machine: "alice", since: NOW - 15 * MIN })],
  waiting: [wrow("MN1", { step: "fix", round: 5, code: "manual", reason: "退回人工（manual）：缺凭据", since: NOW - 50 * MIN })],
  todo: { ready: [], blocked: [] }, legacy: [{ taskId: "OLD1", title: "老卡", stage: "review" }], legacyTotal: 1 };
let workOn = true;

const calls: string[] = [];
let snapshot = false;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const home = ledger(), c = center();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${PROJECT}`) return json({ ok: true, ...home });
    const task = url.pathname.match(new RegExp(`^/api/v1/ledger/${PROJECT}/tasks/(\\w+)$`));
    if (task) return json(detail(home, task[1]!));
    if (url.pathname === `/api/v1/ledger/${PROJECT}/work` && workOn) return json(WORK);
    if (url.pathname === "/api/v1/agents") return json({ ok: true, agents: [{ name: "agent-dev", status: "active", busy: true }, { name: "agent-lend-ph", status: "active" }] });
    if (url.pathname === "/api/v1/agents/agent-dev/interrupt" || url.pathname === "/api/v1/agents/dev/interrupt") return json({ ok: true });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(c.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(c.detail);
    if (url.pathname === "/api/v1/shared-ledger/context" && snapshot) return json({ identities: [{ ...IDENTITY, localProjectId: PROJECT }] });
    if (url.pathname === "/api/v1/shared-projects/snapshot" && snapshot) return json({ v: 1, identity: { subject: "owner:self", kind: "person",
      centerId: "center", teamId: "team-a", personId: "person-a", instanceId: "mine-1" }, teamRole: { available: true, value: "member" },
      capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [],
      peers: [{ name: "alice-mac", enabled: true, invitable: true, instanceId: HOME }] });
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  nav = await import(mod("collab/collab-nav.ts"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const sharedNav = await import(mod("collab/dag/shared-navigation.tsx"));
  const cards = await import(mod("collab/dag/node-card-section.tsx"));
  const SeedAgents = () => {
    const api = store.useChatStoreApi();
    React.useEffect(() => void api.loadAgents(), [api]);
    return null;
  };
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, SeedAgents,
    sharedCollabProject: sharedNav.sharedCollabProject, NodeCardSection: cards.NodeCardSection, PlannedNodeSections: cards.PlannedNodeSections };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  nav.closeCollab();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);

async function render(node: unknown) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(node as never));
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

let n = 0;
async function open(id: string, side: "local" | "team", width = 1280) {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  const identity = { ...IDENTITY, person: `person-${++n}` };
  const project = side === "team" ? ui.sharedCollabProject(identity) : PROJECT;
  nav.openCollab(project);
  nav.openCollabTask(id);
  const view = h(ui.CollabView, { project });
  const r = await render(h(ui.ChatStoreProvider, null, h(ui.SeedAgents), side === "team" ? h(ui.TeamSource, { identity }, view) : view));
  const panel = () => Array.from(doc.body.querySelectorAll("aside")).find((a) => (a.textContent ?? "").includes(id)) ?? null;
  const ready = () => /参与者/.test(panel()?.textContent ?? "") && !/正在读取/.test(panel()?.textContent ?? "");
  for (let i = 0; i < 150 && !ready(); i++) await tick();
  await tick(80);
  // 「谁在干活」快照：本机 /work 回来后详情换成快照的句子（RV1 不在快照里，照旧）
  if (side === "local" && workOn) for (let i = 0; i < 100 && !calls.includes(`GET /api/v1/ledger/${PROJECT}/work`); i++) await tick();
  await tick(80);
  const p = panel()!;
  const sec = (title: string) => {
    const hit = Array.from(p.querySelectorAll("h5")).find((x) => (x.textContent ?? "").trim().startsWith(title));
    return hit ? hit.parentElement.textContent ?? "" : null;
  };
  return {
    p, sec, text: () => p.textContent ?? "",
    goal: () => p.querySelector("aside > div > div")?.textContent ?? "",
    stop: () => p.querySelector("[data-stop-round]"),
    ems: () => Array.from(p.querySelectorAll("em")).map((e) => e.textContent ?? ""),
    unmount: async () => { await r.unmount(); nav.closeCollab(); },
  };
}

for (const width of [1280, 390]) {
  test(`[验收线 1][验收线 2][验收线 3] ${width} 宽 本机审查卡：审查员 rv-x 在审第 2 轮 · 已 23分 + 下一步；目标句；阶段格无「—」`, async () => {
    const v = await open("RV1", "local", width);
    expect(v.sec("现在")).toContain("审查员 rv-x 在审第 2 轮 · 已 23分");
    expect(v.sec("现在")).toContain("下一步：审查员给结论（通过进合并，不通过回执行者）");
    expect(v.goal()).toContain(GOAL);
    expect(v.text()).not.toContain(FEATURE_LINE);
    // 有部分时长：开发、审查两格写时长，其余格子空，不写「—」
    expect(v.ems().filter(Boolean)).toEqual(["50分", "40分"]);
    expect(v.sec("阶段与用时")).not.toContain("—");
    await v.unmount();
  });
}

test("[验收线 2][验收线 3][验收线 5] 本机开发卡：没有目标句不显示灰字、找不到事项描述；阶段条无时长；叫停两次确认才发一次 interrupt", async () => {
  const v = await open("BD1", "local");
  expect(v.sec("现在")).toContain("执行者 dev 在写 · 已 12分");
  expect(v.sec("现在")).toContain("下一步：执行者送审");
  expect(v.text()).not.toContain(FEATURE_LINE);
  expect(v.ems()).toEqual([]);
  expect(v.sec("阶段与用时")).not.toContain("—");
  const stop = v.stop()!;
  expect(stop.textContent).toBe("叫停这一轮");
  expect(stop.getAttribute("title")).toContain("卡不退回、调度照常");
  const interrupts = () => calls.filter((c) => c.startsWith("POST") && c.endsWith("/interrupt"));
  await React.act(async () => stop.click());
  await tick(50);
  expect(interrupts()).toEqual([]);
  expect(v.stop()!.textContent).toBe("确认叫停");
  await React.act(async () => v.stop()!.click());
  await tick(80);
  expect(interrupts()).toEqual(["POST /api/v1/agents/dev/interrupt"]);
  expect(v.stop()!.textContent).toBe("已叫停");
  await v.unmount();
});

test("[验收线 5] 点一次过了 5 秒不再算确认：退回「叫停这一轮」，再点一次仍不发", async () => {
  const v = await open("BD1", "local");
  const before = calls.filter((c) => c.endsWith("/interrupt")).length;
  await React.act(async () => v.stop()!.click());
  await tick(5_200);
  expect(v.stop()!.textContent).toBe("叫停这一轮");
  await React.act(async () => v.stop()!.click());
  await tick(50);
  expect(calls.filter((c) => c.endsWith("/interrupt")).length).toBe(before);
  await v.unmount();
}, 15_000);

for (const named of [false, true]) {
  test(`[验收线 6] 别的机器为主场的合并卡（${named ? "快照有 peer 名" : "查不到机器名"}）：一句话 / 对它说 / 参与者写机器名，无叫停、无长十六进制`, async () => {
    snapshot = named;
    const machine = named ? "alice-mac" : "其他成员的机器";
    const v = await open("MG1", "team");
    for (let i = 0; i < 50 && !v.text().includes(machine); i++) await tick();
    expect(v.sec("现在")).toContain(`等合并 · 在 ${machine}`);
    expect(v.sec("对它说")).toContain(`这张卡在 ${machine} 上执行，对它说要那台机器授权，暂不支持`);
    expect(v.sec("参与者")).toContain("peer-dev");
    expect(v.sec("参与者")).toContain(machine);
    expect(v.stop()).toBeNull();
    expect(v.sec("阶段与用时")).not.toContain("—");
    expect(v.text()).not.toMatch(/[0-9a-f]{16,}/i);
    expect(v.text()).not.toContain(FEATURE_LINE);
    await v.unmount();
  });
}

const node = (p: Partial<BoardNode>): BoardNode => ({ key: "N1", taskId: "BD1", oneLine: "节点一句话", deps: [], estimate: "", inheritedFrom: null, fileGlobs: GLOBS,
  status: "build", statusAtVersion: "build", title: null, satisfied: false, ready: true, missing: false, phase: "write", round: null, handler: null, stepLine: null,
  ...p } as BoardNode);
const feature = (nodes: BoardNode[]): FeatureCard => ({ id: "F1", title: "详情事项", status: "active", ownerWords: "", currentVersion: 1, version: null, pending: null,
  counts: { total: 1 }, lastActivityAt: null, nodes } as unknown as FeatureCard);
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));

test("[验收线 4] 卡片详情的文件范围默认折叠成「文件范围 · 19 个」，点开列全；计划节点页照旧展开", async () => {
  const n1 = node({});
  const card = await render(h(ui.NodeCardSection, { card: { feature: feature([n1]), node: n1 }, owner: null, onOwner: () => {}, onNode: () => {}, tr }));
  const text = () => card.host.textContent ?? "";
  expect(text()).toContain("文件范围 · 19 个");
  expect(GLOBS.some((g) => text().includes(g))).toBe(false);
  const fold = card.host.querySelector("[data-node-files]")!;
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  await React.act(async () => fold.click());
  expect(GLOBS.every((g) => text().includes(g))).toBe(true);
  await card.unmount();
  const planned = node({ taskId: null, status: "planned" });
  const page = await render(h(ui.PlannedNodeSections, { feature: feature([planned]), node: planned, tr }));
  expect(GLOBS.every((g) => (page.host.textContent ?? "").includes(g))).toBe(true);
  expect(page.host.querySelector("[data-node-files]")).toBeNull();
  await page.unmount();
});

// ———— followup-reliability-UXCARD3 [验收线 1]：叫停 / 对它说的可见性读「谁在干活」快照 ————
for (const width of [1280, 390]) {
  test(`[验收线 1] ${width} 宽 出借写卡：现在写 peer 机器和家族；本机占位会话在线也没有叫停；对它说写在伙伴机器上`, async () => {
    const v = await open("LD1", "local", width);
    // 先看叫停：main 上执行者 / 占位会话在线就出按钮（旧红）
    expect(v.stop()).toBeNull();
    expect(v.sec("现在")).toContain("alice 上的 codex 在写 · 已 15分");
    expect(v.sec("现在")).not.toContain("lend-ph");
    expect(v.sec("对它说")).toContain("执行者在伙伴机器上，从这里发不到");
    expect(v.p.querySelector("textarea")).toBeNull();
    await v.unmount();
  });

  test(`[验收线 1] ${width} 宽 退回人工：快照在等（manual）→ 写退回人工原因、下一步 PM 接手，不写「在改第 5 轮」，没有叫停`, async () => {
    const v = await open("MN1", "local", width);
    // 先看叫停：main 上执行者 / 占位会话在线就出按钮（旧红）
    expect(v.stop()).toBeNull();
    expect(v.sec("现在")).toContain("退回人工（manual）：缺凭据 · 已等 50分");
    expect(v.sec("现在")).toContain("下一步：PM 接手");
    expect(v.sec("现在")).not.toMatch(/在改第 \d+ 轮/);
    await v.unmount();
  });

  test(`[验收线 1] ${width} 宽 老卡：写老卡、不写时长和「超过 30 分钟」，执行者在线也没有叫停`, async () => {
    const v = await open("OLD1", "local", width);
    // 先看叫停：main 上执行者 / 占位会话在线就出按钮（旧红）
    expect(v.stop()).toBeNull();
    expect(v.sec("现在")).toContain("老卡（没有调度记录）· 停在审查，调度器不派活");
    expect(v.sec("现在")).toContain("下一步：PM 收尾或补调度记录");
    expect(v.sec("现在")).not.toMatch(/已等|超过 30 分钟|小时/);
    await v.unmount();
  });
}

test("[验收线 1] 快照没到（本机 /work 读不到）：开发卡执行者在线也不出叫停，句子按旧逻辑", async () => {
  workOn = false;
  try {
    const v = await open("BD1", "local");
    expect(v.sec("现在")).toContain("执行者 dev 在写 · 已 12分");
    expect(v.stop()).toBeNull();
    await v.unmount();
  } finally { workOn = true; }
});
