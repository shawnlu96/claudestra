/**
 * UXHOME1：「今天」总览（TODAY1 改名）真挂到 happy-dom（React 19）——真的 MessageList（没选会话时的主区）、真的 Sidebar（侧栏条 + 项目组 + 团队区）、
 * 真的 chat store / 待办 store / 团队绑定 store。全部 fetch 在这里拦下按合成数据答，夹具之外一律 404，不连任何 bridge。
 * 数据照规格「对照基准」：4 个 agent 其中 2 个忙；3 件等 owner 的 asks（1 件团队提案卡）；4 个项目（两个绑定团队：一个成组一个单成员；
 * 一个本机成组；一个本机单成员）。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 * 项目组里的「协作视图」行（collab-entry.tsx）在这里换成探针，只记它被要了哪个键、带不带「团队」小标：别的 dom 测试文件在同一进程里
 * 把它 mock 成空（mock.module 进程级生效），不换就看不到；它本身画小标的样子在 tests/web-now-home-browser.test.ts 的真页面里断言。afterAll 换回原样。
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { resolveCollabSource, setContextRequestForTest } from "../web/lib/collab-source-binding";
import { machines } from "../web/lib/machines";
import { sharedCollabProject } from "../web/features/collab/team-source-key";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; title: string; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void; closest(s: string): El | null;
  dispatchEvent(e: unknown): boolean; value: string;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void }; Event: new (t: string, o?: object) => unknown;
  HTMLInputElement: { prototype: object }; Storage: { prototype: { getItem(k: string): string | null; setItem(k: string, v: string): void } }; localStorage: { clear(): void } }

// 根 tsc 没有 --jsx：组件在运行时由 bun 转译加载
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let win: Win;
interface Store { state: { activeAgent: string; agents: unknown[]; projects: unknown[] }; loadAgents(): Promise<void>; loadProjects(): Promise<void> }
let ui: {
  MessageList: () => unknown; Sidebar: (p: { onSelect: () => void }) => unknown; NowStrip: () => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown; useChatStoreApi: () => Store;
  ChatNavContext: { Provider: (p: { value: unknown; children: unknown }) => unknown };
  asksStore: { get(): { open: boolean; focus: string | null; asks: unknown[] }; refresh(): Promise<void>; closeDrawer(): void };
  useCollabNav: () => { project: string | null }; closeCollab: () => void; unmountOpenViewGuard: () => void;
};

const FP = "mac-a";
const NOW = Date.now();
const ID = { center: "c1", team: "t1", person: "p1", homeInstanceId: "inst-a" };
const keyOf = (project: string) => sharedCollabProject({ machine: FP, ...ID, project });
const IDENTITIES = [{ ...ID, project: "center-group", localProjectId: "team-group" }, { ...ID, project: "center-solo", localProjectId: "team-solo" }];
const row = (name: string, projectId: string, over: object = {}) => ({ name: `agent-${name}`, status: "active", projectId, cwd: "/repo", lastActivityTs: NOW - 3600_000, busy: false, ...over });
const AGENTS = [
  row("dev-1", "team-group", { busy: true, label: "开发一号", lastActivityTs: NOW - 3 * 60_000, ledgerTask: { id: "UXHOME1", stage: "build", round: 0 } }),
  row("pm-a", "team-group"),
  row("rv-1", "local-group", { busy: true, lastActivityTs: null, ledgerReview: { id: "UXNUM1", round: 2, verdict: null, p0: 0, p1: 0, p2: 0 } }),
  row("idle-1", "local-group"),
  row("solo-t", "team-solo"),
  row("solo-l", "local-solo"),
];
const PROJECTS = [["local-solo", "本机单成员"], ["local-group", "本机成组"], ["team-solo", "团队单成员"], ["team-group", "团队成组"]]
  .map(([id, name]) => ({ id, name, emoji: null, dirs: [] }));
const ask = (id: string, over: object) => ({ id, fromAgent: null, assignee: null, project: "local-group", taskId: null, title: id, context: "", body: "", kind: "decide",
  kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null, createdAt: NOW, updatedAt: NOW,
  expiresAt: NOW + 86_400_000, canAnswer: true, ...over });
const ASKS = [
  ask("ask-old", { createdAt: NOW - 3 * 3600_000, title: "接口命名二选一" }),
  ask("ask-proposal", { createdAt: NOW - 600_000, project: "master", kind: "authorize", source: "system", title: "提案待你批准：卡片工作优先级",
    extra: { centerProposal: { localProjectId: "team-solo" } } }),
  ask("ask-mid", { createdAt: NOW - 3600_000, project: "team-group", title: "要不要拆卡" }),
];
const shared = (projectId: string, local: string, name: string) => ({ centerId: "c1", teamId: "t1", projectId, name, rev: 1, status: "active",
  projectRole: { available: true, value: "member" }, localProjectIds: [local] });
const SNAPSHOT = { v: 1, identity: { subject: "owner:self", kind: "person", centerId: "c1", teamId: "t1", personId: "p1", instanceId: "inst-a" },
  teamRole: { available: true, value: "member" }, capabilities: { invite: { available: false }, leave: { available: false } },
  projects: [shared("center-group", "team-group", "团队成组"), shared("center-solo", "team-solo", "团队单成员")],
  localProjects: PROJECTS.map((p) => ({ id: p.id, name: p.name, personal: false, eligible: false, dirs: [] })), peers: [] };
const LEDGER = { ok: true, exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks: [], deps: [] };

const world = { identities: IDENTITIES as object[] | "fail" };
const ENTRY = "@/features/collab/collab-entry";
let entryBefore: Record<string, unknown>;
/** 本文件挂上的根：用例中途失败也在 afterEach 卸掉，别把侧栏（带全局菜单）留给后面的测试文件 */
const live = new Set<() => Promise<void>>();
const calls: string[] = [];
const realFetch = globalThis.fetch, realFp = machines.currentFp;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  win = (globalThis as unknown as { window: Win }).window;
  machines.currentFp = () => FP;
  entryBefore = { ...require("../web/features/collab/collab-entry.tsx") };
  const h = (webRequire("react") as ReactNS).createElement as (...a: unknown[]) => unknown;
  mock.module(ENTRY, () => ({ ...entryBefore, CollabEntry: ({ projectId, team }: { projectId: string; team?: boolean }) =>
    h("li", { "data-entry": projectId }, h("span", null, "协作视图"), team ? h("span", { "data-collab-team-badge": "" }, "团队") : null) }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = url.pathname.replace(/^\/m\/[^/]+/, "");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: FP, machineName: "fixture", version: "" });
    if (path === "/api/v1/agents") return json({ ok: true, agents: AGENTS });
    if (path === "/api/v1/projects") return json({ ok: true, projects: PROJECTS });
    if (path === "/api/v1/asks") return json({ ok: true, asks: ASKS, now: NOW, canAnswer: true });
    if (path === "/api/v1/shared-ledger/context") return world.identities === "fail" ? json({ ok: false }, 503) : json({ identities: world.identities });
    if (path === "/api/v1/shared-projects/snapshot") return json(SNAPSHOT);
    // TODAY1：页面版读每个本机项目的台账，403 / 404 只出项目行；四个项目都答空台账，团队项目的 agent 行照 UXHOME1 出
    if (/^\/api\/v1\/ledger\/(local|team)-(group|solo)$/.test(path)) return json(LEDGER);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const [list, side, now, store, nav, asks, collabNav, viewEntry] = [
    require("../web/features/chat/components/message-list.tsx"), require("../web/features/chat/components/sidebar.tsx"),
    require("../web/features/now/now-home.tsx"), require("../web/features/chat/chat-store.ts"),
    require("../web/features/chat/components/nav-context.tsx"), require("../web/features/asks/asks-store.ts"),
    require("../web/features/collab/collab-nav.ts"), require("../web/features/collab/team-view-entry.tsx")];
  ui = { MessageList: list.MessageList, Sidebar: side.Sidebar, NowStrip: now.NowStrip, ChatStoreProvider: store.ChatStoreProvider, useChatStoreApi: store.useChatStoreApi,
    ChatNavContext: nav.ChatNavContext, asksStore: asks.asksStore, useCollabNav: collabNav.useCollabNav, closeCollab: collabNav.closeCollab,
    unmountOpenViewGuard: viewEntry.unmountOpenViewGuardForTest };
});

