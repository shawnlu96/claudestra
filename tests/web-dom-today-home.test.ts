/**
 * TODAY1：「今天」页真挂到 happy-dom（React 19）——真的 MessageList（没选会话时的主区）、真的 NowStrip、真的 Sidebar + CollabSwitch（整页入口），
 * 真的 chat store / 待办 store / collab-nav。fetch 全在这里拦下按合成数据答（tests/helpers/today-shots.ts，规格「对照基准」），夹具之外一律 404，
 * 不连任何 bridge。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { setContextRequestForTest } from "../web/lib/collab-source-binding";
import { machines } from "../web/lib/machines";
import { todayRoute, todayWorld } from "./helpers/today-shots";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void; closest?(s: string): El | null;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void }; localStorage: { clear(): void; setItem(k: string, v: string): void } }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let win: Win;
interface Store { state: { activeAgent: string }; loadAgents(): Promise<void>; loadProjects(): Promise<void> }
let ui: {
  MessageList: () => unknown; Sidebar: (p: { onSelect: () => void }) => unknown; NowStrip: () => unknown; CollabSwitch: () => unknown;
  closingCollab: (fn: () => void) => () => void;
  ChatStoreProvider: (p: { children: unknown }) => unknown; useChatStoreApi: () => Store;
  ChatNavContext: { Provider: (p: { value: unknown; children: unknown }) => unknown };
  asksStore: { refresh(): Promise<void>; closeDrawer(): void; get(): { open: boolean; focus: string | null } };
  useCollabNav: () => { project: string | null; task: string | null; view: "team" | null }; closeCollab: () => void; unmountOpenViewGuard: () => void;
  TODAY_KEY: string; resetLedgers: () => void;
};

const FP = "mac-a";
const NOW = Date.now();
const H = 3600_000;
/** 每个用例从这份开始；「今天完成」的时刻挪到刚才，不随跑测试的钟点跨零点 */
function freshWorld() {
  const w = todayWorld(NOW);
  for (const ov of Object.values(w.ledgers) as { tasks: { stage: string; metrics: { endTs?: number } }[] }[]) {
    for (const t of ov.tasks) if (t.metrics.endTs && NOW - t.metrics.endTs < 10 * H) t.metrics.endTs = NOW - 1000;
  }
  return { ...w, agents: [...w.agents, { name: "master", displayName: "大总管", status: "active", cwd: "/repo", purpose: "", busy: false }] as object[], slow: false, fp: FP, openC: "" };
}
let world = freshWorld();
const calls: string[] = [];
const fpCalls: string[] = [];
const aborted: string[] = [];
const live = new Set<() => Promise<void>>();
const realFetch = globalThis.fetch, realFp = machines.currentFp;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  win = (globalThis as unknown as { window: Win }).window;
  machines.currentFp = () => world.fp;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = url.pathname.replace(/^\/m\/[^/]+/, "");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: FP, machineName: "fixture", version: "" });
    if (path === "/api/v1/shared-ledger/context") return json({ identities: [] });
    const api = path.startsWith("/api/v1/") ? path.slice("/api/v1".length) : null;
    fpCalls.push(`@${world.fp} ${path}`);
    // 换机器：openC 那台上 proj-c 的台账读得到（同一个项目 id）
    if (api === "/ledger/proj-c" && world.fp === world.openC) return json(world.ledgers["proj-b"]);
    // 慢台账：在途时收起侧栏条，看请求有没有被中止
    if (api && world.slow && /^\/ledger\//.test(api)) {
      const signal = init?.signal;
      await new Promise<void>((r) => { const t = setTimeout(r, 400); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }); });
      if (signal?.aborted) { aborted.push(api); throw new DOMException("aborted", "AbortError"); }
    }
    return (api && todayRoute(api, world)) || json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const [list, side, now, store, nav, asks, collabNav, viewEntry, sw] = [
    require("../web/features/chat/components/message-list.tsx"), require("../web/features/chat/components/sidebar.tsx"),
    require("../web/features/now/now-home.tsx"), require("../web/features/chat/chat-store.ts"),
    require("../web/features/chat/components/nav-context.tsx"), require("../web/features/asks/asks-store.ts"),
    require("../web/features/collab/collab-nav.ts"), require("../web/features/collab/team-view-entry.tsx"), require("../web/features/collab/collab-switch.tsx")];
  ui = { MessageList: list.MessageList, Sidebar: side.Sidebar, NowStrip: now.NowStrip, CollabSwitch: sw.CollabSwitch, closingCollab: sw.closingCollab,
    ChatStoreProvider: store.ChatStoreProvider, useChatStoreApi: store.useChatStoreApi, ChatNavContext: nav.ChatNavContext, asksStore: asks.asksStore,
    useCollabNav: collabNav.useCollabNav, closeCollab: collabNav.closeCollab, unmountOpenViewGuard: viewEntry.unmountOpenViewGuardForTest, TODAY_KEY: now.TODAY_KEY,
    resetLedgers: require("../web/features/now/now-ledgers.ts").resetTodayLedgersForTest };
});

