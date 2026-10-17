/**
 * UXNUM1 真 React DOM（happy-dom）：同一份 useCountState + CountContext 挂总览数格、产品卡、子 DAG 小片（Counts）、谁在干活四处
 * （PROJTABS1 起顶栏指标条和左大纲已删，总览数格接替它们：合并队列 / 审查中按计数源出，没载完是骨架）。
 * [验收线 2] 团队列表有 feature 没拿到详情时各处的状态词只有骨架、没有数字；全部到齐后数字一次出现、之后补拉不跳回骨架；20 秒（这里注入 lateMs）仍缺时出数字和提示。
 * CNTGATE1：本轮试过没拉到（last().failed：读失败 / 429 停发）的 feature 不再豁免，和排队（waiting）的一样要等到齐或 20 秒兜底。
 * [验收线 3] 总览没有「暂无」「—」「周额度」「协作消息」：额度只在今天页（QUOTA1），项目页不出。
 * [验收线 4] 谁在干活每个数只出现一次（摘要行不报数；栏标题的数带 wideOnly、手机藏；分段控件桌面藏）；子 DAG 小片有文字标签。
 * 不出网：fetch 一律拒绝并记账。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { homeView, type LedgerOverview } from "../web/features/collab/collab-model";
import { countBoardOf, type CountBoard, type CountState } from "../web/features/collab/count-words";
import type { DagBoard } from "../web/features/collab/dag/dag-types";
import { teamWorkBoard } from "../web/features/collab/team-work-model";
import type { ProductBoard } from "../web/lib/api/product-board-types";
import { FEATURES, LATE, NOW, synthTeam } from "./web-collab-count-words-fixture.test";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El { textContent: string | null; getAttribute(n: string): string | null; className: string; querySelector(s: string): El | null;
  querySelectorAll(s: string): ArrayLike<El>; appendChild(c: El): void; remove(): void }
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
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
  const [src, props, product, canvas, work] = await Promise.all([
    import(new URL("../web/features/collab/use-count-source.ts", import.meta.url).href),
    import(new URL("../web/features/collab/project-tabs/overview-tab.tsx", import.meta.url).href),
    import(new URL("../web/features/collab/product/product-view.tsx", import.meta.url).href),
    import(new URL("../web/features/collab/dag/dag-canvas.tsx", import.meta.url).href),
    import(new URL("../web/features/collab/work/work-board-content.tsx", import.meta.url).href),
  ]);
  mods = { src, props, product, canvas, work };
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

/** 一轮团队数据：have = 已拉到详情的 feature；failed / waiting = 团队源 last() 的本轮没拉到 / 还在排队（TEAMCNT1） */
function round(have: readonly string[], more: { failed?: readonly string[]; waiting?: readonly string[] } = {}) {
  const { ov, dag } = synthTeam(have);
  const team = teamWorkBoard(dag, ov, NOW);
  const last = { list: { features: FEATURES.map((id) => ({ id })) }, details: new Map(have.map((id) => [id, {}])),
    failed: new Set(more.failed ?? []), waiting: new Set(more.waiting ?? []) };
  return { ov, dag, team, board: countBoardOf(team, true), source: { last: () => last } };
}
const product = (dag: DagBoard): ProductBoard => ({ deps: [], features: dag.features.map((f) => ({ id: f.id, title: f.title, status: "active", hasDag: true, version: 1,
  counts: { total: f.counts.total, completed: f.counts.done, active: 0, blocked: 0 }, eta: null })) });