afterEach(async () => {
  for (const off of [...live]) await off();
  // 项目组入口起的常驻小根（team-view-entry.tsx）订着 machines、快照是本文件换过的 currentFp：不卸就留给后面的文件，一改 machines 就在注销后的 DOM 外重渲
  await React.act(async () => ui.unmountOpenViewGuard());
});

afterAll(async () => {
  mock.module(ENTRY, () => entryBefore);
  globalThis.fetch = realFetch;
  machines.currentFp = realFp;
  setContextRequestForTest(null);
  setAppConfigForTest(null); // 模块级缓存：别把夹具的 app-config 留给后面的测试文件
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}

/** 挂载：part 选主区 / 侧栏 / 只挂侧栏条；先把会话、项目、待办读进真 store（生产里由外壳读），绑定 store 由组件自己订 */
async function mount(part: "main" | "sidebar" | "strip", width = 1280, bindingsDown = false) {
  win.happyDOM.setViewport({ width, height: 900 });
  // 清掉上一个用例的绑定缓存，走默认请求（被上面的 fetch 接住）；bindingsDown = 只让绑定 store 这一份读失败（团队区自己那份快照照常）
  setContextRequestForTest(bindingsDown ? () => Promise.reject(new Error("HTTP 503")) : null);
  ui.closeCollab();
  ui.asksStore.closeDrawer();
  const seen = { toContent: 0, store: null as Store | null, open: null as string | null };
  const h = React.createElement as (...a: unknown[]) => unknown;
  function Probe() {
    seen.store = ui.useChatStoreApi();
    seen.open = ui.useCollabNav().project;
    return null;
  }
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  // 一建根就登记：后面的渲染 / 读数抛错也由 afterEach 卸掉
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await React.act(async () => root.unmount());
    host.remove();
  };
  live.add(unmount);
  const body = part === "main" ? h(ui.MessageList) : part === "sidebar" ? h(ui.Sidebar, { onSelect: () => { seen.toContent++; } }) : h(ui.NowStrip);
  const nav = { showContent: false, toContent: () => { seen.toContent++; }, toList: () => {} };
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.ChatNavContext.Provider, { value: nav }, h(Probe), body)) as never));
  await React.act(async () => { await Promise.all([seen.store!.loadAgents(), seen.store!.loadProjects(), ui.asksStore.refresh()]); });
  const click = async (el: El | null | undefined, what: string) => {
    if (!el) throw new Error(`no ${what}`);
    await React.act(async () => el.click());
    await tick(30);
  };
  const all = (sel: string) => Array.from(host.querySelectorAll(sel));
  const texts = (sel: string) => all(sel).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  return { host, seen, click, all, texts, text: () => (host.textContent ?? "").replace(/\s+/g, " "), unmount };
}

