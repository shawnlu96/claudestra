/**
 * PROJTABS1「模块进度」标签（product/product-panes.tsx ModulePane）真挂到 happy-dom（React 19），桌面 / 手机各跑一遍。
 * [验收线 3] 没选模块时是有子图的模块列表（不是灰掉的标签），点一行 = onFeature(id)；选了模块是它的子图，面包屑「模块」回列表；
 * 「按人」分段 = 调用方给的谁在干活看板；没有可列的模块时不出分段，直接是按人。
 * 原 N8B9（窄屏没有「团队」标签时的换算）随四标签作废：团队在桌面手机都是一个标签（tests/web-dom-project-tabs.test.ts）。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProductBoard, ProductFeature } from "../web/lib/api/product-board-types";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El {
  textContent: string | null; innerHTML: string; click(): void; getAttribute(n: string): string | null;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; appendChild(c: El): void; remove(): void;
}
const doc = () => (globalThis as unknown as { document: { createElement(tag: string): El; body: El } }).document;

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let ModulePane: (p: Record<string, unknown>) => unknown;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react");
  ({ createRoot } = webRequire("react-dom/client"));
  ({ ModulePane } = await import(new URL("../web/features/collab/product/product-panes.tsx", import.meta.url).href));
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

const feature = (id: string, title: string, hasDag: boolean): ProductFeature =>
  ({ id, title, status: "active", hasDag, version: 1, counts: { total: 4, completed: 1, active: 1 }, eta: null, cards: [] });
const board: ProductBoard = { features: [feature("f1", "合成模块甲", true), feature("f2", "合成模块乙", true), feature("f3", "没有子图的模块", false)], deps: [] };
const noDag: ProductBoard = { features: [feature("f3", "没有子图的模块", false)], deps: [] };
const dagBoard = { now: 0, agents: [], features: [{ id: "f1", title: "合成模块甲", currentVersion: 1, nodes: [] }] };

const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);
const base = () => ({
  board: board as ProductBoard | null, loading: false, dagBoard: null as unknown, featureId: null as string | null, by: "module", setBy: (_: string) => {},
  onBack: () => {}, onFeature: (_: string) => {}, onTask: () => {}, subdag: h("i", { "data-subdag": "1" }, "子图"),
  fallback: h("i", { "data-causal": "1" }, "兜底"), progress: h("i", { "data-progress": "1" }, "进度"), graph: false, narrow: false, now: 0, tr: (s: string) => s,
});
type PaneProps = ReturnType<typeof base>;

async function mounted(over: Partial<PaneProps>) {
  const el = doc().createElement("div");
  doc().body.appendChild(el);
  const root = createRoot(el as never);
  await React.act(async () => { root.render(h(ModulePane, { ...base(), ...over }) as never); });
  return { el, done: () => React.act(async () => { root.unmount(); el.remove(); }) };
}
const segs = (el: El) => Array.from(el.querySelectorAll('[role="tab"]')).map(b => [b.textContent, b.getAttribute("aria-selected")]);

for (const narrow of [false, true]) {
  const size = narrow ? "390" : "1280";

  test(`${size} [验收线 3] 没选模块：有子图的模块一行一个，不是灰标签；点一行选中它`, async () => {
    const picked: string[] = [];
    const m = await mounted({ narrow, onFeature: (id: string) => picked.push(id) });
    const rows = Array.from(m.el.querySelectorAll("[data-module]"));
    expect(rows.map(r => r.getAttribute("data-module"))).toEqual(["f1", "f2"]);
    expect(m.el.querySelector("button[disabled]")).toBeNull();
    expect(segs(m.el)).toEqual([["按模块", "true"], ["按人", "false"]]);
    await React.act(async () => { rows[1]!.click(); });
    expect(picked).toEqual(["f2"]);
    expect(m.el.textContent).not.toMatch(/feature|子 DAG|产品 DAG/);
    await m.done();
  });

  test(`${size} [验收线 3] 选了模块：面包屑「模块 › 名字」+ 子图；面包屑回列表；没有快照退回兜底`, async () => {
    const back: number[] = [];
    const m = await mounted({ narrow, featureId: "f1", dagBoard, onBack: () => back.push(1) });
    expect(m.el.querySelector("[data-subdag]")).not.toBeNull();
    expect(m.el.querySelector("nav")?.textContent).toBe("模块合成模块甲");
    await React.act(async () => { m.el.querySelector("nav button")!.click(); });
    expect(back).toEqual([1]);
    await m.done();
    const missing = await mounted({ narrow, featureId: "f2", dagBoard });
    expect(missing.el.querySelector("[data-causal]")).not.toBeNull();
    await missing.done();
  });

  test(`${size} [验收线 3] 「按人」是谁在干活看板；点分段调 setBy`, async () => {
    const calls: string[] = [];
    const m = await mounted({ narrow, by: "person", setBy: (b: string) => calls.push(b) });
    expect(m.el.querySelector("[data-progress]")).not.toBeNull();
    expect(m.el.querySelector("[data-module]")).toBeNull();
    expect(segs(m.el)).toEqual([["按模块", "false"], ["按人", "true"]]);
    await React.act(async () => { m.el.querySelectorAll('[role="tab"]')[0]!.click(); });
    expect(calls).toEqual(["module"]);
    await m.done();
  });

  test(`${size} 没有可列的模块：不出分段，直接按人；老 bridge 没有产品看板但有子图时按模块是子图`, async () => {
    for (const over of [{ board: noDag }, { board: null }] as Partial<PaneProps>[]) {
      const m = await mounted({ narrow, ...over });
      expect(m.el.querySelector('[role="tablist"]')).toBeNull();
      expect(m.el.querySelector("[data-progress]")).not.toBeNull();
      await m.done();
    }
    const graph = await mounted({ narrow, board: null, graph: true });
    expect(graph.el.querySelector("[data-subdag]")).not.toBeNull();
    expect(segs(graph.el).length).toBe(2);
    await graph.done();
    const loading = await mounted({ narrow, board: null, loading: true });
    expect(loading.el.querySelector('[role="status"]')?.textContent).toBe("加载中…");
    await loading.done();
  });
}