/** 四处一起挂：总览、产品卡、子 DAG 收起小片、谁在干活 */
function Page(p: { r: ReturnType<typeof round>; lateMs?: number; onState?: (s: CountState) => void }) {
  const { useCountState, CountContext } = mods.src as { useCountState: (a: unknown) => CountState; CountContext: { Provider: unknown } };
  const counts = useCountState({ project: "team", ov: p.r.ov, board: p.r.board as CountBoard, boardPending: false, source: p.r.source, lateMs: p.lateMs });
  p.onState?.(counts);
  const ov = p.r.ov as LedgerOverview, view = homeView(ov, NOW);
  return h(CountContext.Provider, { value: counts },
    h("section", { "data-place": "now" }, h(mods.props!.Overview, { project: "team", ov, view, waits: [], projectName: "团队", onPick: noop, counts, tr })),
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
/** 各处「数」所在的元素（总览只看按计数源出的合并队列 / 审查中两格；产品卡只看两个状态词，进度条「完成 / 总数」不变、不在此列） */
const NUM_SEL = { now: "[data-cell=merge], [data-cell=review]", product: "[data-product-words]", frame: "[data-feature-words]", work: "h3, [role=tablist]" } as const;
const numbers = (host: El, place: keyof typeof NUM_SEL) => text(host, `[data-place=${place}] :is(${NUM_SEL[place]})`).match(/\d+/g) ?? [];
/** 子 DAG 小片按 feature 各写「在干活 / 在等 / 没开工」：三项各自加起来 = 全站的三个状态词 */
const frameSum = (host: El) => numbers(host, "frame").map(Number).reduce((acc, n, i) => { acc[i % 3] = (acc[i % 3] ?? 0) + n; return acc; }, [] as number[]);
const HINT = (k: number) => `另有 ${k} 个模块还没读到，数字不含它们`;
const skeletons = (host: El, place: keyof typeof NUM_SEL) => host.querySelectorAll(`[data-place=${place}] [aria-hidden]:empty`).length;

test("[验收线 2] 3 个 feature 详情没到：各处只有骨架；到齐后一次出同一组数；之后补拉不再退回骨架", async () => {
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
  // 总览：合并队列 + 审查中两格出数（阶段列，count-words.ts），且不超过在干活 + 在等
  expect(words("now").length).toBe(2);
  expect(words("now").reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(14);
  const sum = (place: "product" | "frame", every: number) => words(place).reduce((acc, n, i) => { acc[i % every] = (acc[i % every] ?? 0) + n; return acc; }, [] as number[]);
  expect(sum("product", 2)).toEqual([8, 6]);
  expect(sum("frame", 3)).toEqual([8, 6, 12]);
  // 谁在干活：栏标题四个 + 分段四个（桌面 / 手机各显示一组），在等合并 + 在等 = 6
  expect(words("work")).toEqual([8, 4, 2, 12, 8, 4, 2, 12]);
  for (const place of Object.keys(NUM_SEL) as (keyof typeof NUM_SEL)[]) expect({ place, skeleton: skeletons(m.host, place) }).toEqual({ place, skeleton: 0 });
  // 补拉：列表里冒出一个还没读到的 feature（或一轮 429）——不退回骨架
  await m.render(h(Page, { r: { ...full, source: { last: () => ({ list: { features: [...FEATURES, "F13"].map((id) => ({ id })) }, details: new Map(FEATURES.map((id) => [id, {}])) }) } },
    onState: (s: CountState) => states.push(s.status) }));
  expect(frameSum(m.host)).toEqual([8, 6, 12]);
  expect(states.indexOf("ready")).toBeGreaterThan(0);
  expect(states.slice(states.indexOf("ready"))).not.toContain("loading");
  await m.unmount();
  expect(requests).toEqual([]);
});

test("[验收线 2] 20 秒（注入 lateMs）仍缺 feature：照常出数，总览数格下面一句提示", async () => {
  const partial = round(FEATURES.slice(0, 9));
  const m = await mount(h(Page, { r: partial, lateMs: 30 }));
  expect(numbers(m.host, "now")).toEqual([]);
  await React.act(async () => { await sleep(60); });
  expect(numbers(m.host, "now").length).toBe(2);
  expect(text(m.host, "[data-place=now] [data-count-hint]")).toBe(HINT(LATE.length));
  await m.unmount();
});

test("[验收线 3] 总览没有「暂无」「—」「周额度」「协作消息」：团队未知的今天完成整格不出，额度只在今天页", async () => {
  const full = round(FEATURES);
  const m = await mount(h(Page, { r: full }));
  const now = text(m.host, "[data-place=now]");
  expect(now).not.toMatch(/暂无|—|周额度|协作消息/);
  expect(m.host.querySelector("[data-metrics], [data-metric]")).toBeNull();
  const unknownToday = (full.ov as LedgerOverview).unknownMetrics?.includes("todayDone") ?? false;
  expect(m.host.querySelector("[data-place=now] [data-cell=todayDone]") === null).toBe(unknownToday);
  await m.unmount();
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

test("[验收线 3] 没载完时总览两格是骨架；小片完成数、待做分组数、机器数仍是骨架；载完一起出", async () => {
  const partial = round(FEATURES.slice(0, 9)), full = round(FEATURES);
  const twoMachines = (r: ReturnType<typeof round>) => ({ ...r, team: { ...r.team, machines: { local: 5, peer: 3 } } });
  const m = await mount(h(Page, { r: twoMachines(partial) }));
  expect(skeletons(m.host, "now")).toBe(2);
  // 子 DAG 小片：去掉标题（Feature F01）后不剩数字
  const chips = () => Array.from(m.host.querySelectorAll("[data-place=frame] button"), (b) => (b.textContent ?? "").replace(b.getAttribute("title") ?? "", ""));
  expect(chips().join("|")).not.toMatch(/\d/);
  expect(text(m.host, "[data-place=work]")).not.toMatch(/(可以开工|受阻) · \d|(本机|peer) \d/);
  await m.render(h(Page, { r: twoMachines(full) }));
  expect(skeletons(m.host, "now")).toBe(0);
  expect(chips().every((c) => /^\d+在干活/.test(c))).toBe(true);
  expect(text(m.host, "[data-place=work]")).toMatch(/可以开工 · \d+/);
  expect(text(m.host, "[data-place=work]")).toMatch(/peer 3/);
  await m.unmount();
});

test("[验收线 2] 按轮重拉的快照：rev 变后旧快照不算这一轮，新结果到了才算（团队首次出数要总览与快照同一轮）", async () => {
  const { useRoundFresh } = mods.src as { useRoundFresh: (v: object, settled: boolean, rev: number) => boolean };
  const seen: boolean[] = [];
  const Probe = (p: { v: object; settled: boolean; rev: number }) => { seen.push(useRoundFresh(p.v, p.settled, p.rev)); return null; };
  const loading = { status: "loading" }, a = { status: "ok" }, b = { status: "ok" };
  const m = await mount(h(Probe, { v: loading, settled: false, rev: 0 }));
  const last = () => seen[seen.length - 1];
  expect(last()).toBe(false);
  await m.render(h(Probe, { v: a, settled: true, rev: 1 }));
  expect(last()).toBe(true);
  // 详情补齐、rev 变了，快照还在途：调用方留着旧对象
  await m.render(h(Probe, { v: a, settled: true, rev: 2 }));
  expect(last()).toBe(false);
  await m.render(h(Probe, { v: b, settled: true, rev: 2 }));
  expect(last()).toBe(true);
  await m.unmount();
});

test("[验收线 2] 看板读失败（老 bridge 没有 /work）：不等 20 秒，状态词整格不出、已知指标照常出；之后读到了再出数", async () => {
  const { useCountState } = mods.src as { useCountState: (a: unknown) => CountState };
  const full = round(FEATURES);
  const seen: string[] = [];
  const Probe = (p: { board: CountBoard | null; failed: boolean }) => {
    seen.push(useCountState({ project: "local", ov: full.ov, board: p.board, boardPending: false, boardFailed: p.failed, source: {} }).status);
    return null;
  };
  const m = await mount(h(Probe, { board: null, failed: false }));
  expect(seen[seen.length - 1]).toBe("loading");
  await m.render(h(Probe, { board: null, failed: true }));
  expect(seen[seen.length - 1]).toBe("none");
  await m.render(h(Probe, { board: full.board, failed: false }));
  expect(seen[seen.length - 1]).toBe("ready");
  await m.unmount();
});

test("[验收线 1] 本轮 1 个 feature 详情吃到 429（last().failed）：不再提前放行，等到 20 秒兜底（注入 lateMs）才出暂计数并提示「另有 1 个」", async () => {
  const states: string[] = [];
  const r = round(FEATURES.slice(0, 11), { failed: FEATURES.slice(11) });
  const m = await mount(h(Page, { r, lateMs: 40, onState: (s: CountState) => states.push(s.status) }));
  expect(states[states.length - 1]).toBe("loading");
  expect(numbers(m.host, "now")).toEqual([]);
  expect(skeletons(m.host, "now")).toBe(2);
  await React.act(async () => { await sleep(80); });
  expect(states[states.length - 1]).toBe("ready");
  expect(numbers(m.host, "now").length).toBe(2);
  expect(text(m.host, "[data-place=now] [data-count-hint]")).toBe(HINT(1));
  for (const place of Object.keys(NUM_SEL) as (keyof typeof NUM_SEL)[]) expect({ place, skeleton: skeletons(m.host, place) }).toEqual({ place, skeleton: 0 });
  // 之后补拉到了：只换数字、提示消失，不闪回骨架
  await m.render(h(Page, { r: round(FEATURES), lateMs: 40, onState: (s: CountState) => states.push(s.status) }));
  expect(frameSum(m.host)).toEqual([8, 6, 12]);
  expect(m.host.querySelector("[data-count-hint]")).toBeNull();
  expect(states.slice(states.indexOf("ready"))).not.toContain("loading");
  await m.unmount();
});

test("[验收线 2] 还在排队（waiting，没发过请求）或还没试过的 feature 不提前放行；20 秒兜底（注入 lateMs）仍生效", async () => {
  // 列表里的 F12 在排队、读失败（failed）、两者都有、或还没试过：都照旧要等（CNTGATE1 failed 不豁免）
  for (const more of [{ waiting: ["F12"] }, { waiting: ["F12"], failed: ["F12"] }, { failed: ["F12"] }, {}]) {
    const states: string[] = [];
    const r = round(FEATURES.slice(0, 11), more);
    const m = await mount(h(Page, { r, lateMs: 40, onState: (s: CountState) => states.push(s.status) }));
    expect({ more, status: states[states.length - 1] }).toEqual({ more, status: "loading" });
    expect(numbers(m.host, "now")).toEqual([]);
    await React.act(async () => { await sleep(80); });
    expect({ more, status: states[states.length - 1] }).toEqual({ more, status: "ready" });
    expect(text(m.host, "[data-count-hint]")).toBe(HINT(1));
    await m.unmount();
  }
});

test("[验收线 5] 本机项目视图（没有 last()）放行照旧：总览 + 看板到了就出数，failed 概念不参与", async () => {
  const { useCountState } = mods.src as { useCountState: (a: unknown) => CountState };
  const full = round(FEATURES);
  const seen: string[] = [];
  const Probe = (p: { pending: boolean }) => {
    seen.push(useCountState({ project: "local", ov: full.ov, board: full.board, boardPending: p.pending, source: {} }).status);
    return null;
  };
  const m = await mount(h(Probe, { pending: true }));
  expect(seen[seen.length - 1]).toBe("loading");
  await m.render(h(Probe, { pending: false }));
  expect(seen[seen.length - 1]).toBe("ready");
  await m.unmount();
});

/**
 * CNTGATE1 假时钟 + 模拟团队源：设备核验那次冷开的三轮（2 秒缺一批、16 秒还缺、31 秒补齐），每轮没拉到的都在 last().failed 里（429 停发）。
 * 夹具 12 个 feature：2 秒缺 3 个、16 秒缺 1 个，比例对应核验时的缺 30 / 缺 11。20 秒前（LATE_MS 原值）各处只有骨架。
 */
afterEach(() => jest.useRealTimers());
const at = (have: readonly string[]) => round(have, { failed: FEATURES.filter((f) => !have.includes(f)) });
/** 总览两格、产品卡、子 DAG 小片都还没有数 */
function noNumbersYet(host: El) {
  for (const place of ["now", "product", "frame"] as const) expect({ place, numbers: numbers(host, place) }).toEqual({ place, numbers: [] });
}
const advance = (ms: number) => React.act(async () => { jest.advanceTimersByTime(ms); });

test("CNTGATE1 [验收线 1] 2 秒缺 3、16 秒缺 1、31 秒补齐：20 秒前处处骨架；20 秒出暂计数带提示；31 秒提示消失、数字更新", async () => {
  jest.useFakeTimers();
  const states: string[] = [];
  const onState = (s: CountState) => states.push(s.status);
  const m = await mount(h(Page, { r: at([]), onState }));
  await advance(2_000);
  await m.render(h(Page, { r: at(FEATURES.slice(0, 9)), onState }));
  expect(states[states.length - 1]).toBe("loading");
  noNumbersYet(m.host);
  await advance(14_000);
  await m.render(h(Page, { r: at(FEATURES.slice(0, 11)), onState }));
  expect(states[states.length - 1]).toBe("loading");
  noNumbersYet(m.host);
  await advance(3_999);
  expect(states[states.length - 1]).toBe("loading");
  noNumbersYet(m.host);
  await advance(1);
  expect(states[states.length - 1]).toBe("ready");
  expect(text(m.host, "[data-place=now] [data-count-hint]")).toBe(HINT(1));
  expect(numbers(m.host, "now").length).toBe(2);
  expect(frameSum(m.host).length).toBe(3);
  await advance(11_000);
  await m.render(h(Page, { r: at(FEATURES), onState }));
  expect(m.host.querySelector("[data-count-hint]")).toBeNull();
  expect(text(m.host, "[data-place=now]")).not.toContain("还没读到");
  expect(frameSum(m.host)).toEqual([8, 6, 12]);
  expect(states.slice(states.indexOf("ready"))).not.toContain("loading");
  await m.unmount();
});

test("CNTGATE1 [验收线 2] 20 秒内全部拿到详情：只出现一次完整数字；之后补拉、过了 20 秒都不回骨架、不换数", async () => {
  jest.useFakeTimers();
  const tops: string[] = [];
  const states: string[] = [];
  const Probe = (p: { r: ReturnType<typeof round> }) => h(Page, { r: p.r, onState: (s: CountState) => states.push(s.status) });
  const m = await mount(h(Probe, { r: at([]) }));
  const seen = () => { const n = frameSum(m.host).join(","); if (n && tops[tops.length - 1] !== n) tops.push(n); };
  for (const [ms, have] of [[2_000, FEATURES.slice(0, 9)], [10_000, FEATURES.slice(0, 11)], [3_000, FEATURES]] as const) {
    await advance(ms);
    await m.render(h(Probe, { r: at(have) }));
    seen();
  }
  expect(tops).toEqual(["8,6,12"]);
  expect(m.host.querySelector("[data-count-hint]")).toBeNull();
  // 补拉：列表冒出一个还没读到的 feature，且它在 failed 里——不退回骨架
  const more = round(FEATURES);
  await m.render(h(Probe, { r: { ...more, source: { last: () => ({ list: { features: [...FEATURES, "F13"].map((id) => ({ id })) }, details: new Map(FEATURES.map((id) => [id, {}])),
    failed: new Set(["F13"]), waiting: new Set() }) } } }));
  await advance(10_000);
  seen();
  expect(tops).toEqual(["8,6,12"]);
  expect(states.filter((s, i) => s === "ready" && states[i - 1] !== "ready").length).toBe(1);
  expect(states.slice(states.indexOf("ready"))).not.toContain("loading");
  for (const place of Object.keys(NUM_SEL) as (keyof typeof NUM_SEL)[]) expect({ place, skeleton: skeletons(m.host, place) }).toEqual({ place, skeleton: 0 });
  await m.unmount();
});
