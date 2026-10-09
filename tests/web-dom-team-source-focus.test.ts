/**
 * team-project-N8A8 r1 P1 open-selection-unwired：在 happy-dom 里挂真实的团队 CollabView，fetch 全部拦下。
 * 走生产路径：产品卡点击 → use-dag-ui featureId → useFocusFeature → 共享源 focus。
 * 首轮让被点的 feature 回 429（本轮停发，它和排在后面的都没详情）；点开后要立刻重拉一轮（不等台账变化、也不等 5 秒轮询），
 * 并且第一个详情请求就是它。
 * 旧红：main 上 focus 没有接线，点开不触发任何详情请求。
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { generateTeamFixture } from "../web/features/collab/shared/team-fixture-gen";

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

const fx = generateTeamFixture({ features: 6, now: Date.now() });
const IDENTITY: Identity = { center: "center", team: fx.team, person: "person-a", project: fx.project, machine: "local" };
const DETAIL = "/api/v1/shared-ledger/features/";
/** 被点的 feature：列表里排在中间，首轮回 429 */
const TARGET = fx.list.features[2]!;
let limited = true;
const details: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const byId = new Map(fx.details.map((d) => [d.feature.id, d]));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = decodeURIComponent(url.pathname);
    const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === "/api/v1/shared-ledger/features") return json(fx.list);
    if (path.startsWith(DETAIL)) {
      const id = path.slice(DETAIL.length);
      details.push(id);
      // 中心限流经 bridge 透传：429 + Retry-After，正文带 retryAfter（秒）
      if (id === TARGET.id && limited) return json({ error: "rate limited", retryAfter: 1 }, 429, { "retry-after": "1" });
      const d = byId.get(id);
      return d ? json(d) : json({ error: "not found" }, 404);
    }
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const nav = await import(mod("collab/dag/shared-navigation.tsx"));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: nav.sharedCollabProject };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}

test("N8A8 r1：点开首轮 429 没拿到详情的 feature → 立刻重拉，第一个详情请求就是它，5 秒内有详情", async () => {
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width: 1200, height: 900 });
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null,
    h(ui.TeamSource, { identity: IDENTITY }, h(ui.CollabView, { project: ui.sharedCollabProject(IDENTITY) }))) as never));
  const card = () => Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(TARGET.title)) ?? null;
  await until(() => card() !== null && details.includes(TARGET.id), "product board + first-round 429");
  await tick(200);
  // 首轮：TARGET 回 429 后本轮停发 → 详情请求不超过 TARGET 及之前的 + 已在途的 1 个
  const firstRound = details.length;
  expect(firstRound).toBeLessThanOrEqual(fx.list.features.indexOf(TARGET) + 2);
  limited = false;
  await tick(1_100); // Retry-After 1 秒过去；5 秒轮询还没到
  expect(details.length).toBe(firstRound);
  const t0 = Date.now();
  await React.act(async () => card()!.click());
  await until(() => details.length > firstRound, "detail read after opening the feature");
  expect(details[firstRound]).toBe(TARGET.id);
  // 子 DAG 里出现这个 feature 的在跑 / 计划节点（夹具节点键 i28-C*；没详情时只有中心 counts，没有节点）
  await until(() => /i28-C\d/.test(host.textContent ?? ""), "opened feature sub-DAG nodes");
  expect(Date.now() - t0).toBeLessThan(5_000);
  await React.act(async () => root.unmount());
  host.remove();
});
