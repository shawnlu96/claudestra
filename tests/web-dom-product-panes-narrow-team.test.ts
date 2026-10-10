/**
 * team-project-N8B9：tab 停在「团队」时缩到窄屏，主区域不再整块空白。真 ProductPanes 挂到 happy-dom（React 19）。
 * 窄屏没有「团队」tab，渲染时按 product 换算（没有 board 按 dag），选中的按钮和内容一致；存下来的 tab 不动，回到宽屏还是「团队」。
 * 旧红新绿：main 上窄屏 + tab=team 仍渲染团队面板（窄屏下是空的），「产品 DAG」却显示选中。
 * 换算以外的渲染不变：窄屏 + team 的 HTML 和窄屏 + product（没有 board 时 dag）逐字节相同，宽屏 + team、窄屏其余 tab 照旧。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProductBoard } from "../web/lib/api/product-board-types";

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
let ProductPanes: (p: Record<string, unknown>) => unknown;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react");
  ({ createRoot } = webRequire("react-dom/client"));
  ({ ProductPanes } = await import(new URL("../web/features/collab/product/product-panes.tsx", import.meta.url).href));
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

const board: ProductBoard = {
  features: [{ id: "f1", title: "真看板", status: "active", hasDag: false, version: 1, counts: { total: 1, completed: 0, active: 1 }, eta: null, cards: [] }],
  deps: [],
};

const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);
const base = () => ({
  board: null as ProductBoard | null, dagBoard: null, featureId: null as string | null, tab: "team", setTab: (_: string) => {},
  onFeature: () => {}, onTask: () => {}, subdag: h("i", { "data-subdag": "1" }, "子图"), fallback: h("i", { "data-causal": "1" }, "兜底"),
  progress: h("i", { "data-progress": "1" }, "进度"), team: h("i", { "data-team": "1" }, "团队面板"),
  graph: false, narrow: true, now: 0, tr: (s: string) => s,
});
type PaneProps = ReturnType<typeof base>;

function mounted() {
  const el = doc().createElement("div");
  doc().body.appendChild(el);
  const root = createRoot(el as never);
  const show = (node: unknown) => React.act(async () => { root.render(node as never); });
  const done = () => React.act(async () => { root.unmount(); el.remove(); });
  return { el, show, done };
}
async function html(over: Partial<PaneProps>) {
  const m = mounted();
  await m.show(h(ProductPanes, { ...base(), ...over }));
  const out = m.el.innerHTML, snap = { html: out, on: selected(m.el), tabs: tabs(m.el), has: (part: string) => out.includes(part) };
  await m.done();
  return snap;
}
const tabs = (el: El) => Array.from(el.querySelectorAll('[role="tab"]')).map(b => b.textContent);
const selected = (el: El) => Array.from(el.querySelectorAll('[role="tab"]')).filter(b => b.getAttribute("aria-selected") === "true").map(b => b.textContent);

test("窄屏 + tab=team + 有 board：渲染产品 DAG 内容，「产品 DAG」选中，和窄屏 + product 逐字节相同", async () => {
  const team = await html({ board });
  expect(team.html).toContain("真看板");
  expect(team.has("data-team")).toBe(false);
  expect(team.tabs).toEqual(["产品 DAG", "谁在干活"]);
  expect(team.on).toEqual(["产品 DAG"]);
  expect(team.html).toBe((await html({ board, tab: "product" })).html);
});

test("窄屏 + tab=team + board 还在加载：占位，和窄屏 + product 逐字节相同", async () => {
  const team = await html({ loading: true } as Partial<PaneProps>);
  expect(team.has('role="status"')).toBe(true);
  expect(team.on).toEqual(["产品 DAG"]);
  expect(team.html).toBe((await html({ loading: true, tab: "product" } as Partial<PaneProps>)).html);
});

test("窄屏 + tab=team + 没有 board：渲染 dag 内容，dag 按钮选中，和窄屏 + dag 逐字节相同", async () => {
  const causal = await html({});
  expect(causal.has("data-causal")).toBe(true);
  expect(causal.has("data-team")).toBe(false);
  expect(causal.tabs).toEqual(["因果线", "谁在干活"]);
  expect(causal.on).toEqual(["因果线"]);
  expect(causal.html).toBe((await html({ tab: "dag" })).html);
  const graph = await html({ graph: true });
  expect(graph.has("data-subdag")).toBe(true);
  expect(graph.on).toEqual(["子 DAG"]);
  expect(graph.html).toBe((await html({ graph: true, tab: "dag" })).html);
});

test("宽屏 + tab=team 照旧：团队面板在，「团队」选中", async () => {
  for (const over of [{ board }, {}] as Partial<PaneProps>[]) {
    const wide = await html({ ...over, narrow: false });
    expect(wide.has("data-team")).toBe(true);
    expect(wide.html).not.toContain("真看板");
    expect(wide.has("data-causal")).toBe(false);
    expect(wide.on).toEqual(["团队"]);
  }
});

test("窄屏其余 tab 照旧：progress / product / 选了 feature 的 dag", async () => {
  const progress = await html({ board, tab: "progress" });
  expect(progress.has("data-progress")).toBe(true);
  expect(progress.html).not.toContain("真看板");
  expect(progress.on).toEqual(["谁在干活"]);
  const product = await html({ board, tab: "product" });
  expect(product.html).toContain("真看板");
  expect(product.on).toEqual(["产品 DAG"]);
  const dag = await html({ board, tab: "dag", featureId: "f1" });
  expect(dag.on).toEqual(["产品 DAG"]);
  expect(dag.html).not.toBe(product.html);
  const none = await html({ tab: "progress" });
  expect(none.has("data-progress")).toBe(true);
  expect(none.on).toEqual(["谁在干活"]);
});

test("只在渲染时换算：1280 选「团队」→ 缩到窄屏显示产品 DAG → 回到宽屏还是「团队」，期间 setTab 没被调用", async () => {
  const calls: string[] = [];
  function Host({ narrow }: { narrow: boolean }) {
    const [tab, set] = React.useState("product");
    return h(ProductPanes, { ...base(), board, narrow, tab, setTab: (t: string) => { calls.push(t); set(t); } });
  }
  const m = mounted();
  await m.show(h(Host, { narrow: false }));
  const teamTab = Array.from(m.el.querySelectorAll('[role="tab"]')).find(b => b.textContent === "团队")!;
  await React.act(async () => { teamTab.click(); });
  expect(calls).toEqual(["team"]);
  expect(selected(m.el)).toEqual(["团队"]);
  const wideBefore = m.el.innerHTML;
  await m.show(h(Host, { narrow: true }));
  expect(m.el.textContent).toContain("真看板");
  expect(m.el.querySelector("[data-team]")).toBeNull();
  expect(selected(m.el)).toEqual(["产品 DAG"]);
  await m.show(h(Host, { narrow: false }));
  expect(m.el.innerHTML).toBe(wideBefore);
  expect(selected(m.el)).toEqual(["团队"]);
  expect(calls).toEqual(["team"]);
  await m.done();
});
