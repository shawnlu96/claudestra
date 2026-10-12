/**
 * PBL-1：协作视图首帧不再闪「因果线」画布。真 ProductPanes + 真 useProductBoard 挂到 happy-dom（React 19），
 * 产品 DAG 读接口经 CollabSourceContext 注入、由测试手动 resolve / reject，不连真 bridge。
 * MutationObserver 盯住每一次 DOM 变动：加载中到 board 到达之间，「因果线」标签和兜底画布一帧都不许出现。
 * 旧红新绿：main 上 board 未到时 ProductPanes 退到 dag 标签、写「因果线」、渲染 fallback，board 到了再换掉。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProductBoard } from "../web/lib/api/product-board-types";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
type Reader = (project: string, signal?: AbortSignal) => Promise<ProductBoard>;
interface El {
  textContent: string | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>;
  appendChild(c: El): void; remove(): void;
}
interface Dom {
  document: { createElement(tag: string): El; body: El };
  MutationObserver: new (cb: () => void) => { observe(t: El, o: Record<string, boolean>): void; disconnect(): void };
}
const dom = () => globalThis as unknown as Dom;

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let ui: {
  ProductPanes: (p: Record<string, unknown>) => unknown;
  useProductBoard: (project: string, rev: number) => unknown;
  CollabSourceContext: { Provider: unknown };
};

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react");
  ({ createRoot } = webRequire("react-dom/client"));
  const [panes, hook, ctx] = await Promise.all([
    import(mod("collab/product/product-panes.tsx")),
    import(mod("collab/product/use-product-board.ts")),
    import(mod("collab/team-source-context.ts")),
  ]);
  ui = { ProductPanes: panes.ProductPanes, useProductBoard: hook.useProductBoard, CollabSourceContext: ctx.CollabSourceContext };
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

const boardOf = (title: string): ProductBoard => ({
  features: [{ id: `f-${title}`, title, status: "active", hasDag: false, version: 1, counts: { total: 1, completed: 0, active: 1 }, eta: null, cards: [] }],
  deps: [],
});

type Load = { status: "loading" } | { status: "absent" } | { status: "ok"; board: ProductBoard };
/** use-dag-panes 里同样的接线：hook 三态 → ProductPanes 的 board + loading */
const asPaneProps = (l: Load) => ({ board: l.status === "ok" ? l.board : null, loading: l.status === "loading" });

/** 每次调用排一个待定的 promise，测试按顺序 resolve / reject */
function controlledReader() {
  const calls: { project: string; resolve: (b: ProductBoard) => void; reject: (e: Error) => void }[] = [];
  const read: Reader = (project) => new Promise((resolve, reject) => { calls.push({ project, resolve, reject }); });
  return { read, calls };
}

const tabs = (el: El) => Array.from(el.querySelectorAll('[role="tab"]')).map(b => b.textContent);
const causal = (el: El) => !!el.querySelector("[data-causal]") || tabs(el).includes("因果线");

const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);
const paneBase = () => ({
  dagBoard: null, featureId: null, tab: "product", setTab: () => {}, onFeature: () => {}, onTask: () => {}, subdag: null,
  fallback: h("svg", { "data-causal": "1" }, h("path", { d: "M0 0L1 1" })), progress: null, team: h("i", null, "team"),
  graph: false, narrow: false, now: 0, tr: (s: string) => s,
});

/** 挂一个根，MutationObserver 记下任何一帧出现过的因果线 */
function watched() {
  const el = dom().document.createElement("div");
  dom().document.body.appendChild(el);
  const root = createRoot(el as never);
  let flashed = false;
  const obs = new (dom().MutationObserver)(() => { if (causal(el)) flashed = true; });
  obs.observe(el, { childList: true, subtree: true, characterData: true });
  const show = (node: unknown) => React.act(async () => { root.render(node as never); });
  const done = () => React.act(async () => { obs.disconnect(); root.unmount(); el.remove(); });
  return { el, show, done, flashed: () => flashed || causal(el) };
}

function mount(read: Reader) {
  const source = { product: read };
  function Probe({ project, rev }: { project: string; rev: number }) {
    return h(ui.ProductPanes, { ...paneBase(), ...asPaneProps(ui.useProductBoard(project, rev) as Load) });
  }
  const w = watched();
  const render = (project: string, rev: number) => w.show(h(ui.CollabSourceContext.Provider, { value: source }, h(Probe, { project, rev })));
  const settle = (fn: () => void) => React.act(async () => { fn(); await new Promise(r => setTimeout(r, 0)); });
  return { ...w, render, settle };
}

test("ProductPanes 直接渲染：加载中 → 真 board，每一帧都没有「因果线」标签和兜底画布", async () => {
  const w = watched();
  await w.show(h(ui.ProductPanes, { ...paneBase(), board: null, loading: true }));
  expect(causal(w.el)).toBe(false);
  expect(tabs(w.el)[0]).toBe("产品 DAG");
  expect(w.el.querySelector('[role="status"]')?.textContent).toBe("加载中…");
  await w.show(h(ui.ProductPanes, { ...paneBase(), board: boardOf("真看板"), loading: false }));
  expect(w.el.textContent).toContain("真看板");
  expect(w.el.querySelector('[role="status"]')).toBeNull();
  expect(w.flashed()).toBe(false);
  await w.done();
});

test("首帧 rev=0（有缓存总览）就开始拉；board 到达前后都不闪因果线", async () => {
  const { read, calls } = controlledReader();
  const m = mount(read);
  await m.render("p1", 0);
  expect(calls.length).toBe(1);
  expect(m.el.querySelector('[role="status"]')).not.toBeNull();
  await m.settle(() => calls[0]!.resolve(boardOf("首个")));
  expect(m.el.textContent).toContain("首个");
  await m.render("p1", 1);
  expect(calls.length).toBe(2);
  await m.settle(() => calls[1]!.resolve(boardOf("首个")));
  expect(m.flashed()).toBe(false);
  await m.done();
});

test("确定没有产品 DAG（首次读失败）仍走现有兜底：因果线标签 + 画布", async () => {
  const { read, calls } = controlledReader();
  const m = mount(read);
  await m.render("p1", 1);
  await m.settle(() => calls[0]!.reject(new Error("404")));
  expect(tabs(m.el)[0]).toBe("因果线");
  expect(m.el.querySelector("[data-causal]")).not.toBeNull();
  await m.done();
});

test("同项目已有 board 后某次刷新失败：保留上一份 board，不退回因果线", async () => {
  const { read, calls } = controlledReader();
  const m = mount(read);
  await m.render("p1", 1);
  await m.settle(() => calls[0]!.resolve(boardOf("留着")));
  await m.render("p1", 2);
  await m.settle(() => calls[1]!.reject(new Error("network")));
  expect(m.el.textContent).toContain("留着");
  expect(m.flashed()).toBe(false);
  await m.done();
});

test("切项目不带上一个项目的 board：新项目先占位，失败走兜底而不是旧 board", async () => {
  const { read, calls } = controlledReader();
  const m = mount(read);
  await m.render("p1", 1);
  await m.settle(() => calls[0]!.resolve(boardOf("甲项目")));
  await m.render("p2", 1);
  expect(calls.at(-1)!.project).toBe("p2");
  expect(m.el.textContent).not.toContain("甲项目");
  expect(m.el.querySelector('[role="status"]')).not.toBeNull();
  expect(causal(m.el)).toBe(false);
  await m.settle(() => calls.at(-1)!.reject(new Error("404")));
  expect(m.el.textContent).not.toContain("甲项目");
  expect(tabs(m.el)[0]).toBe("因果线");
  await m.done();
});
