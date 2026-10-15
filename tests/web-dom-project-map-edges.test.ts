/** PDEDGEUI1 [验收线 1]：真实 React DOM，点击边的命中路径与标签，核对证据、卡号跳转和关闭。 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProductBoard } from "../web/lib/api/product-board-types";
import { PROJECT_MAP_NOW as now, projectMapBoard } from "./helpers/project-map-fixture";

type ReactApi = typeof import("../web/node_modules/@types/react/index");
type ClientApi = typeof import("../web/node_modules/@types/react-dom/client");
interface ElementLike {
  textContent: string | null; getAttribute(key: string): string | null; querySelectorAll(q: string): ArrayLike<ElementLike>;
  click(): void; dispatchEvent(e: unknown): void; appendChild(child: ElementLike): void; remove(): void;
}
const fromWeb = createRequire(new URL("../web/package.json", import.meta.url));
let react: ReactApi, createRoot: ClientApi["createRoot"], View: unknown;
const roots: Array<() => Promise<void>> = [];
const tr = (s: string, vars?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));
const dom = () => globalThis as unknown as {
  document: { createElement(tag: string): ElementLike; body: ElementLike };
  window: { dispatchEvent(e: unknown): void }; KeyboardEvent: new (type: string, opts: { key: string; bubbles?: boolean }) => unknown;
  MouseEvent: new (type: string, opts: { bubbles: boolean }) => unknown;
  localStorage: { clear(): void };
};
const all = (e: ElementLike, q: string) => Array.from(e.querySelectorAll(q));
const one = (e: ElementLike, q: string) => all(e, q)[0]!;
const activate = (e: ElementLike) => react.act(async () => e.dispatchEvent(new (dom().MouseEvent)("click", { bubbles: true })));

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  react = fromWeb("react") as ReactApi;
  createRoot = (fromWeb("react-dom/client") as ClientApi).createRoot;
  View = (require("../web/features/collab/product/product-view.tsx") as { ProductView: unknown }).ProductView;
});
afterEach(async () => { for (const clean of roots.splice(0)) await clean(); dom().localStorage.clear(); });
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

async function render(board: ProductBoard = projectMapBoard(now)) {
  const host = dom().document.createElement("div"), tasks: string[] = [];
  dom().document.body.appendChild(host);
  const root = createRoot(host as never);
  const show = async (b: ProductBoard) => react.act(async () => root.render(react.createElement(View as never,
    { board: b, narrow: false, now, tr, onFeature: () => {}, onTask: (id: string) => tasks.push(id) } as never)));
  await show(board);
  roots.push(async () => { await react.act(async () => root.unmount()); host.remove(); });
  return { host, tasks, show };
}
const lock = 'lock:f-team>f-private', task = 'dep:f-private>f-team';
const hit = (host: ElementLike, id: string) => one(host, `[data-pd-hit="${id}"]`);

test("three styles match the fixture; split excluded; every edge has an HTML label, arrow and 14px hit path", async () => {
  const { host } = await render();
  for (const [state, count] of [["satisfied", 2], ["waiting", 3], ["lock", 2]] as const) {
    expect(all(host, `[data-pd-edge-state=${state}]`)).toHaveLength(count);
  }
  expect(all(host, "[data-pd-edge]")).toHaveLength(7);
  expect(all(host, "button[data-pd-label]")).toHaveLength(7);
  expect(all(host, "[data-pd-hit]").every(e => e.getAttribute("stroke-width") === "14")).toBe(true);
  expect(all(host, "[data-pd-edge]").every(e => e.getAttribute("marker-end")?.startsWith("url("))).toBe(true);
  expect(one(host, `[data-pd-edge="${lock}"]`).getAttribute("data-pd-back")).toBe("true");
  expect(one(host, `[data-pd-edge="${lock}"]`).getAttribute("d")).toContain(" C ");
  expect(one(host, `[data-pd-label="${task}"]`).textContent).toBe("3 条任务依赖");
  expect(one(host, `[data-pd-label="${lock}"]`).textContent).toBe("6 处等文件锁");
  expect(one(host, "[data-pd-legend]").textContent).toBe("已成立在等等文件锁");
});

test("lock hit opens six complete evidence rows; holder navigates; Escape closes and clears selection", async () => {
  const { host, tasks } = await render();
  await activate(hit(host, lock));
  const side = one(host, "[data-pd-side]");
  const rows = all(side, "[data-pd-lock-evidence]");
  expect(rows).toHaveLength(6);
  rows.forEach((r, i) => {
    expect(r.textContent).toContain(`pc-${i + 3} 想改 src/x/part-${i}.ts`);
    expect(r.textContent).toContain(`被 tp-${5 + (i % 3)} 的 src/x/** 占着`);
    expect(r.textContent).toContain(`${i + 1} 小时前 起`);
    expect(all(r, "button")).toHaveLength(1);
  });
  expect(hit(host, lock).getAttribute("aria-pressed")).toBe("true");
  await activate(one(rows[0], "button"));
  expect(tasks).toEqual(["tp-5"]);
  await react.act(async () => dom().window.dispatchEvent(new (dom().KeyboardEvent)("keydown", { key: "Escape" })));
  expect(all(host, "[data-pd-side]")).toHaveLength(0);
  expect(hit(host, lock).getAttribute("aria-pressed")).toBe("false");
});

test("task label opens three rows with waiting first and stageWord wording; both card numbers navigate", async () => {
  const board = projectMapBoard(now);
  board.links![0].evidence.reverse();
  const { host, tasks } = await render(board);
  await activate(one(host, `[data-pd-label="${task}"]`));
  const rows = all(host, "[data-pd-task-evidence]");
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toBe("pc-1 开发 → tp-1 规格 · 在等");
  expect(rows.slice(1).every(r => r.getAttribute("data-pd-satisfied") === "true")).toBe(true);
  for (const b of all(rows[0], "button")) await activate(b);
  expect(tasks).toEqual(["pc-1", "tp-1"]);
  await activate(one(one(host, "[data-pd-side]"), 'button[aria-label="关闭"]'));
  expect(all(host, "[data-pd-side]")).toHaveLength(0);
});

test("merged declared+task keeps unmet priority, combined label, full note and keyboard activation", async () => {
  const board = projectMapBoard(now), note = "这是超过十八个字的手写依赖原文，需要完整保留\n第二行条件";
  board.deps.push({ from: "f-private", to: "f-team", kind: "declared", note, satisfied: false });
  board.links![0].satisfied = true;
  const { host } = await render(board);
  expect(all(host, "[data-pd-edge]")).toHaveLength(7);
  expect(one(host, `[data-pd-label="${task}"]`).textContent).toBe("手写 + 3 条任务依赖");
  expect(one(host, `[data-pd-edge="${task}"]`).getAttribute("data-pd-edge-state")).toBe("waiting");
  await react.act(async () => hit(host, task).dispatchEvent(new (dom().KeyboardEvent)("keydown", { key: "Enter", bubbles: true })));
  expect(one(host, "[data-pd-declared]").textContent).toBe(note);
  expect(all(host, "[data-pd-task-evidence]")).toHaveLength(3);
});

test("lock evidence cap shows remaining count; repo resource stays literal; disappeared edge closes page", async () => {
  const board = projectMapBoard(now), link = board.links!.find(l => l.kind === "lock")!;
  link.count = 26;
  link.evidence = [{ node: "pc-3", wanted: "repo:private", held: "repo:private", holder: "tp-5", since: now - 60_000 }];
  const { host, show } = await render(board);
  await activate(hit(host, lock));
  expect(one(host, "[data-pd-side]").textContent).toContain("另有 25 处");
  expect(one(host, "[data-pd-lock-evidence]").textContent).toContain("repo:private");
  await show({ ...board, links: board.links!.filter(l => l !== link) });
  expect(all(host, "[data-pd-side]")).toHaveLength(0);
});

test("no edges means no legend; declared blank note uses fallback", async () => {
  const board = projectMapBoard(now);
  const { host, show } = await render({ ...board, deps: [], links: [] });
  expect(all(host, "[data-pd-legend]")).toHaveLength(0);
  await show({ ...board, deps: [{ from: "f-private", to: "f-team", note: "" }], links: [] });
  expect(one(host, "[data-pd-label]").textContent).toBe("手写依赖");
  const note = "一二三四五六七八九十一二三四五六七八九十完整依赖原文";
  await show({ ...board, deps: [{ from: "f-private", to: "f-team", note }], links: [] });
  expect(one(host, "[data-pd-label]").textContent).toBe([...note].slice(0, 18).join("") + "…");
  await activate(hit(host, task));
  expect(one(host, "[data-pd-declared]").textContent).toBe(note);
});
