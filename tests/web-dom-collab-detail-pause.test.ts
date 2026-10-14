import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { fillParams } from "../web/lib/i18n-fill";
import type { CardPauseView, PauseTarget } from "../web/lib/api/card-pause";
import type { Stage } from "../web/features/collab/collab-model";

type ReactAPI = typeof import("../web/node_modules/@types/react/index");
type RootAPI = typeof import("../web/node_modules/@types/react-dom/client");
interface El { textContent: string | null; disabled: boolean; title: string; click(): void; remove(): void; querySelector(s: string): El | null }
interface Doc { createElement(t: string): El; body: { appendChild(e: El): void } }
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
let react: ReactAPI, createRoot: RootAPI["createRoot"], doc: Doc;
let PauseCard: unknown, useCardPause: (t: PauseTarget | null, snapshot: object) => { view: CardPauseView | null; update(v: CardPauseView): void };
let DetailUsage: unknown;
const realFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
const initial: CardPauseView = { mode: "on", paused: false, actor: null, at: null, reason: null, stage: "fix", canPause: true, refusal: null };
let server = { ...initial }, fail = false, usageStatus = 200;
let usage: unknown = { ok: true, summary: { families: { claude: { totalTokens: 17_500_000 }, codex: { totalTokens: 14_000_000 } },
  totalTokens: 31_500_000, hasArchive: false, detailFrom: null, unavailableBefore: null,
  lent: { claude: { orders: 2, tokensReported: false } }, weekEstimate: { claude: { estimatePct: 3 } } } };
let promptValue: string | null = "owner 在卡片详情暂停";
let releaseUsage: (() => void) | null = null;
let releaseWrite: (() => void) | null = null;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  react = requireWeb("react");
  createRoot = requireWeb("react-dom/client").createRoot;
  doc = (globalThis as unknown as { document: Doc }).document;
  (globalThis as unknown as { window: { prompt: () => string | null } }).window.prompt = () => promptValue;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/pause") || path.endsWith("/resume")) {
      if (method === "POST") {
        if (releaseWrite) await new Promise<void>((r) => { releaseWrite = r; });
        if (fail) return Response.json({ error: "rejected" }, { status: 409 });
        const paused = path.endsWith("/pause");
        server = { ...server, paused, canPause: !paused, actor: paused ? "owner" : null, at: paused ? Date.now() : null,
          reason: paused ? (calls.at(-1)!.body as { reason: string }).reason : null };
        return Response.json({ ok: true, view: server });
      }
      return Response.json(server);
    }
    if (path.startsWith("/api/v1/usage/task/")) {
      if (releaseUsage) await new Promise<void>((r) => { releaseUsage = r; });
      return Response.json(usage, { status: usageStatus });
    }
    return Response.json({ error: "fixture only" }, { status: 404 });
  }) as typeof fetch;
  setAppConfigForTest({ mode: "direct", fp: "pause-dom", machineName: "fixture", version: "" });
  const p = await import(new URL("../web/features/collab/detail-pause.tsx", import.meta.url).href);
  PauseCard = p.PauseCard; useCardPause = p.useCardPause;
  DetailUsage = (await import(new URL("../web/features/collab/detail-usage.tsx", import.meta.url).href)).DetailUsage;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const h = (...args: unknown[]) => (react.createElement as (...a: unknown[]) => unknown)(...args);
const flush = () => react.act(() => new Promise<void>((r) => setTimeout(r, 20)));
async function mount(component: unknown, props: Record<string, unknown>) {
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const root = createRoot(host as never);
  const render = async (p: Record<string, unknown>) => { await react.act(async () => root.render(h(component, p) as never)); await flush(); };
  await render(props);
  return { host, render, close: async () => { await react.act(() => root.unmount()); host.remove(); } };
}
const snapshot = {};
function PauseHarness({ target = { project: "local-project", id: "CARD" }, stage = "fix", tick = snapshot }: {
  target?: PauseTarget | null; stage?: Stage; tick?: object;
}) {
  const pause = useCardPause(target, tick);
  return target ? h(PauseCard, { target, view: pause.view, stage, onChange: pause.update, tr: fillParams }) : null;
}
const writes = () => calls.filter((c) => c.method === "POST");
async function click(host: El) { await react.act(async () => host.querySelector("button")!.click()); await flush(); }