afterEach(async () => {
  for (const off of [...live]) await off();
  await React.act(async () => ui.unmountOpenViewGuard());
  // 台账读取是模块级共用的一份（拒绝访问的记录也在里面）：用例之间清掉
  await React.act(async () => ui.resetLedgers());
  world = freshWorld();
  calls.length = 0;
  fpCalls.length = 0;
  aborted.length = 0;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  machines.currentFp = realFp;
  setContextRequestForTest(null);
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}

/** part：主区（MessageList）/ 只挂侧栏条 / 侧栏 + 主区 + 协作覆盖层（整页入口） */
async function mount(part: "main" | "strip" | "shell", width = 1280) {
  win.happyDOM.setViewport({ width, height: 900 });
  setContextRequestForTest(null);
  await React.act(async () => ui.closeCollab());
  ui.asksStore.closeDrawer();
  const seen = { toContent: 0, store: null as Store | null, nav: { project: null, task: null, view: null } as { project: string | null; task: string | null; view: "team" | null } };
  const h = React.createElement as (...a: unknown[]) => unknown;
  function Probe() {
    seen.store = ui.useChatStoreApi();
    seen.nav = ui.useCollabNav();
    return null;
  }
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await React.act(async () => root.unmount());
    host.remove();
  };
  live.add(unmount);
  const toContent = () => { seen.toContent++; };
  const body = part === "main" ? h(ui.MessageList) : part === "strip" ? h(ui.NowStrip)
    : h("div", null, h(ui.Sidebar, { onSelect: ui.closingCollab(toContent) }), h("main", null, h(ui.MessageList), h(ui.CollabSwitch)));
  const nav = { showContent: false, toContent, toList: () => {} };
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.ChatNavContext.Provider, { value: nav }, h(Probe), body)) as never));
  await React.act(async () => { await Promise.all([seen.store!.loadAgents(), seen.store!.loadProjects(), ui.asksStore.refresh()]); });
  const click = async (el: El | null | undefined, what: string) => {
    if (!el) throw new Error(`no ${what}`);
    await React.act(async () => el.click());
    await tick(30);
  };
  const all = (sel: string) => Array.from(host.querySelectorAll(sel));
  const texts = (sel: string) => all(sel).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  return { host, seen, click, all, texts, unmount };
}

const BLOCKS = ["waits", "stuck", "doing", "done", "team"];
const blockOrder = (v: { all(s: string): El[] }, scope = "[data-now=page]") =>
  v.all(BLOCKS.map((b) => `${scope} section[data-now-${b}]`).join(",")).map((e) => BLOCKS.find((b) => e.hasAttribute(`data-now-${b}`)));
const ledgerCalls = () => calls.filter((c) => /^GET \/api\/v1\/ledger\/[\w-]+(\/product)?$/.test(c));

