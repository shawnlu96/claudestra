/**
 * PROJTABS1 项目页四标签真挂到 happy-dom（React 19）：真 CollabView + ChatStoreProvider，fetch 全部拦给 tests/helpers/project-tabs-shots.ts 的合成本机数据，
 * 不连任何 bridge。系统时间钉在夹具时刻（2026-10-14 12:00 Asia/Shanghai），停留时长与「今天完成」按它算。
 * 覆盖验收线 1–6：四个标签桌面手机都在、冷开总览、没有大纲 / 指标条；总览一句话状态与 homeView 一致、没有「暂无」、卡住了点开抽屉、已完成往前翻；
 * 模块进度没选模块是模块列表；抽屉 Esc / 遮罩可关、手机仍整屏；带任务进入落到模块进度并高亮节点；今天页模块行经 requestProjectTab 落点。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { homeView, type LedgerOverview, type OwnerWait } from "../web/features/collab/collab-model";
import { fillParams } from "../web/lib/i18n-fill";
import { MAP, PLAIN, PT_NOW, ptAsks, ptLedgers, ptRoute, STUCK_IDS } from "./helpers/project-tabs-shots";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; className: string; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void }; dispatchEvent(e: unknown): void; KeyboardEvent: new (t: string, o: object) => unknown }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc, win: Win;
let ui: {
  CollabView: (p: { project: string }) => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown;
  NowDoing: (p: Record<string, unknown>) => unknown;
  openCollabTask: (t: string | null) => void;
  closeCollab: () => void;
  useCollabNav: () => { project: string | null; task: string | null };
  tabs: { rememberTab(p: string, t: string): void; requestProjectTab(p: string, r: object): void; peekProjectTab(p: string): object | null };
};
const calls: string[] = [];
const scrolled: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  setSystemTime(new Date(PT_NOW));
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  win = globalThis as unknown as Win;
  // FocusBoard 闪卡时用 CSS.escape 找节点；happy-dom 没有 CSS 全局（卡号只有字母数字，原样即可）
  (globalThis as { CSS?: { escape(s: string): string } }).CSS ??= { escape: (x: string) => x };
  // 闪一次 = 滚到那张卡再加 .flash；根测试进程里 CSS module 没有真类名，记 scrollIntoView 落在哪个节点上
  const proto = (globalThis as unknown as { HTMLElement: { prototype: { scrollIntoView(o?: unknown): void; getAttribute(n: string): string | null } } }).HTMLElement.prototype;
  const scroll = proto.scrollIntoView;
  proto.scrollIntoView = function (this: { getAttribute(n: string): string | null }, o?: unknown) {
    const key = this.getAttribute("data-focus-key");
    if (key) scrolled.push(key);
    return scroll?.call(this, o);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname + url.search)}`);
    if (url.pathname === "/app-config.json") return Response.json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    const hit = url.pathname.startsWith("/api/v1/") ? ptRoute(url.pathname.slice("/api/v1".length), url.searchParams) : null;
    return hit ?? Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  await (await import(mod("asks/asks-store.ts"))).asksStore.refresh();
  const store = await import(mod("chat/chat-store.ts"));
  const nav = await import(mod("collab/collab-nav.ts"));
  const doing = await import(mod("now/now-doing.tsx"));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, NowDoing: doing.NowDoing, openCollabTask: nav.openCollabTask,
    closeCollab: nav.closeCollab, useCollabNav: nav.useCollabNav, tabs: await import(mod("collab/project-tabs/tab-request.ts")) };
});

const live = new Set<() => Promise<void>>();
afterEach(async () => { for (const u of [...live]) await u(); });
afterAll(async () => {
  globalThis.fetch = realFetch;
  setSystemTime();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}: ${(doc.body.textContent ?? "").slice(0, 400)}`);
}
const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);

/** 冷开一个项目页：先把记住的标签清回总览（模块级，用例之间会串），before 里可以先登记请求 / 开好任务 */
async function mount(project: string, width = 1280, before?: () => void) {
  win.happyDOM.setViewport({ width, height: width < 640 ? 844 : 800 });
  ui.tabs.rememberTab(project, "overview");
  ui.openCollabTask(null);
  before?.();
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.CollabView, { project })) as never));
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await React.act(async () => root.unmount());
    host.remove();
    ui.openCollabTask(null);
  };
  live.add(unmount);
  await until(() => !!host.querySelector("[data-project-tab]") && !!host.querySelector("[data-project-pane]"), `${project} page`);
  const tabs = () => Array.from(host.querySelectorAll("[data-project-tab]"));
  return {
    host, unmount, tabs,
    selected: () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.getAttribute("data-project-tab") ?? null,
    click: async (el: El | null | undefined, what: string) => {
      if (!el) throw new Error(`no ${what}: ${(host.textContent ?? "").slice(0, 300)}`);
      await React.act(async () => el.click());
      await tick(60);
    },
    tab: (k: string) => host.querySelector(`[data-project-tab=${k}]`),
  };
}
const drawer = () => doc.body.querySelector("[data-task-drawer]");

