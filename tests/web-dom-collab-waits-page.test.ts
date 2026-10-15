/**
 * followup-reliability-UXCARD3 [验收线 6]：「待你处理」页读不到（ownerWaits unknown）时写「读不到」加「重试」，不写「没有」；
 * 点重试重读待办列表（asksStore.refresh → GET /asks）和这台机器的团队绑定（GET /shared-ledger/context），不整页刷新。
 * 读到了、一条没有时照旧写「没有」。合成数据，fetch 全部拦在本文件、只回环；happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { LedgerOverview } from "../web/features/collab/collab-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let ui: { WaitsPage: unknown; ChatStoreProvider: unknown; sharedCollabProject: (i: Record<string, string>) => string };
const calls: string[] = [];
const realFetch = globalThis.fetch;
const OV = { exists: true, now: 1, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks: [], deps: [] } as unknown as LedgerOverview;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/asks") return json({ ok: true, asks: [], full: true, now: 1 });
    if (url.pathname === "/api/v1/shared-ledger/context") return json({ identities: [] });
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const props = await import(new URL("../web/features/collab/v4/v4-props.tsx", import.meta.url).href);
  const store = await import(new URL("../web/features/chat/chat-store.ts", import.meta.url).href);
  const key = await import(new URL("../web/features/collab/team-source-key.ts", import.meta.url).href);
  ui = { WaitsPage: props.WaitsPage, ChatStoreProvider: store.ChatStoreProvider, sharedCollabProject: key.sharedCollabProject };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));

async function render(unknown: boolean) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  const project = ui.sharedCollabProject({ center: "c1", team: "t1", person: "p1", project: "center-proj", machine: "local", homeInstanceId: "inst-a" });
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null,
    h(ui.WaitsPage, { waits: [], unknown, project, ov: OV, onPick: () => {}, onClose: () => {}, tr })) as never));
  return { host, text: () => host.textContent ?? "", unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test("[验收线 6] 读不到：写「读不到」和「重试」，没有「没有」；点重试发一次待办列表请求和一次团队绑定请求", async () => {
  const v = await render(true);
  expect(v.text()).toContain("读不到");
  expect(v.text()).not.toContain("没有");
  const retry = Array.from(v.host.querySelectorAll("button")).find((b) => b.textContent === "重试")!;
  expect(retry).toBeDefined();
  calls.length = 0;
  await React.act(async () => retry.click());
  await tick(80);
  expect(calls.filter((c) => c === "GET /api/v1/asks")).toHaveLength(1);
  expect(calls.filter((c) => c === "GET /api/v1/shared-ledger/context")).toHaveLength(1);
  await v.unmount();
});

test("[验收线 6] 读到了、一条没有：照旧写「没有」，没有「读不到」和重试", async () => {
  const v = await render(false);
  expect(v.text()).toContain("没有");
  expect(v.text()).not.toContain("读不到");
  expect(Array.from(v.host.querySelectorAll("button")).some((b) => b.textContent === "重试")).toBe(false);
  await v.unmount();
});
