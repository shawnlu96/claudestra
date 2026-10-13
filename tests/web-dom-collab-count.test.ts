/**
 * UXNUM1 真 React DOM（happy-dom）：同一份 useCountState + CountContext 挂顶栏、大纲芯片、右栏概览、产品卡、子 DAG 小片（Counts）、谁在干活六处。
 * [验收线 2] 团队列表有 feature 没拿到详情时六处只有骨架、没有数字；全部到齐后数字一次出现、之后补拉不跳回骨架；20 秒（这里注入 lateMs）仍缺时出数字和提示。
 * [验收线 3] 团队顶栏没有「暂无」「—」；额度有数时出「周额度 Claude 75%」，null（403 / 404 / 全空）时整格不出；没有「协作消息」。
 * [验收线 4] 谁在干活每个数只出现一次（摘要行不报数；栏标题的数带 wideOnly、手机藏；分段控件桌面藏）；子 DAG 小片有文字标签。
 * 不出网：fetch 一律拒绝并记账。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { homeView, type LedgerOverview } from "../web/features/collab/collab-model";
import { countBoardOf, type CountBoard, type CountState } from "../web/features/collab/count-words";
import type { DagBoard } from "../web/features/collab/dag/dag-types";
import { teamWorkBoard } from "../web/features/collab/team-work-model";
import { metricsOf } from "../web/features/collab/v4/v4-model";
import type { ProductBoard } from "../web/lib/api/product-board-types";
import { FEATURES, LATE, NOW, synthTeam } from "./web-collab-count-words-fixture.test";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El { textContent: string | null; getAttribute(n: string): string | null; className: string; querySelector(s: string): El | null;
  querySelectorAll(s: string): ArrayLike<El>; appendChild(c: El): void; remove(): void }
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const ui = (p: string) => import(new URL(`../web/features/collab/${p}`, import.meta.url).href);
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let mods: Record<string, Record<string, unknown>>;
const realFetch = globalThis.fetch;
const requests: string[] = [];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => { requests.push(String(input)); throw new Error("network forbidden"); },
    { preconnect: () => {} });
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  const [src, bar, outline, props, product, canvas, work] = await Promise.all([ui("use-count-source.ts"), ui("metrics-bar.tsx"), ui("v4/v4-outline.tsx"),
    ui("v4/v4-props.tsx"), ui("product/product-view.tsx"), ui("dag/dag-canvas.tsx"), ui("work/work-board-content.tsx")]);
  mods = { src, bar, outline, props, product, canvas, work };
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const h = (...a: unknown[]) => (React.createElement as (...x: unknown[]) => unknown)(...a);
const doc = () => (globalThis as unknown as { document: { createElement(t: string): El; body: El } }).document;
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));
const noop = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一轮团队数据：have = 已拉到详情的 feature */
function round(have: readonly string[]) {
  const { ov, dag } = synthTeam(have);
  const team = teamWorkBoard(dag, ov, NOW);
  const last = { list: { features: FEATURES.map((id) => ({ id })) }, details: new Map(have.map((id) => [id, {}])) };
  return { ov, dag, team, board: countBoardOf(team, true), source: { last: () => last } };
}
const product = (dag: DagBoard): ProductBoard => ({ deps: [], features: dag.features.map((f) => ({ id: f.id, title: f.title, status: "active", hasDag: true, version: 1,
  counts: { total: f.counts.total, completed: f.counts.done, active: 0, blocked: 0 }, eta: null })) });

/** 六处一起挂：顶栏、大纲、右栏概览、产品卡、子 DAG 收起小片、谁在干活 */
function Page(p: { r: ReturnType<typeof round>; lateMs?: number; quota?: { family: string; pct: number }[] | null; onState?: (s: CountState) => void }) {
  const { useCountState, CountContext } = mods.src as { useCountState: (a: unknown) => CountState; CountContext: { Provider: unknown } };
  const counts = useCountState({ project: "team", ov: p.r.ov, board: p.r.board as CountBoard, boardPending: false, source: p.r.source, lateMs: p.lateMs });
  p.onState?.(counts);
  const ov = p.r.ov as LedgerOverview, view = homeView(ov, NOW);
  return h(CountContext.Provider, { value: counts },
    h("section", { "data-place": "top" }, h(mods.bar!.MetricsBar, { m: metricsOf(ov, view.todayDone.length, null), counts, waitUnknown: true, quota: p.quota ?? null, connected: true, tr })),
    h("section", { "data-place": "chips" }, h(mods.outline!.Outline, { project: "team", ov, lines: new Map(), filter: "active", onFilter: noop, waits: [], onWaits: noop,
      selected: null, onPick: noop, counts, tr })),
    h("section", { "data-place": "now" }, h(mods.props!.Overview, { ov, view, waits: [], projectName: "团队", onPick: noop, counts, tr })),
    h("section", { "data-place": "product" }, h(mods.product!.ProductView, { board: product(p.r.dag), narrow: true, now: NOW, onFeature: noop, tr })),
    h("section", { "data-place": "frame" }, h(mods.canvas!.Shelf, { shelf: p.r.dag.features, evicted: null, onFeature: noop })),
    h("section", { "data-place": "work" }, h(mods.work!.WorkBoardContent, { team: true, board: p.r.team, retrying: false, loading: counts.status === "loading",
      tr, onNode: noop, onTask: noop })));
}

