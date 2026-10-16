/** PDFOCUS1 [验收线 2]：真实 React DOM（happy-dom）里的选中 / 双击进入 / Esc / 过滤 / 关键路径 / 模块页。 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProductBoard } from "../web/lib/api/product-board-types";
import { PROJECT_MAP_NOW as now, projectMapBoard } from "./helpers/project-map-fixture";

type ReactApi = typeof import("../web/node_modules/@types/react/index");
type ClientApi = typeof import("../web/node_modules/@types/react-dom/client");
interface El {
  textContent: string | null; getAttribute(key: string): string | null; querySelectorAll(q: string): ArrayLike<El>; hasAttribute(k: string): boolean;
  dispatchEvent(e: unknown): void; appendChild(child: El): void; remove(): void; parentElement: El | null;
}
const fromWeb = createRequire(new URL("../web/package.json", import.meta.url));
let react: ReactApi, createRoot: ClientApi["createRoot"], View: unknown;
const roots: Array<() => Promise<void>> = [];
const tr = (s: string, vars?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));
const g = () => globalThis as unknown as {
  document: { createElement(tag: string): El; body: El };
  window: { dispatchEvent(e: unknown): void }; KeyboardEvent: new (type: string, opts: { key: string; bubbles?: boolean }) => unknown;
  MouseEvent: new (type: string, opts: { bubbles: boolean; detail?: number }) => unknown;
  PointerEvent: new (type: string, opts: { bubbles: boolean; button?: number; pointerId?: number; clientX?: number; clientY?: number }) => unknown;
  localStorage: { clear(): void; getItem(k: string): string | null; setItem(k: string, v: string): void };
};
const all = (e: El, q: string) => Array.from(e.querySelectorAll(q));
const one = (e: El, q: string) => all(e, q)[0]!;
const fire = (e: El, ev: unknown) => react.act(async () => e.dispatchEvent(ev));
/** 鼠标单击（detail 1）；键盘激活是 detail 0 */
const click = (e: El, detail = 1) => fire(e, new (g().MouseEvent)("click", { bubbles: true, detail }));
const dblclick = async (e: El) => { await click(e, 1); await click(e, 2); await fire(e, new (g().MouseEvent)("dblclick", { bubbles: true })); };
const esc = () => react.act(async () => g().window.dispatchEvent(new (g().KeyboardEvent)("keydown", { key: "Escape" })));

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  react = fromWeb("react") as ReactApi;
  createRoot = (fromWeb("react-dom/client") as ClientApi).createRoot;
  View = (require("../web/features/collab/product/product-view.tsx") as { ProductView: unknown }).ProductView;
});
afterEach(async () => { for (const clean of roots.splice(0)) await clean(); g().localStorage.clear(); });
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

async function render(board: ProductBoard = projectMapBoard(now), project?: string) {
  const host = g().document.createElement("div"), features: string[] = [], tasks: string[] = [];
  g().document.body.appendChild(host);
  const root = createRoot(host as never);
  await react.act(async () => root.render(react.createElement(View as never, { board, narrow: false, now, tr, project,
    onFeature: (id: string) => features.push(id), onTask: (id: string) => tasks.push(id) } as never)));
  roots.push(async () => { await react.act(async () => root.unmount()); host.remove(); });
  return { host, features, tasks };
}
const main = (host: El, id: string) => one(host, `[data-pd-card="${id}"] > button[aria-pressed]`);
const card = (host: El, id: string) => one(host, `[data-pd-card="${id}"]`);
const lit = (host: El) => all(host, "[data-pd-card]").filter(c => !c.hasAttribute("data-pd-dim")).map(c => c.getAttribute("data-pd-card")).sort();
const side = (host: El) => all(host, "[data-pd-side]")[0];