test("two-click pause, cancel/blank reason, one POST with changed reason, one-click resume", async () => {
  server = { ...initial }; calls.length = 0;
  const m = await mount(PauseHarness, {});
  try {
    await click(m.host);
    expect(m.host.textContent).toBe("确认暂停"); expect(writes()).toHaveLength(0);
    promptValue = null; await click(m.host); expect(writes()).toHaveLength(0);
    await click(m.host); promptValue = "  "; await click(m.host); expect(writes()).toHaveLength(0);
    await click(m.host); promptValue = "  先核规格  "; await click(m.host);
    expect(writes()).toEqual([{ method: "POST", path: "/api/v1/ledger/local-project/tasks/CARD/pause", body: { reason: "先核规格" } }]);
    expect(m.host.textContent).toBe("继续");
    await click(m.host); expect(writes()).toHaveLength(2);
    expect(writes()[1]!.path).toEndWith("/resume"); expect(m.host.textContent).toBe("暂停调度");
  } finally { await m.close(); }
});
test("expired confirmation starts a new five-second window; rejected mutation keeps confirmed state", async () => {
  server = { ...initial }; calls.length = 0; fail = true;
  const m = await mount(PauseHarness, {}), clock = Date.now;
  try {
    await click(m.host);
    Date.now = () => clock() + 6_000;
    await click(m.host); expect(writes()).toHaveLength(0);
    promptValue = "暂停重试"; await click(m.host);
    expect(writes()).toHaveLength(1); expect(m.host.textContent).toBe("暂停调度");
    server = { ...initial, paused: true, canPause: false };
    await m.render({ tick: {} }); await click(m.host);
    expect(m.host.textContent).toBe("继续");
  } finally { Date.now = clock; fail = false; await m.close(); }
});
test("in-flight pause rejects extra clicks and only records one mutation", async () => {
  server = { ...initial }; calls.length = 0; releaseWrite = () => {};
  const m = await mount(PauseHarness, {});
  try {
    await click(m.host); await click(m.host); await click(m.host);
    expect(writes()).toHaveLength(1); expect(m.host.querySelector("button")!.disabled).toBe(true);
    releaseWrite!(); releaseWrite = null; await flush();
    expect(m.host.textContent).toBe("继续");
  } finally { releaseWrite = null; await m.close(); }
});
test("mode/stage gates, refusal title, away target does not read status", async () => {
  server = { ...initial }; calls.length = 0;
  const m = await mount(PauseHarness, { target: null });
  try {
    expect(calls).toHaveLength(0);
    for (const mode of ["off", "observe"] as const) {
      server = { ...initial, mode }; await m.render({ tick: {} }); expect(m.host.querySelector("button")).toBeNull();
    }
    server = { ...initial }; await m.render({ stage: "merge", tick: {} }); expect(m.host.querySelector("button")).toBeNull();
    server = { ...initial, canPause: false, refusal: "合并请求在途" }; await m.render({ tick: {} });
    expect(m.host.querySelector("button")!.disabled).toBe(true);
    expect(m.host.querySelector("button")!.title).toBe("合并请求在途");
  } finally { await m.close(); }
});
test("usage fetches once per card; loading has no numbers, 403 hides, empty and away are explicit", async () => {
  calls.length = 0; releaseUsage = () => {};
  const props = { id: "CARD", awayMachine: null, tr: fillParams };
  const m = await mount(DetailUsage, props);
  try {
    expect(m.host.querySelector('[data-detail-usage="loading"]')).not.toBeNull();
    expect(m.host.textContent).toBe("已耗额度");
    releaseUsage!(); releaseUsage = null; await flush();
    expect(m.host.textContent).toContain("Claude 约 1,750 万 token · 约占本周额度 3%");
    expect(m.host.textContent).toContain("另有 2 单在其他成员机器上跑，用量对方没回传");
    await m.render({ ...props, tr: (s: string) => s });
    expect(calls.filter((c) => c.path.includes("/usage/task/"))).toHaveLength(1);
    usageStatus = 403; await m.render({ ...props, id: "DENIED" }); expect(m.host.textContent).toBe("");
    usageStatus = 200; usage = { ok: true, summary: { families: {}, lent: {}, weekEstimate: {}, hasArchive: false } };
    await m.render({ ...props, id: "EMPTY" }); expect(m.host.textContent).toContain("还没有用量记录");
    const count = calls.length;
    await m.render({ ...props, id: "AWAY", awayMachine: "alice-mac" });
    expect(calls).toHaveLength(count); expect(m.host.textContent).toContain("这张卡在 alice-mac 上执行，用量记在那台机器");
  } finally { usageStatus = 200; releaseUsage = null; await m.close(); }
});