test("[验收线 2] 桌面没选会话时主区是『今天』页，三块齐全；DOM 里不再有『选择左侧一个会话开始』", async () => {
  const v = await mount("main");
  await until(() => v.all("[data-now-worker]").length === 2 && v.all("[data-now-project]").length === 4 && v.all("[data-now-wait]").length === 3, "now page");
  expect(v.host.querySelector("[data-now=page]")).not.toBeNull();
  expect(v.text()).not.toContain("选择左侧一个会话开始");
  expect(v.host.querySelector("[data-now-summary]")?.textContent).toBe("3 件要你处理 · 2 个 agent 在干活");
  expect(v.texts("section h3")).toEqual(["要你处理3 件", "正在做2 个 agent 在干活", "团队与额度"]);
  // 在干活：名字（显示名优先）· 在做什么 · 最近动静；没有 lastActivityTs 的不写时间（TODAY1 起按项目分组：本机成组在团队成组之前）
  expect(v.texts("[data-now-worker] [data-now-doing]")).toEqual(["审 UXNUM1 第 2 轮", "UXHOME1 开发中"]);
  expect(v.texts("[data-now-worker]")[1]).toContain("开发一号");
  expect(v.all("[data-now-worker]").map((e) => e.querySelector("[data-now-ago]")?.textContent ?? null)).toEqual([null, "3分钟前"]);
  // 等你的事：按时间倒序，带来自哪个项目
  expect(v.all("[data-now-wait]").map((e) => e.getAttribute("data-now-wait"))).toEqual(["ask-proposal", "ask-mid", "ask-old"]);
  expect(v.texts("[data-now-wait]")[0]).toBe("提案待你批准：卡片工作优先级团队单成员去处理");
  // 各项目：有等你的在前；单成员项目也在；数字带单位
  expect(v.all("[data-now-project]").map((e) => e.getAttribute("data-now-project"))).toEqual(["local-group", "team-solo", "team-group", "local-solo"]);
  expect(v.texts("[data-now-project=team-group]")[0]).toBe("团队成组团队在干活 1 个 agent待你处理 1 件");
  expect(v.texts("[data-now-project=local-solo]")[0]).toBe("本机单成员");
  // 不新增请求：除了外壳本来就读的会话 / 未读 / 项目 / 待办，只有团队绑定那一份（项目组入口读的同一个 store）
  // TODAY1 起页面版另读各项目台账 / 产品看板、事件流、额度（规格 PM 定 9）：逐条点名、恰好各一次，从外壳请求里拿出去，其余照原断言
  // 「不新增请求」这条被 PM 定 9 替代（规格「PM 定 · 10-14 19:3x」，答 ask_mv7z1jsx09c286a52a）：白名单正则原样，GET /quota 必须 0 次
  // QUOTA1：额度行的状态字（用完 · 时间重置）要读闸，另读 GET /quota/wall 一次（与顶部额度卡共用一份轮询）
  const today = ["GET /api/v1/events", "GET /api/v1/lend/quota-lines", "GET /api/v1/quota/wall", ...PROJECTS.flatMap((p) => [`GET /api/v1/ledger/${p.id}`, `GET /api/v1/ledger/${p.id}/product`])];
  expect(calls.filter((c) => today.includes(c)).sort()).toEqual([...today].sort());
  expect(calls.filter((c) => /\/quota$/.test(c))).toEqual([]);
  const shell = calls.filter((c) => !today.includes(c));
  expect(shell.filter((c) => !/^GET \/(app-config\.json|api\/v1\/(agents|unread|projects|asks|shared-ledger\/context))$/.test(c))).toEqual([]);
  await v.unmount();
});