test("[验收线 2] 页面版：标题『今天』，五块按顺序；卡住了 3 条、问题在前；正在做 A 两个模块、B 是 agent 行、C 只有项目行；额度一行", async () => {
  const v = await mount("main");
  await until(() => v.all("[data-now-stuck-row]").length === 3 && v.all("[data-now-quota]").length === 1, "today page data");
  expect(v.host.querySelector("[data-now=page] h2")?.textContent).toBe("今天");
  expect(blockOrder(v)).toEqual(BLOCKS);
  expect(v.host.querySelector("[data-now=page] header")?.textContent).not.toContain("现在");
  expect(v.host.querySelector("[data-now=page] [data-now-summary]")?.textContent).toBe("3 件要你处理 · 3 个 agent 在干活");
  expect(v.all("[data-now-stuck-row]").map((e) => e.getAttribute("data-now-stuck-row"))).toEqual(["proj-a/A3", "proj-a/A2", "proj-b/B1"]);
  expect(v.texts("[data-now-stuck-row]")[0]).toBe("导出预览合成项目 A窄屏下预览溢出2小时10分");
  expect(v.all("[data-now-group=proj-a] [data-now-module]").map((e) => e.getAttribute("data-now-module"))).toEqual(["f-export", "f-notify"]);
  expect(v.texts("[data-now-group=proj-a] [data-now-module=f-export] [data-now-module-active]")).toEqual(["3 个在做"]);
  expect(v.all("[data-now-group=proj-a] [data-now-module=f-export] [data-now-face]").map((e) => e.getAttribute("title"))).toEqual(["导出开发 · A1 开发中", "通知开发 · A4 开发中"]);
  expect(v.all("[data-now-group=proj-b] [data-now-worker]").map((e) => e.getAttribute("data-now-worker"))).toEqual(["b-dev"]);
  expect([v.all("[data-now-group=proj-c] [data-now-module]").length, v.all("[data-now-group=proj-c] [data-now-worker]").length, v.all("[data-now-project=proj-c]").length]).toEqual([0, 0, 1]);
  expect(v.texts("[data-now-done-toggle]")).toEqual(["今天完成 3 个任务"]);
  expect(v.texts("[data-now-quota]")).toEqual(["Claude 本周已用 62% · Codex 本周已用 18%"]);
  expect(v.texts("[data-now-agents]")).toEqual(["本机 5 个 agent 活着 · 3 个在干活"]);
  // 要你处理：两行字，带 taskId 的多一个「看任务」
  expect(v.texts("[data-now-wait-where]")).toEqual(["合成项目 A · 导出 · 导出按钮改版", "合成项目 B", "合成项目 C"]);
  expect(v.all("[data-now-wait-task]").map((e) => e.getAttribute("data-now-wait-task"))).toEqual(["A1"]);
  // 台账 403 的项目只读一次（之后不再读），全程没有 GET /quota
  await tick(50);
  expect(calls.filter((c) => c === "GET /api/v1/ledger/proj-c")).toHaveLength(1);
  expect(calls.filter((c) => /\/quota$/.test(c))).toEqual([]);
  await v.unmount();
});

test("[验收线 2] 空态：没有要你处理时那块只有一行；卡住了、今天完成为空时整块不在 DOM 里", async () => {
  world.asks = [];
  world.ledgers = {};
  const v = await mount("main");
  await until(() => v.all("[data-now-quota]").length === 1, "quota");
  await tick(50);
  expect(blockOrder(v)).toEqual(["waits", "doing", "team"]);
  const waits = v.host.querySelector("section[data-now-waits]")!;
  expect(Array.from(waits.querySelectorAll("p, li")).map((e) => e.textContent)).toEqual(["没有要你处理的"]);
  expect(v.host.querySelector("[data-now=page] [data-now-summary]")?.textContent).toBe("没有要你处理的 · 3 个 agent 在干活");
  await v.unmount();
});

test("[验收线 3] 侧栏条收起时不发 /ledger、/product（收起行只用全局状态）；展开后发，在途时再收起即中止；全程不发 GET /quota", async () => {
  win.localStorage.clear();
  const v = await mount("strip", 390);
  const strip = () => v.host.querySelector("[data-now=strip]")!;
  const toggle = () => strip().querySelector("button[aria-expanded]")!;
  await until(() => (toggle().textContent ?? "").includes("3 件要你处理"), "strip summary");
  await tick(100);
  expect(toggle().textContent).toBe("今天· 3 件要你处理 · 3 个 agent 在干活");
  expect(toggle().getAttribute("title")).toBe("展开今天总览");
  expect(ledgerCalls()).toEqual([]);
  expect(calls.filter((c) => c.endsWith("/lend/quota-lines"))).toEqual([]);
  world.slow = true;
  await v.click(toggle(), "expand");
  expect(toggle().getAttribute("title")).toBe("收起今天总览");
  await until(() => ledgerCalls().length >= 4, "ledger reads after expand");
  expect(new Set(ledgerCalls())).toEqual(new Set(["GET /api/v1/ledger/proj-a", "GET /api/v1/ledger/proj-a/product", "GET /api/v1/ledger/proj-b",
    "GET /api/v1/ledger/proj-b/product", "GET /api/v1/ledger/proj-c", "GET /api/v1/ledger/proj-c/product"]));
  await v.click(toggle(), "collapse while in flight");
  await until(() => aborted.length === 6, "aborted reads");
  const before = ledgerCalls().length;
  await tick(500);
  expect(ledgerCalls().length).toBe(before);
  expect(calls.filter((c) => /\/quota$/.test(c))).toEqual([]);
  await v.unmount();
});

