/** Real session/source failure → existing DAG and ProductPanes consumers; synthetic transport, no network. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";
import { sharedCollabSource } from "../web/features/collab/team-source-shared";
import { SharedLedgerSession } from "../web/lib/api/shared-ledger";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface ElementView {
  textContent: string | null;
  querySelectorAll(selector: string): ArrayLike<ElementView>;
  remove(): void;
}
interface DocumentView { createElement(tag: string): ElementView; body: { appendChild(child: ElementView): void } }
interface WindowView { happyDOM: { setViewport(view: { width: number; height: number }): void } }
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const importUI = (path: string) => import(new URL(`../web/features/collab/${path}`, import.meta.url).href);
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let documentView: DocumentView;
let setLang: (lang: "zh" | "en") => void;
let components: { Shelf: unknown; MobileDag: unknown; ProductPanes: unknown; useCollabT(): (text: string) => string };
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const requests: string[] = [];
const noop = () => {};

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = requireWeb("react") as ReactNS;
  ({ createRoot } = requireWeb("react-dom/client") as ReactDomClient);
  documentView = (globalThis as unknown as { document: DocumentView }).document;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input)); throw new Error("network forbidden in counts fixture");
  }, { preconnect: () => { throw new Error("preconnect forbidden in counts fixture"); } });
  console.warn = () => {}; // Expected synthetic detail errors; assertions cover user-visible behavior instead of console text.
  const [canvas, mobile, panes, words, language] = await Promise.all([
    importUI("dag/dag-canvas.tsx"), importUI("dag/dag-mobile.tsx"), importUI("product/product-panes.tsx"),
    importUI("collab-i18n.ts"), import(new URL("../web/lib/i18n.tsx", import.meta.url).href),
  ]);
  components = { Shelf: canvas.Shelf, MobileDag: mobile.MobileDag, ProductPanes: panes.ProductPanes, useCollabT: words.useCollabT };
  setLang = language.setLang;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  setLang("zh");
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

function fixture() {
  const fx = generateTeamFixture({ features: 5, nodes: 2 });
  const [failed, failedEmpty, zero, busy, empty] = fx.details;
  failed!.feature.title = "Failed long title 详情缺失与中心计数保留";
  failed!.feature.counts = { total: 9, completed: 3, blocked: 1, missing: 2 };
  failedEmpty!.feature.title = "Failed empty";
  failedEmpty!.feature.counts = { total: 0, completed: 0, blocked: 0, missing: 0 };
  zero!.feature.title = "Known zero";
  for (const task of zero!.tasks) task.stage = "done";
  zero!.feature.counts.completed = zero!.tasks.length;
  busy!.feature.title = "Known busy";
  empty!.feature.title = "Known empty";
  empty!.feature.counts = { total: 0, completed: 0, blocked: 0, missing: 0 };
  empty!.dag.nodes = []; empty!.dag.bindings = []; empty!.tasks = [];
  fx.list.features = fx.details.map(d => d.feature);
  return fx;
}
async function snapshot(absent = false) {
  const fx = fixture();
  if (absent) fx.list.features = [fx.details[0]!.feature];
  const identity = { center: "synthetic", team: fx.team, person: "fixture", project: fx.project, machine: "fixture" };
  const session = new SharedLedgerSession(identity, {
    list: async () => structuredClone(fx.list),
    detail: async id => {
      const detail = fx.details.find(d => d.feature.id === id)!;
      if (absent) session.close(); // Actual session epoch/abort path discards this detail and returns undefined.
      else if (fx.details.indexOf(detail) < 2) throw new Error("synthetic first detail failure");
      return structuredClone(detail);
    },
    command: async () => { throw new Error("writes forbidden"); },
    receipt: async requestId => ({ status: "unknown", requestId }),
  });
  const source = sharedCollabSource(session, "team", "fixture");
  await source.overview(new AbortController().signal);
  return { dag: await source.dag!.board("team"), product: await source.product!("team") };
}
const h = (...args: unknown[]) => (React.createElement as (...args: unknown[]) => unknown)(...args);
async function mounted(width: number, lang: "zh" | "en", node: unknown, check: (host: ElementView) => void) {
  (globalThis as unknown as { window: WindowView }).window.happyDOM.setViewport({ width, height: 900 });
  await React.act(async () => setLang(lang));
  const host = documentView.createElement("div");
  documentView.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await React.act(async () => root.render(node as never));
    check(host);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
const textList = (host: ElementView, selector: string) => Array.from(host.querySelectorAll(selector), e => e.textContent ?? "");

test("复现测试：真实 session 详情被丢弃无缓存时保留中心计数且标记未知", async () => {
  const { dag, product } = await snapshot(true);
  expect(dag.features[0]!.counts).toMatchObject({ total: 9, done: 3, missing: 2, activeUnknown: true });
  expect(product.features[0]!.counts).toMatchObject({ total: 9, completed: 3, blocked: 1, activeUnknown: true });
});

for (const lang of ["zh", "en"] as const) for (const width of [1200, 390]) {
  test(`复现测试：列表成功而首次详情失败的未知计数仍被渲染为零 · ${lang} ${width}`, async () => {
    const { dag, product } = await snapshot();
    const unknown = lang === "zh" ? "暂无" : "Unknown";
    const active = lang === "zh" ? "进行中" : "Active";
    const blocked = lang === "zh" ? "受阻" : "Blocked";
    const Dag = () => width === 1200
      ? h(components.Shelf, { shelf: dag.features, evicted: null, onFeature: noop })
      : h(components.MobileDag, { features: dag.features, open: [], doneOpen: new Set(), look: noop, onFeature: noop,
        onFold: noop, onVersions: noop, onNode: noop, onOwner: noop, tr: components.useCollabT() });
    await mounted(width, lang, h(Dag), host => {
      const selector = width === 1200 ? "button" : "button[aria-expanded]";
      const rows = Array.from(host.querySelectorAll(selector), button => textList(button, "span"));
      expect(rows[0]).toEqual([dag.features[0]!.title, "3", unknown, unknown]);
      expect(rows[1]).toEqual(["Failed empty", "0", unknown, unknown]);
      expect(rows[2]).toEqual(["Known zero", "2", "0", "0"]);
      expect(rows[3]).toEqual(["Known busy", "0", "2", "0"]);
      expect(rows[4]).toEqual(["Known empty", "0", "0", "0"]);
    });
    const Product = () => h(components.ProductPanes, { board: product, dagBoard: dag, featureId: null, tab: "product", setTab: noop,
      onFeature: noop, onTask: noop, subdag: null, fallback: null, progress: null, graph: true, narrow: width === 390,
      now: dag.now, tr: components.useCollabT() });
    await mounted(width, lang, h(Product), host => {
      const cards = new Map(Array.from(host.querySelectorAll("button"), button => [textList(button, "strong")[0], button.textContent ?? ""]));
      const failed = cards.get(dag.features[0]!.title)!;
      expect(failed).toContain("3 / 9"); expect(failed).toContain(`1 ${blocked}`); expect(failed).not.toContain(active);
      expect(cards.get("Failed empty")).toContain("0 / 0"); expect(cards.get("Failed empty")).not.toContain(active);
      expect(cards.get("Known zero")).toContain(`0 ${active}`);
      expect(cards.get("Known busy")).toContain(`2 ${active}`);
      expect(cards.get("Known empty")).toContain(`0 ${active}`);
    });
    for (const i of [0, 1]) {
      expect(dag.features[i]!.counts.activeUnknown).toBe(true); expect(product.features[i]!.counts.activeUnknown).toBe(true);
    }
    for (const i of [2, 3, 4]) {
      expect(dag.features[i]!.counts).not.toHaveProperty("activeUnknown"); expect(product.features[i]!.counts).not.toHaveProperty("activeUnknown");
    }
    expect(requests).toEqual([]);
  });
}