test("[验收线 3] 点『等你的事』一条打开收件箱并定位；点『在干活』一行打开该会话；点项目打开协作视图（绑定团队的开中心键，和项目组入口同一个）", async () => {
  const v = await mount("main");
  await until(() => v.all("[data-now-project]").length === 4 && !v.host.querySelector("[data-collab-blocked]"), "bindings");
  await v.click(v.host.querySelector("[data-now-wait=ask-mid]"), "wait row");
  expect(ui.asksStore.get()).toMatchObject({ open: true, focus: "ask-mid" });
  ui.asksStore.closeDrawer();

  await v.click(v.host.querySelector("[data-now-project=team-group]"), "team project");
  const entry = resolveCollabSource(IDENTITIES, "team-group", FP); // 项目组入口（team-view-entry.tsx）用的同一个函数、同一份绑定
  expect(entry.kind).toBe("center");
  expect(v.seen.open).toBe(entry.kind === "center" ? entry.key : "");
  expect(v.seen.open).toBe(keyOf("center-group"));
  expect(v.seen.toContent).toBe(1);
  await v.unmount();

  const w = await mount("main");
  await until(() => w.all("[data-now-project]").length === 4, "projects");
  await w.click(w.host.querySelector("[data-now-project=local-solo]"), "local project");
  expect(w.seen.open).toBe("local-solo");
  await w.unmount();

  const a = await mount("main");
  await until(() => a.all("[data-now-worker]").length === 2, "workers");
  await a.click(a.host.querySelector("[data-now-worker=dev-1]"), "worker row");
  await until(() => a.seen.store!.state.activeAgent === "dev-1", "open agent");
  expect(a.seen.open).toBeNull();
  expect(a.seen.toContent).toBe(1);
  await a.unmount();
});