test("[验收线 4] 点『卡住了』一行：collab-nav 是 {该项目, 该任务}；点『看任务』同理", async () => {
  const v = await mount("main");
  await until(() => v.all("[data-now-stuck-row]").length === 3, "stuck rows");
  await v.click(v.host.querySelector("[data-now-stuck-row='proj-b/B1']"), "stuck row");
  expect(v.seen.nav).toEqual({ project: "proj-b", task: "B1", view: null });
  expect(v.seen.toContent).toBe(1);
  await React.act(async () => ui.closeCollab());
  await tick();
  await v.unmount();
  const w = await mount("main");
  await until(() => w.all("[data-now-wait-task]").length === 1, "wait task");
  await w.click(w.host.querySelector("[data-now-wait-task=A1]"), "view task");
  expect(w.seen.nav).toEqual({ project: "proj-a", task: "A1", view: null });
  await React.act(async () => ui.closeCollab());
  await tick();
  await w.unmount();
});

test("[验收线 4] 桌面点侧栏条『整页』：主区盖出今天页；再点侧栏一个会话，今天页收起", async () => {
  win.localStorage.clear();
  const v = await mount("shell");
  await until(() => !!v.host.querySelector("[data-now=strip] [data-now-full]"), "full button");
  // 先选一个会话：主区不再是空状态的今天页
  const master = () => v.all("button").find((b) => (b.textContent ?? "").includes("大总管") && !b.closest?.("[data-now]"));
  await until(() => !!master(), "master row");
  await v.click(master(), "master row");
  await until(() => !!v.seen.store!.state.activeAgent, "open master");
  await until(() => !v.host.querySelector("[data-now=page]"), "chat main");
  await v.click(v.host.querySelector("[data-now=strip] [data-now-full]"), "full page");
  expect(v.seen.nav.project).toBe(ui.TODAY_KEY);
  await until(() => !!v.host.querySelector("main [data-now=page]"), "today overlay");
  expect(v.host.querySelector("main [data-now=page] h2")?.textContent).toBe("今天");
  await v.click(master(), "session row again");
  expect(v.seen.nav.project).toBeNull();
  await until(() => !v.host.querySelector("main [data-now=page]"), "overlay closed");
  await v.unmount();
});

test("[回归] 页面版、整页、展开的侧栏条同时挂着也只跑一套读取：没选会话时点『整页』不重读，每项目各一次", async () => {
  win.localStorage.setItem("cstra_now_open", "1");
  const v = await mount("shell");
  await until(() => v.all("[data-now-stuck-row]").length >= 3 && ledgerCalls().length === 6, "first reads");
  await tick(100);
  const once = ["GET /api/v1/ledger/proj-a", "GET /api/v1/ledger/proj-a/product", "GET /api/v1/ledger/proj-b",
    "GET /api/v1/ledger/proj-b/product", "GET /api/v1/ledger/proj-c", "GET /api/v1/ledger/proj-c/product"];
  expect(ledgerCalls().sort()).toEqual(once);
  // 事件流外壳别处也会连（侧栏），这里只看「整页」盖上之后没有多连
  const streams = () => calls.filter((c) => c === "GET /api/v1/events").length;
  const before = streams();
  await v.click(v.host.querySelector("[data-now=strip] [data-now-full]"), "full page");
  await until(() => v.all("main [data-now=page]").length === 2, "overlay over empty-state page");
  await tick(200);
  expect(ledgerCalls().sort()).toEqual(once);
  expect(streams()).toBe(before);
  // 盖层收起、侧栏条收起：还有主区空状态那份在看，读取不中止也不重起
  await React.act(async () => ui.closeCollab()); // collab-nav 是 store 外的更新，包进 act：不包时 CI 慢机上偶发不重画（r4 CI 红）
  await until(() => v.all("main [data-now=page]").length === 1, "overlay closed");
  await v.click(v.host.querySelector("[data-now=strip] button[aria-expanded]"), "collapse strip");
  await tick(200);
  expect(ledgerCalls().sort()).toEqual(once);
  await v.unmount();
});

test("[回归] 换机器：台账读取按机器隔离——机器 A 上 proj-c 拒绝访问不挡机器 B 同名项目，A 的数据也不当 B 的初值", async () => {
  const a = await mount("main");
  await until(() => v_stuck(a) === 3 && fpCalls.includes("@mac-a /api/v1/ledger/proj-c"), "machine A reads");
  await tick(50);
  await a.unmount();
  world.fp = "mac-b";
  world.openC = "mac-b";
  world.slow = true;
  const b = await mount("main");
  // 机器 B 的读还在途：不出机器 A 的卡住行
  expect(v_stuck(b)).toBe(0);
  await until(() => fpCalls.includes("@mac-b /api/v1/ledger/proj-c"), "machine B reads proj-c");
  await until(() => b.all("[data-now-stuck-row^='proj-c/']").length > 0, "proj-c readable on machine B");
  await b.unmount();
});

function v_stuck(v: { all(s: string): El[] }) { return v.all("[data-now-stuck-row]").length; }
