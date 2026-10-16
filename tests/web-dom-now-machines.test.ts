/**
 * XMACH1：「今天 · 团队与额度」机器行与设置 · 伙伴机器页真挂到 happy-dom（React 19）——真的 MessageList（没选会话时的主区 = 今天页面版）、
 * 真的 Sidebar + SettingsModal + CollabSwitch、真的 chat store / collab-nav / 联系人 store。fetch 全在这里拦下按合成数据答
 * （tests/helpers/machines-shots.ts 叠在 today-shots 上），夹具之外一律 404，不连任何 bridge。happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { setContextRequestForTest } from "../web/lib/collab-source-binding";
import { machines } from "../web/lib/machines";
import { machinesRoute, machinesWorld } from "./helpers/machines-shots";
import { todayRoute, todayWorld } from "./helpers/today-shots";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void; closest?(s: string): El | null;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void }; HTMLElement: { prototype: { scrollIntoView?: unknown } } }
interface Store { state: { activeAgent: string }; loadAgents(): Promise<void>; loadProjects(): Promise<void> }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let win: Win;
let ui: {
  MessageList: () => unknown; NowStrip: () => unknown; Sidebar: (p: { onSelect: () => void }) => unknown; CollabSwitch: () => unknown; closingCollab: (fn: () => void) => () => void;
  ChatStoreProvider: (p: { children: unknown }) => unknown; useChatStoreApi: () => Store;
  ChatNavContext: { Provider: (p: { value: unknown; children: unknown }) => unknown };
  useCollabNav: () => { project: string | null; task: string | null }; closeCollab: () => void; unmountOpenViewGuard: () => void;
  openSettings: (p: string) => void; TODAY_KEY: string; resetLedgers: () => void; setSeenStopping: (m?: ReadonlyMap<string, number>) => void;
};

const NOW = Date.now();
const fresh = () => ({ ...todayWorld(NOW), fp: "mac-a", m: machinesWorld(NOW) });
let world = fresh();
const calls: string[] = [];
const scrolled: string[] = [];
/** 借入接口暂时拉不到（503） */
let borrowDown = false;
const live = new Set<() => Promise<void>>();
const realFetch = globalThis.fetch, realFp = machines.currentFp, realNow = Date.now;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  win = (globalThis as unknown as { window: Win }).window;
  // 记下今天页滚到了哪一块（scrollToSection 调 scrollIntoView）
  win.HTMLElement.prototype.scrollIntoView = function (this: El) {
    const hook = ["waits", "stuck", "doing", "done", "team"].find((b) => this.hasAttribute(`data-now-${b}`));
    if (hook) scrolled.push(hook);
  };
  machines.currentFp = () => world.fp;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = url.pathname.replace(/^\/m\/[^/]+/, "");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    if (borrowDown && path === "/api/v1/borrow") return new Response("down", { status: 503 });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: world.fp, machineName: "fixture", version: "" });
    if (path === "/api/v1/shared-ledger/context") return json({ identities: [] });
    const api = path.startsWith("/api/v1/") ? path.slice("/api/v1".length) : null;
    return (api && (machinesRoute(api, world.m) ?? todayRoute(api, world))) || json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const [list, side, nav, collabNav, viewEntry, sw, store, settings, today] = [
    require("../web/features/chat/components/message-list.tsx"), require("../web/features/chat/components/sidebar.tsx"),
    require("../web/features/chat/components/nav-context.tsx"), require("../web/features/collab/collab-nav.ts"),
    require("../web/features/collab/team-view-entry.tsx"), require("../web/features/collab/collab-switch.tsx"), require("../web/features/chat/chat-store.ts"),
    require("../web/features/chat/settings-open.ts"), require("../web/features/now/today-nav.ts")];
  ui = { MessageList: list.MessageList, NowStrip: require("../web/features/now/now-home.tsx").NowStrip, Sidebar: side.Sidebar, CollabSwitch: sw.CollabSwitch, closingCollab: sw.closingCollab,
    ChatStoreProvider: store.ChatStoreProvider, useChatStoreApi: store.useChatStoreApi, ChatNavContext: nav.ChatNavContext,
    useCollabNav: collabNav.useCollabNav, closeCollab: collabNav.closeCollab, unmountOpenViewGuard: viewEntry.unmountOpenViewGuardForTest,
    openSettings: settings.openSettings, TODAY_KEY: today.TODAY_KEY, resetLedgers: require("../web/features/now/now-ledgers.ts").resetTodayLedgersForTest,
    setSeenStopping: require("../web/features/now/now-team-machines.tsx").setSeenStoppingForTest };
  // 今天页 5 分钟前就看到机器 C 那单已收回（合成数据里它收回后超时还 live = 停住）
  ui.setSeenStopping(new Map([["lend-2", NOW - 5 * 60_000]]));
});