test("[验收线 2] 侧栏条：收起时一行『今天 · 3 件要你处理 · 2 个 agent 在干活』，点开展开三块，再点收起；展开状态记在本机", async () => {
  win.localStorage.clear();
  const v = await mount("strip", 390);
  await until(() => v.all("[data-now-worker]").length === 2, "strip data");
  const strip = () => v.host.querySelector("[data-now=strip]")!;
  const toggle = () => strip().querySelector("button[aria-expanded]")!;
  const fold = () => strip().querySelector("[data-now-blocks]")!.closest("[inert]");
  expect(toggle().textContent).toBe("今天· 3 件要你处理 · 2 个 agent 在干活");
  expect([strip().getAttribute("data-now-open"), toggle().getAttribute("aria-expanded"), fold() !== null]).toEqual(["0", "false", true]);
  await v.click(toggle(), "strip toggle");
  expect([strip().getAttribute("data-now-open"), toggle().getAttribute("aria-expanded"), fold() !== null]).toEqual(["1", "true", false]);
  expect(v.texts("[data-now=strip] section h3")).toEqual(["要你处理3 件", "正在做2 个 agent 在干活", "团队与额度"]);
  await v.unmount();
  // 记住了：重新挂载直接是展开的
  const again = await mount("strip", 390);
  expect(again.host.querySelector("[data-now=strip]")!.getAttribute("data-now-open")).toBe("1");
  await again.click(again.host.querySelector("[data-now=strip] button[aria-expanded]"), "strip toggle");
  expect(again.host.querySelector("[data-now=strip]")!.getAttribute("data-now-open")).toBe("0");
  await again.unmount();
  const third = await mount("strip", 390);
  expect(third.host.querySelector("[data-now=strip]")!.getAttribute("data-now-open")).toBe("0");
  await third.unmount();
});

test("[验收线 2] localStorage 读写都抛错：页面照常，侧栏条是收起态，点开照样展开", async () => {
  const proto = win.Storage.prototype, real = { get: proto.getItem, set: proto.setItem };
  proto.getItem = () => { throw new Error("SecurityError"); };
  proto.setItem = () => { throw new Error("QuotaExceededError"); };
  try {
    const v = await mount("strip", 390);
    await until(() => v.all("[data-now-worker]").length === 2, "strip data");
    const strip = v.host.querySelector("[data-now=strip]")!;
    expect(strip.getAttribute("data-now-open")).toBe("0");
    await v.click(strip.querySelector("button[aria-expanded]"), "strip toggle");
    expect(strip.getAttribute("data-now-open")).toBe("1");
    await v.unmount();
  } finally {
    proto.getItem = real.get;
    proto.setItem = real.set;
  }
});

test("[验收线 2] 绑定读不到时团队项目也不乱开本机：各项目行不可点、title 写原因；超过 6 个项目折叠成『其余 K 个项目』", async () => {
  world.identities = "fail";
  const extra = Array.from({ length: 5 }, (_, i) => ({ id: `more-${i}`, name: `更多 ${i}`, emoji: null, dirs: [] }));
  PROJECTS.push(...extra);
  try {
    const v = await mount("main");
    await until(() => v.all("[data-now-project]").length === 6 && v.all("[data-collab-blocked=checking]").length === 6, "blocked rows");
    const blocked = v.host.querySelector("[data-now-project=team-group]")!;
    expect([blocked.getAttribute("aria-disabled"), blocked.getAttribute("title")]).toEqual(["true", "团队成组 · 团队绑定暂时读不到，稍后自动重试"]);
    await v.click(blocked, "blocked row");
    expect([v.seen.open, v.seen.toContent]).toEqual([null, 0]);
    const more = v.host.querySelector("[data-now-project-all]")!;
    expect(more.textContent).toBe("其余 3 个项目");
    await v.click(more, "show all");
    expect(v.all("[data-now-project]")).toHaveLength(9);
    await v.unmount();
  } finally {
    world.identities = IDENTITIES;
    PROJECTS.length = 4;
  }
});

