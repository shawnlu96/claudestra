/**
 * PDLAYOUT1 [验收线 3]：真 React DOM（happy-dom）挂 ProductView，宽 1280，数据用 tests/helpers/project-map-fixture.ts。
 * 卡数 = 主区 feature 数；「已收尾 8」「已暂停 2」胶囊点了出小标签；「按板块」出 7 个泳道头；localStorage 抛错照常渲染、默认按依赖。
 * 不出网：组件纯 props 驱动。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PROJECT_MAP_NOW, projectMapBoard } from "./helpers/project-map-fixture";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El { textContent: string | null; getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void;
  appendChild(c: El): void; disabled?: boolean }
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let ProductView: unknown;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ ProductView } = await import(new URL("../web/features/collab/product/product-view.tsx", import.meta.url).href));
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
afterEach(() => {
  try { (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear(); } catch { /* 被测试换成抛错的了 */ }
});

const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));
const doc = () => (globalThis as unknown as { document: { createElement(t: string): El; body: El } }).document;

async function mount(extra: Record<string, unknown> = {}) {
  const host = doc().createElement("div");
  doc().body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as unknown as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ProductView, { board: projectMapBoard(PROJECT_MAP_NOW), narrow: false, now: PROJECT_MAP_NOW,
    onFeature: () => {}, tr, ...extra }) as never));
  const rerender = (more: Record<string, unknown>) => React.act(async () => root.render(h(ProductView, { board: projectMapBoard(PROJECT_MAP_NOW), narrow: false,
    now: PROJECT_MAP_NOW, onFeature: () => {}, tr, ...more }) as never));
  return { host, rerender, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const all = (host: El, sel: string) => Array.from(host.querySelectorAll(sel));
const button = (host: El, text: string | RegExp) => all(host, "button").find((b) => (typeof text === "string" ? b.textContent === text : text.test(b.textContent ?? "")))!;
const click = (el: El) => React.act(async () => el.click());

test("one [data-pd-card] per main-area feature; dependency mode by default with the summary line", async () => {
  const { host, unmount } = await mount();
  expect(all(host, "[data-pd-card]")).toHaveLength(16);
  expect(all(host, "[data-pd-chip]").map((c) => c.getAttribute("data-pd-chip"))).toEqual(["f-ledger"]);
  expect(button(host, "按依赖").getAttribute("aria-checked")).toBe("true");
  expect(all(host, "[data-pd-summary]")[0].textContent).toBe("16 个没收尾 · 5 在跑 · 1 受阻 · 2 久未动 · 3 可以开工 · 3 待验收 · 2 在等前置");
  expect(all(host, "[data-pd-zone=chains]")[0].textContent).toBe("依赖链 · 3 串");
  expect(all(host, "[data-pd-zone=solo]")[0].textContent).toBe("独立推进 · 8 个 · 2 在跑");
  expect(all(host, "[data-pd-card=f-lend] [data-pd-detail]").map((e) => e.textContent)).toContain("拆自 协作底座改版");
  await unmount();
});

test("「已收尾 8」「已暂停 2」 pills expand their chips and flip aria-expanded", async () => {
  const { host, unmount } = await mount();
  const done = button(host, "已收尾 8"), paused = button(host, "已暂停 2");
  expect([done.getAttribute("aria-expanded"), paused.getAttribute("aria-expanded")]).toEqual(["false", "false"]);
  await click(done);
  expect(all(host, "[data-pd-chip^='done:']")).toHaveLength(8);
  expect(button(host, "已收尾 8").getAttribute("aria-expanded")).toBe("true");
  await click(button(host, "已暂停 2"));
  const chips = all(host, "[data-pd-chip^='paused:']");
  expect(chips.map((c) => c.textContent).sort()).toEqual(["Codex 调用已暂停", "消息投递冻结"]);
  expect(button(host, "已暂停 2").getAttribute("aria-expanded")).toBe("true");
  expect((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("projmap:_:done")).toBe("1");
  await unmount();
});

test("「按板块」 shows 7 lane heads and is remembered", async () => {
  const { host, unmount } = await mount();
  await click(button(host, "按板块"));
  const heads = all(host, "[data-pd-lane-head]");
  expect(heads).toHaveLength(7);
  expect(heads.at(-1)!.textContent).toMatch(/^未分组 · 0 在跑/);
  expect(all(host, "[data-pd-card]")).toHaveLength(16);
  await click(button(host, /^✓ 1$/));
  expect(all(host, "[data-pd-chip^='lane-done:']").length).toBe(1);
  await unmount();
  const again = await mount();
  expect(all(again.host, "[data-pd-lane-head]")).toHaveLength(7);
  await again.unmount();
});

test("a throwing localStorage still renders, in dependency mode", async () => {
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    const { host, unmount } = await mount();
    expect(all(host, "[data-pd-card]")).toHaveLength(16);
    expect(button(host, "按依赖").getAttribute("aria-checked")).toBe("true");
    await click(button(host, "按板块"));
    expect(all(host, "[data-pd-lane-head]")).toHaveLength(7);
    await unmount();
  } finally {
    if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  }
});

test("preferences are kept per project and a project switch reloads that project's keys", async () => {
  const ls = (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  ls.setItem("projmap:beta:mode", "lane");
  const { host, rerender, unmount } = await mount({ project: "alpha" });
  expect(button(host, "按依赖").getAttribute("aria-checked")).toBe("true");
  await click(button(host, "已收尾 8"));
  expect([ls.getItem("projmap:alpha:done"), ls.getItem("projmap:_:done"), ls.getItem("projmap:beta:done")]).toEqual(["1", null, null]);
  await rerender({ project: "beta" });
  expect(button(host, "按板块").getAttribute("aria-checked")).toBe("true");
  expect(button(host, "已收尾 8").getAttribute("aria-expanded")).toBe("false");
  await click(button(host, "按依赖"));
  expect([ls.getItem("projmap:beta:mode"), ls.getItem("projmap:alpha:mode")]).toEqual(["dep", null]);
  await rerender({ project: "alpha" });
  expect(button(host, "已收尾 8").getAttribute("aria-expanded")).toBe("true");
  await unmount();
});