afterEach(async () => {
  for (const off of [...live]) await off();
  await React.act(async () => ui.unmountOpenViewGuard());
  await React.act(async () => ui.resetLedgers());
  await React.act(async () => ui.closeCollab());
  ui.setSeenStopping(new Map([["lend-2", NOW - 5 * 60_000]]));
  Date.now = realNow;
  borrowDown = false;
  world = fresh();
  calls.length = 0;
  scrolled.length = 0;
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

/** main = 只挂主区（今天页面版）；strip = 只挂侧栏条；shell = 侧栏（含设置弹窗）+ 主区 + 协作覆盖层 */
async function mount(part: "main" | "strip" | "shell") {
  win.happyDOM.setViewport({ width: 1280, height: 900 });
  setContextRequestForTest(null);
  const seen = { toContent: 0, store: null as Store | null, nav: { project: null, task: null } as { project: string | null; task: string | null } };
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
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.ChatNavContext.Provider, { value: { showContent: false, toContent, toList: () => {} } },
    h(Probe), body)) as never));
  await React.act(async () => { await Promise.all([seen.store!.loadAgents(), seen.store!.loadProjects()]); });
  const click = async (el: El | null | undefined, what: string) => {
    if (!el) throw new Error(`no ${what}`);
    await React.act(async () => el.click());
    await tick(30);
  };
  // 设置弹窗 portal 到 body：查找范围用整个 body
  const all = (sel: string) => Array.from(doc.body.querySelectorAll(sel));
  const text = (sel: string) => ((sel === "body" ? doc.body : doc.body.querySelector(sel))?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { host, seen, click, all, text, unmount };
}

const ready = (v: { all(s: string): El[] }) => v.all("[data-now-lent]").length === 1 && v.all("[data-now-borrowed]").length === 1;

test("[验收线 2] 今天页团队块：伙伴机器 1/2 在线、借出在跑 2 单、借入在跑 3 单，停住的各写『其中 1 单停住』；收起时行不在 DOM 里", async () => {
  const v = await mount("main");
  await until(() => ready(v), "machine rows");
  expect(v.text("[data-now-team] [data-now-peers-online]")).toBe("伙伴机器 1/2 在线");
  expect(v.text("[data-now-team] [data-now-lent] button")).toBe("借出在跑 2 单其中 1 单停住");
  expect(v.text("[data-now-team] [data-now-borrowed] button")).toBe("借入在跑 3 单其中 1 单停住");
  expect(v.all("[data-now-machines-stuck]").map((e) => e.getAttribute("class"))).toEqual([expect.stringContaining("text-warning"), expect.stringContaining("text-warning")]);
  expect(v.all("[data-remote-row]")).toHaveLength(0);
  // 只读、不发写请求
  expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  await v.unmount();
});

test("[验收线 2] 点借入一行：collab-nav 是 {该项目, 该任务} 并切到主区；点借出一单打开那个 agent", async () => {
  const v = await mount("main");
  await until(() => ready(v), "machine rows");
  await v.click(v.host.querySelector("[data-now-borrowed] button"), "borrowed toggle");
  await until(() => v.all("[data-remote-row]").length === 3, "remote rows");
  expect(v.host.querySelector("[data-now-borrowed] button")?.getAttribute("aria-expanded")).toBe("true");
  await v.click(v.host.querySelector("[data-remote-row=r-b1]"), "remote row B1");
  expect(v.seen.nav).toEqual({ project: "proj-b", task: "B1" });
  expect(v.seen.toContent).toBe(1);
  await React.act(async () => ui.closeCollab());
  await tick();
  await v.unmount();
  const w = await mount("main");
  await until(() => ready(w), "machine rows");
  await w.click(w.host.querySelector("[data-now-lent] button"), "lent toggle");
  const row = () => w.all("[data-now-lent] button").find((b) => (b.textContent ?? "").includes("synthetic/shop#41"));
  await until(() => !!row(), "lent order row");
  // 已结束的那单不在今天页
  expect(w.all("[data-now-lent] button").some((b) => (b.textContent ?? "").includes("#43"))).toBe(false);
  await w.click(row(), "lent order");
  await until(() => w.seen.store!.state.activeAgent === "lend-1" || w.seen.store!.state.activeAgent === "agent-lend-1", "open lent agent");
  expect(w.seen.toContent).toBe(1);
  expect(w.seen.nav.project).toBeNull();
  await w.unmount();
});

test("[验收线 3] 设置：导航项叫『伙伴机器』；peers 页没有『借出中的活』『远端在跑』两段，换成两行链接；点链接设置关掉、今天页滚到团队与额度", async () => {
  const v = await mount("shell");
  await React.act(async () => ui.openSettings("peers"));
  await until(() => v.all("[data-running-elsewhere]").length === 2, "settings peers page links");
  const navItems = v.all("button").map((b) => (b.textContent ?? "").trim());
  expect(navItems).toContain("伙伴机器");
  expect(navItems).not.toContain("Peer 协作");
  const body = v.text("body");
  // 配置区照旧：出借（授权）与借入（借谁的机器）两块都在
  expect(body).toContain("把我的电脑借给别人");
  expect(body).toContain("借别人的电脑跑我的活");
  expect(body).not.toContain("借出中的活");
  expect(body).not.toContain("远端在跑");
  expect(v.all("[data-running-elsewhere]").map((e) => e.textContent)).toEqual(["在跑的单在『今天 · 团队与额度』", "在跑的单在『今天 · 团队与额度』"]);
  await v.click(v.all("[data-running-elsewhere]")[1], "link");
  await until(() => v.all("[data-running-elsewhere]").length === 0, "settings closed");
  expect(v.seen.nav.project).toBe(ui.TODAY_KEY);
  await until(() => scrolled.includes("team"), "scroll to team");
  expect(v.text("main [data-now=page] [data-now-team] [data-now-peers-online]")).toBe("伙伴机器 1/2 在线");
  await v.unmount();
});

