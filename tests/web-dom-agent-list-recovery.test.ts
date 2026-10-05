/**
 * list-recovery-AGL2：会话列表首拉慢 / 失败 / 重试 / 成功空 / 后续失败保留旧列表 / 过期响应 / 卸载清计时器。
 * 真挂 ChatStoreProvider + Splash + AgentListNotice + SidebarDirectory（happy-dom + React 19，guard TESTS_WEB_DOM），
 * 列表请求走真 chat-store → lib/chat/agents loadAgents → lib/api/client api() 的 promise 链；fetch 换成本文件的合成 API
 * （手动放行 / 失败，尊重 abort），不连任何真实 bridge。列表的计时器走 setAgentListClockForTest 注入的假时钟。
 * 纯逻辑（退避 / 视图推导）见 tests/web-agent-list-state.test.ts。
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { AgentListClock } from "../web/features/chat/agent-list-loader";
import type { SidebarEntry, TeamNode } from "../web/features/chat/sidebar-entries";
import type { AgentSession } from "../web/features/chat/type";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; disabled?: boolean; getAttribute(n: string): string | null; click(): void;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; contains(o: El): boolean;
}
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: El & { appendChild(c: Host): void } }
interface Folds { projects: Set<string>; toggleProject(id: string): void; teams: Set<string>; toggleTeam(id: string): void }

// mock.module 对整个 bun test 进程生效：先取真模块再只覆盖用到的导出
const partial = async (path: string, over: Record<string, unknown>) => {
  const real = await import(path);
  mock.module(path, () => ({ ...real, ...over }));
};
await partial("@/features/chat/contacts-data", { useFullScope: () => false });
await partial("@/features/chat/host-info", { useHostInfo: () => ({ local: false, platform: "darwin", openers: [] }) });
await partial("@/features/chat/components/agent-dnd", { useAgentDrop: () => ({ over: false, handlers: {} }) });
await partial("@/features/collab/collab-entry", { CollabEntry: () => null });
// build-info 是构建时生成的（CI 的根测试不生成）；版本角标与本卡无关
mock.module("@/lib/build-info", () => ({ CLIENT_COMMIT: "", CLIENT_WEB_COMMIT: "", CLIENT_VERSION: "" }));
await partial("@/features/machines/use-version", { useVersionInfo: () => null });

/** 假时钟：只给列表 loader 用（React / Splash 自己的计时照旧走真时钟） */
class FakeClock implements AgentListClock {
  t = 1_800_000_000_000;
  private seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  isHidden = false;
  now = () => this.t;
  random = () => 0.5;
  hidden = () => this.isHidden;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id; };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  /** 往前拨，按到点顺序触发 */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      await act(async () => due[1].fn());
    }
    this.t = end;
    await settle();
  }
}

/** 合成 API：每个 GET /api/v1/agents 挂起，测试手动放行 / 失败；signal abort 即以 abort 拒绝 */
interface Pending { signal?: AbortSignal; aborted: boolean; settled: boolean; ok(agents: unknown[]): void; status(code: number): void }
const pending: Pending[] = [];
const otherCalls: string[] = [];
const realFetch = globalThis.fetch;
// 倒计时 / Splash 的真时钟在 act 外触发的提交只是噪音（它们会打印整棵 DOM），其余 console.error 照常
const realConsoleError = console.error;
console.error = (...a: unknown[]) => { if (!String(a[0]).includes("not wrapped in act")) realConsoleError(...a); };
function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/app-config.json") return Promise.resolve(json({ mode: "direct", fp: "local", machineName: "fixture", version: "" }));
  if (url.pathname !== "/api/v1/agents") {
    otherCalls.push(url.pathname);
    return Promise.resolve(json({ ok: false, error: "not in fixture" }, 404));
  }
  return new Promise((resolve, reject) => {
    const p: Pending = {
      signal: init?.signal ?? undefined, aborted: false, settled: false,
      ok: (agents) => { p.settled = true; resolve(json({ ok: true, agents })); },
      status: (code) => { p.settled = true; resolve(json({ ok: false, error: `fixture ${code}` }, code)); },
    };
    init?.signal?.addEventListener("abort", () => { p.aborted = true; reject(init.signal!.reason); }, { once: true });
    pending.push(p);
  });
}