test("[验收线 4] 侧栏：区头是『团队』；已成组的绑定项目不在团队区重复，单成员绑定项目的行仍在、点了开中心键；绑定项目组的协作视图行有『团队』小标，本机的没有", async () => {
  win.localStorage.clear();
  const v = await mount("sidebar");
  const area = () => v.host.querySelector("section[aria-label='团队项目']");
  await until(() => !!area() && area()!.querySelectorAll("button[aria-label]").length > 0, "sidebar team area");
  expect(area()!.querySelector("h2")?.textContent).toBe("团队");
  expect(v.text()).not.toContain("全部 feature");
  expect(Array.from(area()!.querySelectorAll("button[aria-label]")).map((b) => b.getAttribute("aria-label"))).toEqual(["团队单成员"]);
  expect(Array.from(area()!.querySelectorAll("button")).some((b) => b.textContent === "项目设置")).toBe(true);
  // 侧栏条在团队区之上
  const order = v.all("[data-now=strip], section[aria-label='团队项目']").map((e) => e.getAttribute("data-now") ?? "team");
  expect(order).toEqual(["strip", "team"]);
  // 项目组里的「协作视图」行：绑定团队的要中心键、带小标；本机的要本机项目 id、不带（探针记下的就是真入口拿到的参数）
  await until(() => v.all("[data-entry]").length === 2, "collab entries");
  const entries = Object.fromEntries(v.all("[data-entry]").map((e) => [e.getAttribute("data-entry"), e.querySelector("[data-collab-team-badge]")?.textContent ?? null]));
  expect(entries).toEqual({ [keyOf("center-group")]: "团队", "local-group": null });
  // 团队区保留行与项目组入口：同一个选源函数，开的是同一个拼法的中心键
  await v.click(area()!.querySelector("button[aria-label='团队单成员']"), "team row");
  const solo = resolveCollabSource(IDENTITIES, "team-solo", FP);
  expect(v.seen.open).toBe(solo.kind === "center" ? solo.key : "");
  expect(v.seen.open).toBe(keyOf("center-solo"));
  await v.unmount();
});

test("[验收线 4] 搜索时侧栏不成组，团队区列出全部行；选不出源的行变灰并带原因、点了不开", async () => {
  const v = await mount("sidebar");
  const area = () => v.host.querySelector("section[aria-label='团队项目']");
  const names = () => Array.from(area()?.querySelectorAll("button[aria-label]") ?? []).map((b) => b.getAttribute("aria-label"));
  await until(() => names().length === 1, "team area");
  const input = v.host.querySelector("input[type=search]")!;
  await React.act(async () => {
    const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "dev");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await until(() => names().length === 2, "all rows while searching");
  expect(names()).toEqual(["团队成组", "团队单成员"]);
  await v.unmount();

  // 团队区自己的快照读到了，但选源用的那份绑定这一轮没读到（checking）：行还在，变灰、写原因，点了不开（以前是点了没反应也没说明）
  const b = await mount("sidebar", 1280, true);
  const rowOf = () => b.host.querySelector("section[aria-label='团队项目'] button[aria-label='团队单成员']");
  await until(() => rowOf()?.getAttribute("data-collab-blocked") === "checking", "blocked team row");
  expect([rowOf()!.getAttribute("aria-disabled"), rowOf()!.getAttribute("title")]).toEqual(["true", "团队单成员 · 团队绑定暂时读不到，稍后自动重试"]);
  await b.click(rowOf(), "blocked team row");
  expect(b.seen.open).toBeNull();
  await b.unmount();
});
