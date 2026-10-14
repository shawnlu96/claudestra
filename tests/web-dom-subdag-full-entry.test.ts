/**
 * team-project-SUBDAG7 P1 rest-entry-keeps-old-page：聚焦图点「其余 N 已完成」进完整画布，已完成每次都开到第 1 页，
 * 不沿用上次翻到的页数；「更远 N」进入则已完成收起。真挂 useDagUi + useFocusPane 到 happy-dom（React 19），写法同 web-dom-subdag-focus-jump。
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
  view: string; doneOpen: ReadonlySet<string>; donePages: ReadonlyMap<string, number>;
  selectFeature: (id: string) => void; setView: (v: "list" | "graph" | "full") => void;
  enterFull: (id: string, withDone: boolean) => void; moreDone: (id: string) => void; toggleDone: (id: string) => void;
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

/** F1：两个已完成、一个进行中，聚焦图画得出 */
const dag = board([feature("F1", [node("d1", "done"), node("d2", "done"), node("a1", "active", ["d1"])])]);

async function mount() {
  const doc = (globalThis as unknown as { document: Doc }).document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const box: { ui: Ui | null } = { ui: null };
  function Probe() {
    const ui = useDagUi(dag.features);
    box.ui = ui;
    useFocusPane({ now: 5000, hot: null, tr: (s: string) => s, narrow: false, ui, board: dag, hasProduct: true, work: { kind: "local", board: null },
      onNode() {}, onVersions() {}, onOwner() {} });
    return null;
  }
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(Probe) as never));
  const act = (fn: (ui: Ui) => void) => React.act(async () => fn(box.ui!));
  return { ui: () => box.ui!, act, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test("「其余」进完整画布 → 翻页 → 回聚焦图 → 再点「其余」：页数回到 1", async () => {
  const m = await mount();
  await m.act((ui) => ui.selectFeature("F1"));
  await m.act((ui) => ui.setView("graph"));
  await m.act((ui) => ui.enterFull("F1", true));
  expect(m.ui().view).toBe("full");
  expect(m.ui().donePages.get("F1")).toBe(1);
  await m.act((ui) => ui.moreDone("F1"));
  await m.act((ui) => ui.moreDone("F1"));
  expect(m.ui().donePages.get("F1")).toBe(3);
  await m.act((ui) => ui.setView("graph"));
  await m.act((ui) => ui.enterFull("F1", true));
  expect(m.ui().view).toBe("full");
  expect(m.ui().donePages.get("F1")).toBe(1);
  expect([...m.ui().doneOpen]).toEqual(["F1"]);
  await m.unmount();
});

test("「更远」进完整画布：已完成收起、页数删掉；之后点开 ✓N 从第 1 页起", async () => {
  const m = await mount();
  await m.act((ui) => ui.selectFeature("F1"));
  await m.act((ui) => ui.setView("graph"));
  await m.act((ui) => ui.enterFull("F1", true));
  await m.act((ui) => ui.moreDone("F1"));
  await m.act((ui) => ui.setView("graph"));
  await m.act((ui) => ui.enterFull("F1", false));
  expect(m.ui().view).toBe("full");
  expect(m.ui().donePages.has("F1")).toBe(false);
  expect([...m.ui().doneOpen]).toEqual([]);
  await m.act((ui) => ui.toggleDone("F1"));
  expect(m.ui().donePages.get("F1")).toBe(1);
  await m.unmount();
});
