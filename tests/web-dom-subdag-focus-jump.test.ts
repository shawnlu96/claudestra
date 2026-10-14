/**
 * team-project-SUBDAG4 P1 mobile-jump-listable：从「谁在干活」跳回子 DAG 时，只有桌面真在渲染分区列表才走列表跳法（不动 open / compare，只闪）；
 * 手机（narrow）仍是 MobileDag，必须照画布的跳法展开目标 feature、点开 ✓N。真挂 useDagUi + useFocusPane 到 happy-dom（React 19）。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { board, feature, node } from "./web-collab-dag-fixture";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
interface Ui {
  featureId: string | null; open: string[]; doneOpen: ReadonlySet<string>; flash: { id: string; seq: number } | null;
  selectFeature: (id: string) => void; jumpNode: (f: string, key: string) => void; view: string; setView: (v: "list" | "graph") => void;
}
type Hook = (a: Record<string, unknown>) => (canvas: unknown) => unknown;
interface El { remove(): void }
interface Doc { createElement(tag: string): El; body: { appendChild(c: El): void } }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let useDagUi: (f: unknown) => Ui;
let useFocusPane: Hook;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ useDagUi } = await import(mod("collab/dag/use-dag-ui.ts")));
  ({ useFocusPane } = await import(mod("collab/dag/use-focus-pane.tsx")));
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

/** F1：一个已完成、一个进行中；F2：一个进行中。两个都有快照 */
const dag = board([
  feature("F1", [node("d1", "done"), node("a1", "active", ["d1"])]),
  feature("F2", [node("b1", "active")]),
]);

async function mount(narrow: boolean) {
  const doc = (globalThis as unknown as { document: Doc }).document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const box: { ui: Ui | null } = { ui: null };
  function Probe() {
    const ui = useDagUi(dag.features);
    box.ui = ui;
    useFocusPane({ now: 5000, hot: null, tr: (s: string) => s, narrow, ui, board: dag, hasProduct: true, work: { kind: "local", board: null },
      onNode() {}, onVersions() {}, onOwner() {} });
    return null;
  }
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(Probe) as never));
  const act = (fn: (ui: Ui) => void) => React.act(async () => fn(box.ui!));
  return { ui: () => box.ui!, act, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test("手机：跨 feature 跳到已完成节点 = 展开目标 feature、点开 ✓N（MobileDag 的跳法）", async () => {
  const m = await mount(true);
  await m.act((ui) => ui.selectFeature("F2"));
  await m.act((ui) => ui.jumpNode("F1", "d1"));
  expect(m.ui().featureId).toBe("F1");
  expect(m.ui().open).toEqual(["F1"]);
  expect([...m.ui().doneOpen]).toEqual(["F1"]);
  expect(m.ui().flash?.id).toBe("F1::d1");
  await m.unmount();
});

test("手机：同 feature 的已完成目标同样点开 ✓N", async () => {
  const m = await mount(true);
  await m.act((ui) => ui.selectFeature("F1"));
  await m.act((ui) => ui.jumpNode("F1", "d1"));
  expect(m.ui().open).toEqual(["F1"]);
  expect([...m.ui().doneOpen]).toEqual(["F1"]);
  await m.unmount();
});

test("桌面列表：只切 feature 并闪，不改 open / ✓N（列表自己展开已完成区）", async () => {
  const m = await mount(false);
  await m.act((ui) => ui.selectFeature("F2"));
  await m.act((ui) => ui.jumpNode("F1", "d1"));
  expect(m.ui().featureId).toBe("F1");
  expect(m.ui().open).toEqual(["F2"]);
  expect([...m.ui().doneOpen]).toEqual([]);
  expect(m.ui().flash?.id).toBe("F1::d1");
  await m.unmount();
});

test("桌面列表跨 feature 跳转后切到「图」：目标 feature 被展开，画布不只剩 shelf（P1 graph-after-cross-feature-list-jump）", async () => {
  const m = await mount(false);
  await m.act((ui) => ui.selectFeature("F2"));
  await m.act((ui) => ui.jumpNode("F1", "a1"));
  expect(m.ui().open).toEqual(["F2"]);
  await m.act((ui) => ui.setView("graph"));
  expect(m.ui().view).toBe("graph");
  expect(m.ui().featureId).toBe("F1");
  expect(m.ui().open).toContain("F1");
  await m.act((ui) => ui.setView("list"));
  await m.act((ui) => ui.setView("graph"));
  expect(m.ui().open.filter((id) => id === "F1")).toHaveLength(1);
  await m.unmount();
});