test("[验收线 1] 四个标签桌面手机都在、字是全的，冷开是总览；没有大纲、没有指标条", async () => {
  for (const width of [1280, 390]) {
    const v = await mount(MAP, width);
    expect({ width, tabs: v.tabs().map((t) => t.textContent) }).toEqual({ width, tabs: ["总览", "项目地图", "模块进度", "团队"] });
    expect(v.selected()).toBe("overview");
    await until(() => !!v.host.querySelector("[data-headline]"), "overview");
    expect(v.host.querySelector('nav[aria-label="大纲"]')).toBeNull();
    expect(v.host.querySelector("[data-metrics], [data-metric]")).toBeNull();
    // 手机顶栏没有「团队」「待你处理」两个按钮
    expect(Array.from(v.host.querySelectorAll("button")).filter((b) => /^(团队|待你处理)/.test((b.textContent ?? "").trim()) && !b.getAttribute("data-project-tab"))).toEqual([]);
    await v.unmount();
  }
});

test("[验收线 2] 总览：一句话状态的两个数 = homeView().headline（K = problem + stuck = 2），数格没有「暂无」，卡住了 2 行点开抽屉", async () => {
  const v = await mount(MAP);
  await until(() => !!v.host.querySelector("[data-headline]") && v.host.querySelectorAll("[data-stuck-row]").length > 0, "stuck rows");
  const waits: OwnerWait[] = ptAsks().map((a) => ({ id: a.id, taskId: a.taskId, fromAgent: a.fromAgent, title: a.title }));
  const hl = homeView(ptLedgers()[MAP] as LedgerOverview, PT_NOW, fillParams, waits).headline;
  expect(hl.problem + hl.stuck).toBe(2);
  expect(v.host.querySelector("[data-headline]")?.textContent).toBe(`${hl.advancing} 个在推进 · ${hl.problem + hl.stuck} 个卡住`);
  expect(v.host.querySelector("[data-overview]")?.textContent).not.toContain("暂无");
  await until(() => !!v.host.querySelector("[data-cell=merge] b"), "count cells");
  expect(Array.from(v.host.querySelectorAll("[data-cell]"), (c) => c.getAttribute("data-cell"))).toEqual(["todayDone", "merge", "review"]);
  expect(v.host.querySelector("[data-cell=todayDone] b")?.textContent).toBe("2");
  expect(Array.from(v.host.querySelectorAll("[data-stuck-row]"), (r) => r.getAttribute("data-stuck-row"))).toEqual(STUCK_IDS);
  await v.click(v.host.querySelector(`[data-stuck-row=${STUCK_IDS[1]}]`), "stuck row");
  await until(() => (drawer()?.textContent ?? "").includes("导出格式校验"), "drawer with P2");
  await v.unmount();
});

test("[验收线 2] 已完成 14：默认收起，展开列出窗口里的 6 张，「更多」往前翻到更早的 8 张", async () => {
  const v = await mount(MAP);
  await until(() => !!v.host.querySelector("[data-done] button[aria-expanded]"), "done fold");
  const fold = v.host.querySelector("[data-done] button[aria-expanded]")!;
  expect(fold.textContent).toBe("已完成 14");
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  await v.click(fold, "done fold");
  const ids = () => Array.from(v.host.querySelectorAll("[data-done-row]"), (r) => r.getAttribute("data-done-row"));
  expect(ids()).toEqual(["D1", "D2", "E1", "E2", "E3", "E4"]);
  const more = Array.from(v.host.querySelectorAll("[data-done] button")).find((b) => b.textContent === "更多");
  await v.click(more, "more");
  await until(() => ids().includes("E12"), "earlier page");
  expect(ids().length).toBe(14);
  expect(calls).toContain(`GET /api/v1/ledger/${MAP}/done?before=cursor-1&limit=50`);
  await v.unmount();
});

test("[验收线 3] 模块进度：没选模块是有子图的模块列表；点一行进它的子图；「按人」是谁在干活看板", async () => {
  const v = await mount(MAP);
  await v.click(v.tab("module"), "module tab");
  await until(() => v.host.querySelectorAll("[data-module]").length > 0, "module list");
  expect(Array.from(v.host.querySelectorAll("[data-module]"), (r) => r.getAttribute("data-module"))).toEqual(["m-export", "m-notify"]);
  expect(v.host.querySelector("[data-project-pane=module] button[disabled]")).toBeNull();
  await v.click(v.host.querySelector("[data-module=m-notify]"), "module row");
  await until(() => !!v.host.querySelector("[data-focus-board=m-notify]"), "module sub-DAG");
  expect(v.host.querySelector("[data-project-pane=module] nav")?.textContent).toBe("模块通知");
  await v.click(Array.from(v.host.querySelectorAll("[role=tab]")).find((t) => t.textContent === "按人"), "by person");
  await until(() => !!v.host.querySelector("[data-work-board]"), "work board");
  await v.unmount();
});

