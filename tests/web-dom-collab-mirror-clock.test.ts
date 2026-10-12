/**
 * team-project-N8F2：团队规划面板的时效文案跟 use-collab 的走表时钟走，与卡片同钟（N8F r1 审查 P2 planning-clock · freshness）。
 * TeamSource + CollabView 真挂到 happy-dom（React 19），fetch 拦到 generateTeamFixture 的夹具，observedAt 固定。
 * 旧红新绿：11 分钟时首次读取，面板「主场 11 分钟前同步」；时钟推进到 90 分钟、serverSeq 不变、走一次真实 5 秒轮询、走表重渲染后，
 * main 上面板仍是「11 分钟前」（取的是上次读取总览时的 ov.now），卡片已是「1 小时前」；修完两边逐字相同。
 * 走表：拦下 use-collab 的 30 秒 setInterval，推进 Date.now 后手动触发一次（就是它到点会做的事）。
 * 新鲜窗口：9 分钟不标过期、11 分钟标过期（mirrorLine 阈值不动）。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";
import type { FeatureDetail } from "../web/lib/api/shared-ledger";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }
interface Identity { center: string; team: string; person: string; project: string; machine: string }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let ui: {
  CollabView: (p: { project: string }) => unknown;
  ChatStoreProvider: (p: { children: unknown }) => unknown;
  TeamSource: (p: { identity: Identity; children: unknown }) => unknown;
  sharedCollabProject: (i: Identity) => string;
};
let openCollabTask: (task: string | null) => void;

const MIN = 60_000;
const fx = generateTeamFixture({ features: 1, nodes: 4 });
const IDENTITY: Identity = { center: "center", team: fx.team, person: "person-a", project: fx.project, machine: "local" };
/** observedAt 固定；页面时钟 = OBSERVED + ago（Date.now 由本文件控制） */
const OBSERVED = Date.now() - 24 * 60 * MIN;
let ago = 0;
const realNow = Date.now, realFetch = globalThis.fetch, realSetInterval = globalThis.setInterval;
/** use-collab 的走表（TICK_MS = 30 秒）：拦下回调，测试里手动到点 */
const ticks = new Set<() => void>();
let listReads = 0;

const detail = (): FeatureDetail => {
  const d = structuredClone(fx.details[0]!);
  d.feature.projection = { ...d.feature.projection!, observedAt: OBSERVED, receivedAt: OBSERVED };
  return d;
};

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Date.now = () => OBSERVED + ago;
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 30_000) { ticks.add(fn); const id = realSetInterval(() => {}, 1 << 30); return id; }
    return realSetInterval(fn, ms, ...rest);
  }) as typeof setInterval;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const d = detail();
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...fx.local });
    // serverSeq 恒定：轮询不触发重读
    if (url.pathname === "/api/v1/shared-ledger/features") { listReads++; return json({ ...fx.list, features: [d.feature] }); }
    if (url.pathname === `/api/v1/shared-ledger/features/${d.feature.id}`) return json(d);
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const nav = await import(mod("collab/dag/shared-navigation.tsx"));
  ({ openCollabTask } = await import(mod("collab/collab-nav.ts")));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: nav.sharedCollabProject };
});

afterAll(async () => {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const wait = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string, rounds = 150) {
  for (let i = 0; i < rounds; i++) { if (ok()) return; await wait(); }
  throw new Error(`timeout waiting for ${what}`);
}

const MIRROR = /主场 \d+ (?:分钟|小时)前同步|主场镜像最新/g;
/** 团队规划面板里那一行的时效文案 */
function panel(host: El): string[] {
  const all = Array.from(host.querySelectorAll("*"));
  const sec = all.find((e) => { const t = e.textContent ?? ""; return t.startsWith("团队规划") && t !== "团队规划" && t.includes(fx.list.features[0]!.title); });
  return (sec?.textContent ?? "").match(MIRROR) ?? [];
}

async function mount(at: number) {
  ago = at;
  ticks.clear();
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width: 1200, height: 900 });
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null,
    h(ui.TeamSource, { identity: IDENTITY }, h(ui.CollabView, { project: ui.sharedCollabProject(IDENTITY) }))) as never));
  await until(() => (host.textContent ?? "").includes(fx.list.features[0]!.title), "team view");
  const tab = Array.from(host.querySelectorAll("button,[role=tab]")).find((x) => (x.textContent ?? "").trim().startsWith("团队"));
  if (!tab) throw new Error("no 团队 tab");
  await React.act(async () => tab.click());
  await until(() => panel(host).length > 0, "planning panel");
  return { host, unmount: async () => { await React.act(async () => { openCollabTask(null); root.unmount(); }); host.remove(); } };
}

test("验收 1：11 分钟时读取 →「11 分钟前」；推进到 90 分钟、serverSeq 不变、真实轮询并重渲染 → 面板「1 小时前」与卡片逐字相同", async () => {
  const v = await mount(11 * MIN);
  expect(panel(v.host)).toEqual(["主场 11 分钟前同步"]);
  ago = 90 * MIN;
  const before = listReads;
  await until(() => listReads > before, "a real 5s poll", 400); // POLL_MS = 5 秒
  await wait(50);
  expect(ticks.size).toBeGreaterThan(0);
  await React.act(async () => { for (const t of ticks) t(); });
  await wait(50);
  const planning = panel(v.host);
  expect(planning).toEqual(["主场 1 小时前同步"]);
  // 同一 feature 的卡片：打开详情，「现在」一节的原因行（teamNote，按 use-collab 的 now）
  await React.act(async () => openCollabTask(fx.details[0]!.tasks[0]!.sourceTaskId));
  await until(() => (v.host.textContent ?? "").includes("现在"), "card detail");
  const card = (v.host.textContent ?? "").match(MIRROR) ?? [];
  expect(card.length).toBeGreaterThan(0);
  expect([...new Set(card)]).toEqual(planning);
  await v.unmount();
}, 20_000);

test("验收 2：新鲜窗口不变 —— 9 分钟「主场镜像最新」，11 分钟标过期", async () => {
  const fresh = await mount(9 * MIN);
  expect(panel(fresh.host)).toEqual(["主场镜像最新"]);
  await fresh.unmount();
  const stale = await mount(11 * MIN);
  expect(panel(stale.host)).toEqual(["主场 11 分钟前同步"]);
  await stale.unmount();
});