test("[验收线 2] 403（非 owner）：/lend/grants、/borrow、联系人都 403，机器整段不在 DOM 里，团队块其余照出", async () => {
  world.fp = "mac-guest";
  world.m = machinesWorld(NOW, true);
  const v = await mount("main");
  await until(() => calls.includes("GET /api/v1/peers/contacts") && v.all("[data-now-quota]").length === 1, "team block");
  await tick(100);
  expect(v.all("[data-now-team]")).toHaveLength(1);
  expect(v.all("[data-now-machines]")).toHaveLength(0);
  expect(v.text("body")).not.toContain("伙伴机器");
  await v.unmount();
});

test("[验收线 PM 补 15:5x] 本机 busy 0、借入在跑 4：侧栏条写『4 个 agent 在干活 · 其中 4 个在别的机器』，正在做同一句；借出单不算", async () => {
  world.agents = world.agents.map((a) => ({ ...a, busy: false }));
  const borrow = world.m.borrow as { remote: { orderId: string; status: string; leaseUntil: number | null }[] };
  borrow.remote = [0, 1, 2, 3].map((i) => ({ ...borrow.remote[0]!, orderId: `r-${i}`, status: "claimed", leaseUntil: NOW + 600_000 }));
  const v = await mount("strip");
  await until(() => v.text("[data-now=strip] [data-now-summary]").includes("其中"), "strip summary with remote");
  expect(v.text("[data-now=strip] [data-now-summary]")).toBe("· 3 件要你处理 · 4 个 agent 在干活 · 其中 4 个在别的机器");
  await v.unmount();
  const p = await mount("main");
  await until(() => p.text("[data-now=page] section[data-now-doing] h3").includes("其中"), "doing count");
  expect(p.text("[data-now=page] section[data-now-doing] h3")).toBe("正在做4 个 agent 在干活 · 其中 4 个在别的机器");
  expect(p.all("[data-now=page] [data-now-idle]")).toHaveLength(0);
  await p.unmount();
});

test("[回归] 没有借入在跑：句子同原来，不带后半句", async () => {
  world.m = { ...world.m, borrow: { ...(world.m.borrow as object), remote: [] } };
  const v = await mount("strip");
  await until(() => calls.includes("GET /api/v1/borrow"), "borrow read");
  await tick(50);
  expect(v.text("[data-now=strip] [data-now-summary]")).toBe("· 3 件要你处理 · 3 个 agent 在干活");
  await v.unmount();
});

test("[验收线 2] 收回时刻按今天页看到的算：刚看到已收回（不拿续租刷新的 updatedAt 倒推）是停止中，不写停住", async () => {
  ui.setSeenStopping();
  const v = await mount("main");
  await until(() => ready(v), "machine rows");
  await tick(50);
  expect(v.text("[data-now-team] [data-now-lent] button")).toBe("借出在跑 2 单");
  expect(v.text("[data-now-team] [data-now-borrowed] button")).toBe("借入在跑 3 单其中 1 单停住");
  await v.unmount();
});

test("[验收线 2] 借出单不算『在干活』：自己的会话全空闲、只有给别人跑单的 lend worker 在忙、没有借入 → 0 个", async () => {
  world.agents = [...world.agents.map((a) => ({ ...a, busy: false })),
    { name: "lend-1", status: "active", projectId: "lend", cwd: "/repo", lastActivityTs: NOW - 60_000, busy: true }];
  world.m = { ...world.m, borrow: { ...(world.m.borrow as object), remote: [] } };
  const v = await mount("strip");
  await until(() => calls.includes("GET /api/v1/borrow") && calls.includes("GET /api/v1/agents"), "reads");
  await tick(50);
  expect(v.text("[data-now=strip] [data-now-summary]")).toBe("· 3 件要你处理 · 0 个 agent 在干活");
  await v.unmount();
});

test("借入行的心跳年龄跟着时钟走：/borrow 暂时拉不到（保留上次快照）时不停在上次的值", async () => {
  const v = await mount("main");
  await until(() => ready(v), "machine rows");
  await v.click(v.host.querySelector("[data-now-borrowed] button"), "borrowed toggle");
  await until(() => v.all("[data-remote-row]").length === 3, "remote rows");
  expect(v.text("[data-remote-row=r-a1]")).toContain("30 秒前");
  borrowDown = true;
  Date.now = () => realNow() + 5 * 60_000;
  // 年龄时钟每 5 秒走一次：等一拍
  await tick(5_300);
  expect(v.text("[data-remote-row=r-a1]")).toContain("5 分钟前");
  await v.unmount();
}, 20_000);