async function mount(el: unknown) {
  const host = doc().createElement("div");
  doc().body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(el as never));
  return { host, render: (e: unknown) => React.act(async () => root.render(e as never)), unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const text = (host: El, sel: string) => Array.from(host.querySelectorAll(sel), (e) => e.textContent ?? "").join("\n");
/** 六处里「数」所在的元素（产品卡只看两个状态词，进度条「完成 / 总数」不变、不在此列） */
const NUM_SEL = { top: "[data-metrics]", chips: "[role=tablist]", now: "[data-now], [data-stage-counts]", product: "[data-product-words]",
  frame: "[data-feature-words]", work: "h3, [role=tablist]" } as const;
/** 「P0」芯片名里的 0 不是数 */
const numbers = (host: El, place: keyof typeof NUM_SEL) => text(host, `[data-place=${place}] :is(${NUM_SEL[place]})`).replace(/P0/g, "").match(/\d+/g) ?? [];
const skeletons = (host: El, place: keyof typeof NUM_SEL) => host.querySelectorAll(`[data-place=${place}] [aria-hidden]:empty`).length;

test("[验收线 2] 3 个 feature 详情没到：六处只有骨架；到齐后一次出同一组数；之后补拉不再退回骨架", async () => {
  const states: string[] = [];
  const partial = round(FEATURES.slice(0, 9)), full = round(FEATURES);
  const m = await mount(h(Page, { r: partial, onState: (s: CountState) => states.push(s.status) }));
  for (const place of Object.keys(NUM_SEL) as (keyof typeof NUM_SEL)[]) {
    expect({ place, numbers: numbers(m.host, place) }).toEqual({ place, numbers: [] });
    expect({ place, skeleton: skeletons(m.host, place) > 0 }).toEqual({ place, skeleton: true });
  }
  expect(text(m.host, "[data-place]")).not.toContain("加载中");
  await m.render(h(Page, { r: full, onState: (s: CountState) => states.push(s.status) }));
  const words = (place: keyof typeof NUM_SEL) => numbers(m.host, place).map(Number);
  // 顶栏：在干活 8 · 在等 6 · 没开工 12（团队的今日完成等未知指标整格不出）
  expect(words("top")).toEqual([8, 6, 12]);
  // 芯片：进行中 14 · 已完成 20 · 全部 64 · P0 0
  expect(words("chips")).toEqual([14, 20, 64, 0]);
  expect(text(m.host, "[data-place=now] [data-now]")).toMatch(/^在干活 8 · 在等 6( · 其中 \d+ 条出问题)?$/);
  // 各阶段各列之和 = 在干活 + 在等
  expect(text(m.host, "[data-place=now] [data-stage-counts]").match(/\d+/g)!.map(Number).reduce((a, b) => a + b, 0)).toBe(14);
  const sum = (place: "product" | "frame", every: number) => words(place).reduce((acc, n, i) => { acc[i % every] = (acc[i % every] ?? 0) + n; return acc; }, [] as number[]);
  expect(sum("product", 2)).toEqual([8, 6]);
  expect(sum("frame", 3)).toEqual([8, 6, 12]);
  // 谁在干活：栏标题四个 + 分段四个（桌面 / 手机各显示一组），在等合并 + 在等 = 6
  expect(words("work")).toEqual([8, 4, 2, 12, 8, 4, 2, 12]);
  for (const place of Object.keys(NUM_SEL) as (keyof typeof NUM_SEL)[]) expect({ place, skeleton: skeletons(m.host, place) }).toEqual({ place, skeleton: 0 });
  // 补拉：列表里冒出一个还没读到的 feature（或一轮 429）——不退回骨架
  await m.render(h(Page, { r: { ...full, source: { last: () => ({ list: { features: [...FEATURES, "F13"].map((id) => ({ id })) }, details: new Map(FEATURES.map((id) => [id, {}])) }) } },
    onState: (s: CountState) => states.push(s.status) }));
  expect(words("top")).toEqual([8, 6, 12]);
  expect(states.indexOf("ready")).toBeGreaterThan(0);
  expect(states.slice(states.indexOf("ready"))).not.toContain("loading");
  await m.unmount();
  expect(requests).toEqual([]);
});

test("[验收线 2] 20 秒（注入 lateMs）仍缺 feature：照常出数，顶栏末尾提示图标 + 右栏「现在」下面同一句", async () => {
  const partial = round(FEATURES.slice(0, 9));
  const m = await mount(h(Page, { r: partial, lateMs: 30 }));
  expect(numbers(m.host, "top")).toEqual([]);
  await React.act(async () => { await sleep(60); });
  const hint = `另有 ${LATE.length} 个 feature 还没读到，数字不含它们`;
  expect(numbers(m.host, "top").length).toBe(3);
  expect(m.host.querySelector("[data-metrics] [role=img]")?.getAttribute("title")).toBe(hint);
  expect(text(m.host, "[data-place=now]")).toContain(hint);
  await m.unmount();
});

test("[验收线 3] 团队顶栏没有「暂无」「—」「协作消息」；额度有数两边都写「周额度 Claude 75%」，null 整格不出", async () => {
  const full = round(FEATURES);
  const m = await mount(h(Page, { r: full, quota: [{ family: "Claude", pct: 75 }] }));
  const top = text(m.host, "[data-metrics]");
  expect(top).not.toMatch(/暂无|—|协作消息|进行中/);
  expect(text(m.host, "[data-metric=quota]")).toBe("Claude 75%周额度");
  await m.render(h(Page, { r: full, quota: null }));
  expect(m.host.querySelector("[data-metric=quota]")).toBeNull();
  expect(text(m.host, "[data-metrics]")).not.toContain("周额度");
  await m.unmount();
  // 本机：已知指标照旧出，没人在等审查是「—」
  const { metricCells } = mods.bar as { metricCells: (...a: unknown[]) => { key: string; value: string | null }[] };
  const local = metricCells({ present: 3, todayDone: 1, reviewRounds: 2, fixed: 0, avgReviewWaitMs: null }, { status: "loading" }, false, [{ family: "Claude", pct: 75 }], tr);
  expect(local.map((c) => [c.key, c.value])).toEqual([["working", null], ["waiting", null], ["notStarted", null], ["todayDone", "1"], ["present", "3"],
    ["reviewRounds", "2"], ["fixed", "0"], ["reviewWait", "—"], ["quota", "Claude 75%"]]);
});

test("[验收线 4] 谁在干活每个数只出现一次：摘要行不报数，栏标题的数手机藏、分段控件桌面藏；子 DAG 小片写字", async () => {
  const full = round(FEATURES);
  const m = await mount(h(Page, { r: full }));
  const summary = m.host.querySelector("[data-place=work] [data-work-board] > div");
  expect((summary?.textContent ?? "").match(/\d/)).toBeNull();
  // 栏标题的数都带 wideOnly（data-wide-only 标记它）；CSS 模块在根测试进程里没有类名，样式规则直接读源文件
  const heads = Array.from(m.host.querySelectorAll("[data-place=work] h3 > span:last-child"));
  expect(heads.map((e) => e.getAttribute("data-wide-only"))).toEqual(["true", "true", "true", "true"]);
  const css = readFileSync(new URL("../web/features/collab/v4/v4.module.css", import.meta.url), "utf8");
  expect(css).toMatch(/@media \(max-width: 700px\) \{ \.wideOnly \{ display: none; \} \}/);
  const workCss = readFileSync(new URL("../web/features/collab/work/work-board.module.css", import.meta.url), "utf8");
  expect(workCss).toMatch(/\.segment \{ display: none; \}/);
  const frame = text(m.host, "[data-place=frame] [data-feature-words]").split("\n")[0]!;
  expect(frame).toMatch(/^在干活 \d+ · 在等 \d+ · 没开工 \d+$/);
  await m.unmount();
});