const mod = (p: string) => new URL(`../web/features/chat/${p}`, import.meta.url).href;
let React: ReactNS;
let act: (fn: () => Promise<void>) => Promise<void>;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let storage: { clear(): void; getItem(k: string): string | null };
let i18n: { setLang(l: "zh" | "en"): void };
let setClock: (c: AgentListClock | null) => void;
let ui: {
  ChatStoreProvider: unknown; useChatStoreApi: () => Store; useChatStore: <T>(sel: (s: { state: { agents: AgentSession[] } }) => T) => T;
  Splash: unknown; AgentListNotice: unknown; SidebarDirectory: unknown; useDirectoryFolds: (s: "active" | "history") => Folds;
  ProjectGroup: unknown; TeamGroup: unknown; buildSidebarDirectory: typeof import("../web/features/chat/sidebar-history").buildSidebarDirectory;
};
interface Store {
  startAgentList(): () => void; loadAgents(r?: string): Promise<void>; refreshAgents(r?: string): Promise<void>; resetForMachine(): void;
  state: { agents: AgentSession[]; agentList: { failures: number; loaded: boolean } };
}
let clock: FakeClock;
let store: Store | null = null;

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const wire = (name: string, p: Partial<Record<string, unknown>> = {}) => ({ name, status: "active", projectId: "p", lastActivityTs: 1000, ...p });
const TWO = [wire("lead"), wire("kid", { parent: "lead" })];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = fakeFetch as typeof fetch;
  React = webRequire("react") as ReactNS;
  act = React.act as never;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  storage = (globalThis as unknown as { localStorage: typeof storage }).localStorage;
  i18n = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href);
  ({ setAgentListClockForTest: setClock } = await import(mod("agent-list-loader.ts")));
  const st = await import(mod("chat-store.ts"));
  const splash = await import(mod("components/splash.tsx"));
  const notice = await import(mod("components/agent-list-status.tsx"));
  const dir = await import(mod("components/sidebar-history.tsx"));
  const pg = await import(mod("components/project-group.tsx"));
  const tg = await import(mod("components/team-group.tsx"));
  const sh = await import(mod("sidebar-history.ts"));
  ui = { ChatStoreProvider: st.ChatStoreProvider, useChatStoreApi: st.useChatStoreApi, useChatStore: st.useChatStore, Splash: splash.Splash,
    AgentListNotice: notice.AgentListNotice, SidebarDirectory: dir.SidebarDirectory, useDirectoryFolds: dir.useDirectoryFolds,
    ProjectGroup: pg.ProjectGroup, TeamGroup: tg.TeamGroup, buildSidebarDirectory: sh.buildSidebarDirectory };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  setAppConfigForTest(null);
  setClock(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  storage.clear();
  pending.length = 0;
  otherCalls.length = 0;
  clock = new FakeClock();
  setClock(clock);
  i18n.setLang("zh");
});
afterEach(() => { store = null; });

/** 与 chat.tsx 同接线：挂载即 startAgentList + 首拉，卸载调清理；列表用真 SidebarDirectory 渲染（带折叠偏好） */
function Harness() {
  const h = React.createElement;
  const api = ui.useChatStoreApi();
  store = api;
  React.useEffect(() => {
    const stop = api.startAgentList();
    void api.loadAgents();
    return stop;
  }, [api]);
  const agents = ui.useChatStore((s) => s.state.agents);
  const folds = ui.useDirectoryFolds("active");
  const d = ui.buildSidebarDirectory(agents, new Map());
  const row = (a: AgentSession, s?: { lead?: unknown }) => h("li", { key: a.name, "data-agent": a.name }, (s?.lead as never) ?? null, a.name);
  const team = (n: TeamNode, f: Folds) =>
    h(ui.TeamGroup as never, { key: `t:${n.a.name}`, node: n, collapsed: f.teams.has(n.a.name), busy: false, onToggle: () => f.toggleTeam(n.a.name), row });
  const renderEntry = (e: SidebarEntry, f: Folds) => e.kind === "row" ? team(e, f)
    : h(ui.ProjectGroup as never, { key: `g:${e.id}`, e, collapsed: f.projects.has(e.id), groupBusy: false, onToggle: () => f.toggleProject(e.id) },
      e.nodes.map((n) => team(n, f)));
  return h("div", null,
    h(ui.Splash as never),
    h("aside", null, h(ui.AgentListNotice as never, { count: agents.length }),
      h(ui.SidebarDirectory as never, { activeEntries: d.activeEntries, historyEntries: d.historyEntries, historyCount: d.historyCount, activeFolds: folds, renderEntry })));
}

