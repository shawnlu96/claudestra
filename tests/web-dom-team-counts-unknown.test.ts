/**
 * team-parity-Bc1：counts.activeUnknown 的显示前置。同一套真 React DOM（happy-dom）在桌面 1200 / 手机 390、中 / 英下挂：
 *   - DAG Counts 的两个调用方（桌面 Shelf 小片、手机 MobileDag 节头）：标记 true 时 active / idle 出「暂无 / Unknown」，done 照旧；
 *   - 产品 DAG FeatureBody（手机列表 + 桌面画布）：本 feature 标了就不出「N 进行中」，total / completed / blocked 照原值；
 * 对照组是同形状的完整已知计数（含真 0），文字逐字不变。旧红新绿：main 上标记 true 仍显示占位 0 / 「0 进行中」。
 * 不出网：组件纯 props 驱动，没有 fetch；happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FeatureCard, FeatureCounts } from "../web/features/collab/dag/dag-types";
import type { ProductBoard, ProductFeature } from "../web/lib/api/product-board-types";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; querySelectorAll(s: string): ArrayLike<El>; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }
type Lang = "zh" | "en";

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let setLang: (l: Lang) => void;
let ui: { Shelf: unknown; MobileDag: unknown; ProductView: unknown; useCollabT: () => (s: string) => string };

const NOW = Date.now();
const card = (id: string, counts: FeatureCounts): FeatureCard =>
  ({ id, title: `Feature ${id}`, status: "active", ownerWords: "", currentVersion: 1, version: null, pending: null, counts, lastActivityAt: NOW, nodes: [] });
/** 已知：active 0 是真 0、idle 非 0；未知：同样的占位数字但标了 activeUnknown */
const KNOWN = card("known", { total: 5, done: 2, active: 0, idle: 3, missing: 0 });
const BUSY = card("busy", { total: 4, done: 1, active: 2, idle: 1, missing: 0 });
const UNKNOWN = card("unknown", { total: 5, done: 2, active: 0, idle: 0, missing: 0, activeUnknown: true });

const pf = (id: string, counts: ProductFeature["counts"]): ProductFeature =>
  ({ id, title: `Product ${id}`, status: "active", hasDag: true, version: 1, counts, eta: null });
const BOARD: ProductBoard = {
  features: [pf("pknown", { total: 6, completed: 2, active: 0, blocked: 1 }), pf("pbusy", { total: 3, completed: 1, active: 2, blocked: 0 }),
    pf("punknown", { total: 7, completed: 3, active: 0, blocked: 2, activeUnknown: true })],
  deps: [],
};

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const canvas = await import(mod("collab/dag/dag-canvas.tsx"));
  const mobile = await import(mod("collab/dag/dag-mobile.tsx"));
  const product = await import(mod("collab/product/product-view.tsx"));
  const i18n = await import(mod("collab/collab-i18n.ts"));
  ({ setLang } = await import(new URL("../web/lib/i18n.tsx", import.meta.url).href));
  ui = { Shelf: canvas.Shelf, MobileDag: mobile.MobileDag, ProductView: product.ProductView, useCollabT: i18n.useCollabT };
});

afterAll(async () => {
  setLang("zh");
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const noop = () => {};
async function mount(width: number, lang: Lang, el: (h: (...a: unknown[]) => unknown) => unknown): Promise<El> {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  await React.act(async () => setLang(lang));
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(el(React.createElement as never) as never));
  return Object.assign(host, { unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } });
}
const texts = (host: El, sel: string) => Array.from(host.querySelectorAll(sel), (e) => (e.textContent ?? "").trim());
const unmount = (host: El) => (host as El & { unmount(): Promise<void> }).unmount();

/** 每个 feature 一枚按钮：[标题, done, active, idle] */
const counts = (host: El) => Array.from(host.querySelectorAll("button"), (b) => texts(b, "span"));
const UNKNOWN_WORD: Record<Lang, string> = { zh: "暂无", en: "Unknown" };

for (const lang of ["zh", "en"] as const) {
  test(`DAG Counts · desktop Shelf · ${lang}`, async () => {
    const host = await mount(1200, lang, (h) => h(ui.Shelf, { shelf: [KNOWN, BUSY, UNKNOWN], evicted: null, onFeature: noop }));
    expect(counts(host)).toEqual([
      ["Feature known", "2", "0", "3"],
      ["Feature busy", "1", "2", "1"],
      ["Feature unknown", "2", UNKNOWN_WORD[lang], UNKNOWN_WORD[lang]],
    ]);
    await unmount(host);
  });

  test(`DAG Counts · mobile MobileDag header · ${lang}`, async () => {
    const h0 = React.createElement as unknown as (...a: unknown[]) => unknown;
    const Wrap = () => h0(ui.MobileDag, { features: [KNOWN, BUSY, UNKNOWN], open: [], doneOpen: new Set(), look: noop, onFeature: noop, onFold: noop,
      onVersions: noop, onNode: noop, onOwner: noop, tr: ui.useCollabT() });
    const host = await mount(390, lang, (h) => h(Wrap));
    // 节头按钮（aria-expanded）里：[标题, done, active, idle]；版本按钮不算
    const heads = Array.from(host.querySelectorAll("button[aria-expanded]"), (b) => texts(b, "span"));
    expect(heads).toEqual([
      ["Feature known", "2", "0", "3"],
      ["Feature busy", "1", "2", "1"],
      ["Feature unknown", "2", UNKNOWN_WORD[lang], UNKNOWN_WORD[lang]],
    ]);
    await unmount(host);
  });

  for (const [width, narrow] of [[390, true], [1200, false]] as const) {
    test(`Product FeatureBody · ${narrow ? "mobile" : "desktop"} ${width} · ${lang}`, async () => {
      const h0 = React.createElement as unknown as (...a: unknown[]) => unknown;
      const Wrap = () => h0(ui.ProductView, { board: BOARD, narrow, now: NOW, onFeature: noop, tr: ui.useCollabT() });
      const host = await mount(width, lang, (h) => h(Wrap));
      const active = lang === "zh" ? "进行中" : "Active", blocked = lang === "zh" ? "受阻" : "Blocked";
      const byTitle = new Map(Array.from(host.querySelectorAll("button"), (b) => [texts(b, "strong")[0], b.textContent ?? ""] as const));
      // 已知：真 0 与非 0 都原样；未知：没有任何「N 进行中」，total / completed / blocked 照原值
      expect(byTitle.get("Product pknown")).toContain(`2 / 6`);
      expect(byTitle.get("Product pknown")).toContain(`0 ${active}`);
      expect(byTitle.get("Product pknown")).toContain(`1 ${blocked}`);
      expect(byTitle.get("Product pbusy")).toContain(`2 ${active}`);
      const unknown = byTitle.get("Product punknown") ?? "";
      expect(unknown).toContain(`3 / 7`);
      expect(unknown).toContain(`2 ${blocked}`);
      expect(unknown).not.toContain(active);
      await unmount(host);
    });
  }
}