test("单击卡 → 模块页、上下游亮其余暗，onFeature 没调用；双击 → onFeature 一次", async () => {
  const { host, features } = await render();
  await click(main(host, "f-team"));
  expect(features).toEqual([]);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("f-team");
  expect(side(host)!.textContent).toContain("团队项目");
  expect(card(host, "f-team").getAttribute("data-pd-selected")).toBe("true");
  expect(lit(host)).toEqual(["f-private", "f-roster", "f-team"]);
  expect(all(host, "[data-pd-edge-strong]").map(e => e.getAttribute("class")).length).toBe(4);
  await dblclick(main(host, "f-merge"));
  expect(features).toEqual(["f-merge"]);
});

test("Esc / 再点同一张卡 / 点空白都取消，所有卡恢复不变暗", async () => {
  const { host } = await render();
  await click(main(host, "f-team"));
  await esc();
  expect(side(host)).toBeUndefined();
  expect(all(host, "[data-pd-dim]")).toHaveLength(0);
  expect(all(host, "[data-pd-edge-dim]")).toHaveLength(0);
  await click(main(host, "f-team"));
  await click(main(host, "f-team"));
  expect(side(host)).toBeUndefined();
  await click(main(host, "f-team"));
  const canvas = one(host, "[data-pd-mode]").parentElement!;
  await fire(canvas, new (g().PointerEvent)("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 5, clientY: 5 }));
  await fire(canvas, new (g().PointerEvent)("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 5, clientY: 5 }));
  expect(side(host)).toBeUndefined();
});

test("键盘：Enter 先选中，再按一次 Enter 进入", async () => {
  const { host, features } = await render();
  await click(main(host, "f-dispatch"), 0);
  expect(features).toEqual([]);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("f-dispatch");
  await click(main(host, "f-dispatch"), 0);
  expect(features).toEqual(["f-dispatch"]);
});

test("过滤『受阻 · 久未动』只剩 3 张卡亮；0 的胶囊禁用；过滤值存 localStorage", async () => {
  const { host } = await render(projectMapBoard(now), "p1");
  const pill = one(host, '[data-pd-filter="blocked"]');
  expect(pill.textContent).toBe("受阻 · 久未动 3");
  await click(pill);
  expect(pill.getAttribute("aria-pressed")).toBe("true");
  expect(lit(host)).toEqual(["f-agents", "f-dispatch", "f-sched"]);
  expect(g().localStorage.getItem("projmap:p1:filter")).toBe("blocked");
  // 没有待验收的板：『待验收』胶囊 disabled
  const b = projectMapBoard(now);
  for (const f of b.features) if (f.state === "gate") f.state = "ready";
  const { host: h2 } = await render(b);
  expect(one(h2, '[data-pd-filter="gate"]').hasAttribute("disabled")).toBe(true);
  expect(one(h2, '[data-pd-filter="all"]').textContent).toBe("全部 16");
});

test("模块页：被挡着 / 挡着谁的写法，点一行换选中；在跑全部行；看模块进度 = onFeature", async () => {
  const { host, features, tasks } = await render();
  await click(main(host, "f-team"));
  const page = side(host)!;
  expect(page.textContent).toContain("4 / 12完成");
  expect(page.textContent).toContain("4 在跑 · 0 在等前置");
  expect(page.textContent).toContain("最近动静 30 分钟前");
  const rel = all(page, "[data-pd-related]").map(r => `${r.getAttribute("data-pd-related")}:${r.textContent}`);
  expect(rel).toEqual(["f-private:私有云拆分在等", "f-private:私有云拆分6 个节点等锁", "f-roster:成员名册1 个节点等锁"]);
  expect(all(page, "[data-pd-frontier] [data-pd-task]")).toHaveLength(5);
  await click(one(page, "[data-pd-frontier] button[data-pd-task]"));
  expect(tasks).toEqual(["t-tp-5"]);
  await click(all(page, "[data-pd-related]")[0]!);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("f-private");
  expect(card(host, "f-private").getAttribute("data-pd-selected")).toBe("true");
  await click(one(side(host)!, "[data-pd-open]"));
  expect(features).toEqual(["f-private"]);
  // 独立推进的卡：两个列表都是空的写法
  await click(main(host, "f-sessions"));
  expect(side(host)!.textContent).toContain("没有前置");
  expect(side(host)!.textContent).toContain("没有谁在等它");
});

test("关键路径：开关 aria-pressed，路径卡挂小标、其余变暗、模块页有关键链；没有 cpHours 时禁用", async () => {
  const { host } = await render();
  const toggle = one(host, "[data-pd-cp-toggle]");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(all(host, "[data-pd-cp]").map(t => t.textContent)).toEqual(["关键路径 · 约 33 小时", "关键路径 · 约 33 小时"]);
  expect(lit(host)).toEqual(["f-private", "f-team"]);
  await click(main(host, "f-team"));
  expect(one(side(host)!, "[data-pd-cp-chain]").textContent).toBe("关键链 · 约 33 小时私有云拆分团队项目");
  const b = projectMapBoard(now);
  for (const f of b.features) if (f.eta?.basis) delete f.eta.basis.cpHours;
  const { host: h2 } = await render(b);
  const off = one(h2, "[data-pd-cp-toggle]");
  expect(off.hasAttribute("disabled")).toBe(true);
  expect(off.getAttribute("title")).toBe("现在没有能连起来的关键路径");
});

test("团队视图没有 frontier / links：模块页不渲染对应小节", async () => {
  const b = projectMapBoard(now);
  const team: ProductBoard = { features: b.features.map(f => ({ ...f, frontier: undefined })), deps: b.deps };
  const { host } = await render(team);
  await click(main(host, "f-private"));
  const page = side(host)!;
  expect(page.textContent).not.toContain("被挡着");
  expect(page.textContent).not.toContain("挡着谁");
  expect(all(page, "[data-pd-frontier]")).toHaveLength(0);
  expect(all(page, "[data-pd-open]")).toHaveLength(1);
});

test("选中 + 过滤叠加：选中的卡不豁免过滤；选中边后端点第一次 Enter 只选中", async () => {
  const { host, features } = await render();
  await click(main(host, "f-team"));
  await click(one(host, '[data-pd-filter="blocked"]'));
  expect(lit(host)).toEqual([]);
  expect(card(host, "f-team").getAttribute("data-pd-selected")).toBe("true");
  await click(one(host, '[data-pd-filter="all"]'));
  await click(one(host, '[data-pd-hit="dep:f-private>f-team"]'));
  expect(side(host)?.getAttribute("data-pd-side")).toBe("dep:f-private>f-team");
  expect(card(host, "f-team").getAttribute("data-pd-selected")).toBe("true");
  expect(main(host, "f-team").getAttribute("aria-pressed")).toBe("false");
  await click(main(host, "f-team"), 0);
  expect(features).toEqual([]);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("f-team");
  await click(main(host, "f-team"), 0);
  expect(features).toEqual(["f-team"]);
});

test("键盘：从边页把焦点移到端点卡，Enter 选中后焦点留在卡上，再按 Enter（对真实焦点）进入", async () => {
  const { host, features } = await render();
  const doc = () => (globalThis as unknown as { document: { activeElement: unknown } }).document;
  const focus = (e: El) => react.act(async () => (e as unknown as { focus(): void }).focus());
  const label = one(host, '[data-pd-label="dep:f-private>f-team"]');
  await focus(label);
  await click(label, 0);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("dep:f-private>f-team");
  await focus(main(host, "f-team"));
  await click(main(host, "f-team"), 0);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("f-team");
  expect(doc().activeElement === main(host, "f-team")).toBe(true);
  await click(doc().activeElement as El, 0);
  expect(features).toEqual(["f-team"]);
  // 真关掉边页（Esc）时，焦点照旧还给打开前的元素
  await focus(label);
  await click(label, 0);
  expect(side(host)?.getAttribute("data-pd-side")).toBe("dep:f-private>f-team");
  await esc();
  expect(side(host)).toBeUndefined();
  expect(doc().activeElement === one(host, '[data-pd-label="dep:f-private>f-team"]')).toBe(true);
});