test("[验收线 4] 抽屉：选中任务从右侧出来，Esc、点遮罩都能关；关掉后不占位；手机仍是整屏页", async () => {
  const v = await mount(MAP);
  expect(drawer()).toBeNull();
  await React.act(async () => ui.openCollabTask("P4"));
  await until(() => (drawer()?.textContent ?? "").includes("导出按钮改版"), "drawer");
  expect(drawer()!.querySelector("[role=dialog]")).not.toBeNull();
  await React.act(async () => { win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" })); });
  await until(() => drawer() === null, "esc closes");
  await React.act(async () => ui.openCollabTask("P5"));
  await until(() => !!drawer(), "drawer again");
  await v.click(drawer()!.querySelector("[data-drawer-scrim]"), "scrim");
  await until(() => drawer() === null, "scrim closes");
  await v.unmount();
  const m = await mount(MAP, 390);
  await React.act(async () => ui.openCollabTask("P4"));
  await until(() => (doc.body.textContent ?? "").includes("导出按钮改版"), "phone detail");
  expect(drawer()).toBeNull();
  await m.unmount();
});

test("[验收线 5] 带任务进入：属于模块的任务落到「模块进度」该模块、节点闪一次、抽屉开着；不属于模块的落在总览", async () => {
  scrolled.length = 0;
  const v = await mount(MAP, 1280, () => ui.openCollabTask("P2"));
  await until(() => v.selected() === "module" && !!v.host.querySelector("[data-focus-board=m-export]"), "entry module");
  await until(() => scrolled.includes("d"), "node flash");
  expect((drawer()?.textContent ?? "")).toContain("导出格式校验");
  await v.unmount();
  const o = await mount(MAP, 1280, () => ui.openCollabTask("P3"));
  await until(() => (drawer()?.textContent ?? "").includes("同步失败重试"), "drawer P3");
  await tick(200);
  expect(o.selected()).toBe("overview");
  await o.unmount();
});

test("[验收线 6] requestProjectTab：项目页挂载时取一次，落到模块进度的该模块；今天页模块行点了先登记再打开项目", async () => {
  const v = await mount(MAP, 1280, () => ui.tabs.requestProjectTab(MAP, { tab: "module", featureId: "m-notify" }));
  expect(v.selected()).toBe("module");
  await until(() => !!v.host.querySelector("[data-focus-board=m-notify]"), "requested module");
  expect(ui.tabs.peekProjectTab(MAP)).toBeNull();
  await v.unmount();
  // 同一项目切走再回来：回到上次的标签（不持久化，按项目键）
  const again = await mount(PLAIN);
  await again.click(again.tab("team"), "team tab");
  await again.unmount();
  const back = await (async () => {
    win.happyDOM.setViewport({ width: 1280, height: 800 });
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host as never);
    await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.CollabView, { project: PLAIN })) as never));
    await until(() => !!host.querySelector("[data-project-tab]"), "plain again");
    const sel = host.querySelector('[data-project-tab][aria-selected="true"]')?.getAttribute("data-project-tab");
    await React.act(async () => root.unmount());
    host.remove();
    return sel;
  })();
  expect(back).toBe("team");
  // 今天页「正在做」的模块行
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const row = { id: MAP, name: "合成项目", open: MAP, busy: 1, agents: [], waits: 0, stuck: 0 };
  const view = { doing: [{ row, modules: [{ id: "m-export", title: "导出", completed: 2, total: 6, active: 3, faces: [] }], workers: [], doing: true }], rest: [], idle: false,
    team: { alive: 1, busy: 1, remote: 0 } };
  const seen = { project: null as string | null };
  function Probe() { seen.project = ui.useCollabNav().project; return null; }
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.NowDoing, { view, fp: null, tr: fillParams }), h(Probe)) as never));
  await React.act(async () => host.querySelector("[data-now-module=m-export]")!.click());
  expect(ui.tabs.peekProjectTab(MAP)).toEqual({ tab: "module", featureId: "m-export" });
  expect(seen.project).toBe(MAP);
  await React.act(async () => root.unmount());
  host.remove();
  ui.closeCollab();
  ui.tabs.requestProjectTab(MAP, { tab: "overview" });
  ui.tabs.rememberTab(MAP, "overview");
});