async function mount() {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await act(async () => root.render(React.createElement(ui.ChatStoreProvider as never, null, React.createElement(Harness))));
  await settle();
  const buttons = () => Array.from(host.querySelectorAll("button"));
  return {
    host,
    /** 侧栏状态行（splash 里的那条不算） */
    notice: () => host.querySelector("aside [data-agent-list]") !== null,
    noticeText: () => host.querySelector("aside [data-agent-list]")?.textContent ?? "",
    view: () => host.querySelector("aside [data-agent-list]")?.getAttribute("data-agent-list") ?? "list",
    splashStatus: () => host.querySelector(".fixed [data-agent-list]"),
    splash: () => host.querySelector(".fixed.inset-0") !== null,
    shown: () => Array.from(host.querySelectorAll("[data-agent]")).map((e) => e.getAttribute("data-agent")),
    button: (text: string, scope = "") => buttons().find((b) => (b.textContent ?? "").trim() === text && (!scope || host.querySelector(scope)?.contains(b))),
    click: async (b: El | null | undefined) => { await act(async () => b!.click()); await settle(); },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const open = () => pending.filter((p) => !p.settled && !p.aborted);
const last = () => pending[pending.length - 1]!;
const answer = async (fn: (p: Pending) => void, p = last()) => { await act(async () => fn(p)); await settle(); };
/** Splash 的退场是「定时 → 状态 → 下一个 effect 再定时」，每段之间要让 act 提交一次 */
const waitReal = async (ms: number) => {
  for (let left = ms; left > 0; left -= 100) await act(async () => { await new Promise((r) => realSetTimeout(r, 100)); });
};
const realSetTimeout = globalThis.setTimeout;

test("首拉慢：先「加载中」，3s 后说「较慢」，轮询合流不叠请求；成功后出列表、Splash 退场", async () => {
  const u = await mount();
  expect(pending).toHaveLength(1);
  expect(u.view()).toBe("waiting");
  expect(u.noticeText()).toBe("加载中…");
  expect(u.splash()).toBe(true);
  expect(u.splashStatus() === null).toBe(true); // 不慢时启动页不多话
  await clock.advance(3_000);
  expect(u.view()).toBe("slow");
  expect(u.noticeText()).toBe("会话列表加载较慢，仍在连接…");
  expect(u.splashStatus()?.textContent).toContain("先进入");
  // 15s 轮询 / 回前台撞上在途慢请求：合流，不另发
  await act(async () => { void store!.refreshAgents("poll"); void store!.refreshAgents("event"); });
  await clock.advance(15_000);
  expect(pending).toHaveLength(1);
  await answer((p) => p.ok(TWO));
  expect(u.notice()).toBe(false);
  expect(u.shown()).toEqual(["lead", "kid"]);
  expect(clock.timers.size).toBe(0);
  await waitReal(1_300); // Splash 最短展示 600ms + 淡出 500ms（真时钟）
  expect(u.splash()).toBe(false);
  await u.unmount();
});

test("首拉失败：不显示「暂无会话」，有界退避重试；先进入不假装成功；手动重试后成功的空列表才是空态", async () => {
  const u = await mount();
  await answer((p) => p.status(503));
  expect(u.view()).toBe("retrying");
  expect(u.noticeText()).toContain("会话列表加载失败，2 秒后自动重试"); // 第 1 次：2s 封顶的一半~全额，random=0.5 → 1.5s 进位到 2
  expect(u.host.textContent).not.toContain("暂无会话");
  expect(clock.timers.size).toBe(1);
  // 退避期内的轮询不插队
  await act(async () => { void store!.refreshAgents("poll"); });
  expect(pending).toHaveLength(1);
  await clock.advance(1_500);
  expect(pending).toHaveLength(2); // 到点自动重试
  await answer((p) => p.status(502));
  expect(store!.state.agentList.failures).toBe(2);
  expect(u.noticeText()).toContain("3 秒后自动重试"); // 第 2 次：4s 封顶 → 3s
  // 启动页：可退出，但退出后侧栏仍是失败态，不是空态
  expect(u.splashStatus()?.textContent).toContain("重试");
  await u.click(u.button("先进入"));
  await waitReal(1_300);
  expect(u.splash()).toBe(false);
  expect(u.view()).toBe("retrying");
  // 手动重试：立刻发、按钮转「正在重试…」，不等退避
  await u.click(u.button("重试", "aside"));
  expect(pending).toHaveLength(3);
  expect(u.button("正在重试…", "aside")?.disabled).toBe(true);
  expect(clock.timers.size).toBe(1); // 只剩「较慢」计时，退避计时已撤
  await answer((p) => p.ok([]));
  expect(u.view()).toBe("empty");
  expect(u.noticeText()).toBe("暂无会话");
  expect(clock.timers.size).toBe(0);
  await u.unmount();
});

test("退避有上限：连败多次等待不超过 30s；页面在后台时到点不发，回前台事件补上", async () => {
  const u = await mount();
  for (let i = 0; i < 8; i++) {
    await answer((p) => p.status(503));
    const t = [...clock.timers.values()][0]!;
    expect(t.at - clock.t).toBeLessThanOrEqual(30_000);
    await clock.advance(t.at - clock.t);
  }
  expect(pending).toHaveLength(9);
  await answer((p) => p.status(503));
  clock.isHidden = true;
  await clock.advance(30_000);
  expect(pending).toHaveLength(9); // 后台不白跑
  clock.isHidden = false;
  await act(async () => { void store!.refreshAgents("event"); });
  expect(pending).toHaveLength(10);
  await answer((p) => p.ok(TWO));
  expect(u.shown()).toEqual(["lead", "kid"]);
  await u.unmount();
});

test("拿到过列表后刷新失败：保留旧列表和折叠偏好，顶部一条提示；联网事件提前重试，成功即撤提示", async () => {
  const u = await mount();
  await answer((p) => p.ok(TWO));
  await u.click(u.host.querySelector('[data-agent="lead"] button[aria-expanded]'));
  expect(u.shown()).toEqual(["lead"]);
  expect(JSON.parse(storage.getItem("cstra_team_collapsed")!)).toEqual(["lead"]);
  await act(async () => { void store!.refreshAgents("poll"); });
  await answer((p) => p.status(502));
  expect(u.view()).toBe("stale");
  expect(u.noticeText()).toContain("列表刷新失败，显示的是上次的结果");
  expect(u.shown()).toEqual(["lead"]); // 旧列表还在、折叠还在
  expect(store!.state.agents.map((a) => a.name)).toEqual(["lead", "kid"]);
  await act(async () => i18n.setLang("en")); // 语言订阅的重渲染要在 act 里提交
  await settle();
  expect(u.noticeText()).toContain("Refresh failed — showing the last loaded list");
  expect(u.button("Retry", "aside")).toBeTruthy();
  await act(async () => i18n.setLang("zh"));
  // 联网事件：退避未到点也立刻重试
  await act(async () => { (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event("online")); });
  expect(pending).toHaveLength(3);
  await answer((p) => p.ok([...TWO, wire("dev")]));
  expect(u.notice()).toBe(false);
  expect(u.shown()).toEqual(["lead", "dev"]);
  await u.unmount();
});

test("过期响应不覆盖新数据源：切机器中止旧请求，旧请求迟到的结果被丢弃", async () => {
  const u = await mount();
  const old = last();
  await act(async () => store!.resetForMachine());
  await settle();
  expect(old.aborted).toBe(true);
  expect(open()).toHaveLength(1);
  const fresh = last();
  expect(u.view()).toBe("waiting");
  await answer((p) => p.ok([wire("other-machine-agent")]), old); // 已 abort 的旧请求：就算回包也不会落地
  await answer((p) => p.ok([wire("new")]), fresh);
  expect(u.shown()).toEqual(["new"]);
  await u.unmount();
});

test("操作后的拉取不吃在途旧响应：在途期间的 action 等它结束后再补拉一次（多个合成一次）", async () => {
  const u = await mount();
  await answer((p) => p.ok(TWO));
  await act(async () => { void store!.refreshAgents("poll"); });
  let done = 0;
  await act(async () => { void store!.loadAgents("action").then(() => done++); void store!.loadAgents("action").then(() => done++); });
  expect(pending).toHaveLength(2);
  await answer((p) => p.ok(TWO));
  expect(pending).toHaveLength(3); // 补拉一次，不是两次
  expect(done).toBe(0);
  await answer((p) => p.ok([...TWO, wire("created")]));
  expect(done).toBe(2);
  expect(u.shown()).toContain("created");
  await u.unmount();
});

test("卸载：中止在途、零计时器，之后再拨时钟也不发请求", async () => {
  const u = await mount();
  await answer((p) => p.status(503));
  await act(async () => { void store!.loadAgents("manual"); });
  expect(clock.timers.size).toBe(1);
  const inflight = last();
  await u.unmount();
  expect(inflight.aborted).toBe(true);
  expect(clock.timers.size).toBe(0);
  await clock.advance(120_000);
  expect(pending).toHaveLength(2);
});

test("403：不自动重试，侧栏说清楚，Splash 退场让配对横幅露出来", async () => {
  const u = await mount();
  await answer((p) => p.status(403));
  expect(u.view()).toBe("denied");
  expect(u.noticeText()).toContain("没有权限读取会话列表");
  expect(clock.timers.size).toBe(0);
  await act(async () => { void store!.refreshAgents("poll"); void store!.refreshAgents("event"); });
  expect(pending).toHaveLength(1);
  await waitReal(1_300);
  expect(u.splash()).toBe(false);
  await u.unmount();
});
