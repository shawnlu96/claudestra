/**
 * team-project-UXSIDE1：芯片图例与会话行的 DOM（真 React + happy-dom）：
 *   - ChipLegend：点 ⓘ 展开、再点 / Esc 收起；逐行是真实芯片，芯片 aria-label 与旁边那句话同出 chip-words.ts；
 *   - AgentRow：行 title 是完整名字（显示名 | 原名）；阶段 / 上下文 / 工作中芯片的 title = aria-label = 词表那句话。
 * 不出网：AgentRow 挂载时会探 /peers/contacts 和 /app-config.json，fetch 在本文件换成一律 404、afterAll 还原；happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ctxChipWords, rowStateWords, stageChipWords, stageWords } from "../web/features/chat/chip-words";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null;
  querySelector(s: string): El | null;
  querySelectorAll(s: string): Iterable<El> & { length: number };
  getAttribute(n: string): string | null;
  remove(): void;
  click(): void;
  lastElementChild: El | null;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let ui: { ChatStoreProvider: unknown; AgentRow: unknown; ChipLegend: unknown };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const cs = require("../web/features/chat/chat-store.ts");
  const row = require("../web/features/chat/components/agent-row.tsx");
  const legend = require("../web/features/chat/components/chip-legend.tsx");
  ui = { ChatStoreProvider: cs.ChatStoreProvider, AgentRow: row.AgentRow, ChipLegend: legend.ChipLegend };
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

type H = (...a: unknown[]) => unknown;
async function mount(el: (h: H) => unknown): Promise<El & { unmount(): Promise<void> }> {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(el(React.createElement as never) as never));
  return Object.assign(host, { unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } });
}
const act = (f: () => void) => React.act(async () => f());

test("图例：点开逐行真实芯片 + 同一句话，再点收起，Esc 也收起", async () => {
  const host = await mount((h) => h(ui.ChipLegend));
  const btn = host.querySelector("button[aria-controls=cstra-chip-legend]")!;
  const card = host.querySelector("#cstra-chip-legend")!;
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(card.getAttribute("data-open")).toBeNull();
  await act(() => btn.click());
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  expect(card.getAttribute("data-open")).toBe("true");
  const rows = [...card.querySelectorAll("[data-legend-row]")];
  expect(rows.length).toBe(11);
  const words = rows.map((r) => r.lastElementChild?.textContent);
  expect(words).toContain(ctxChipWords({ policy: "coordinator", window: 200_000, hardCap: 250_000, remaining: 77_000, level: "ok" }, "zh"));
  expect(words).toContain(stageWords("live", "zh"));
  expect(words).toContain(rowStateWords("busy", "zh"));
  expect(words).toContain(rowStateWords("compacting", "zh"));
  for (const r of rows) expect(r.querySelector("[data-chip],[data-ledger-stage]")).not.toBeNull();
  await act(() => btn.click());
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  await act(() => btn.click());
  const w = globalThis as unknown as { dispatchEvent(e: unknown): void; KeyboardEvent: new (t: string, o: { key: string }) => unknown };
  await act(() => w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" })));
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  await host.unmount();
});

const noop = () => {};
const ctx = { policy: "executor", window: 200_000, hardCap: 250_000, remaining: 64_000, level: "ok" } as const;
const row = (a: Record<string, unknown>) => (h: H) =>
  h(ui.ChatStoreProvider, null, h(ui.AgentRow, { a, active: false, busyLive: false, pinned: false, onTogglePin: noop, onSelect: noop }));

test("会话行：行 title 是完整名字，芯片 title = aria-label = 词表那句话", async () => {
  const task = { id: "T7", stage: "live", round: 0 };
  const a = { name: "runner", displayName: "claudestra-sidebar-polish-runner", label: "侧栏打磨", purpose: "", cwd: "", status: "active",
    busy: true, ledgerTask: task, ctxBoundary: ctx };
  const host = await mount(row(a));
  expect(host.querySelector("button[title]")?.getAttribute("title")).toBe("侧栏打磨 | claudestra-sidebar-polish-runner");
  const want = { ctx: ctxChipWords(ctx, "zh"), stage: stageChipWords(task, "zh"), busy: rowStateWords("busy", "zh") };
  for (const [sel, w] of [["[data-chip=ctx]", want.ctx], ["[data-ledger-stage]", want.stage], ["[data-chip=busy]", want.busy]] as const) {
    const el = host.querySelector(sel)!;
    expect(el.getAttribute("title")).toBe(w);
    expect(el.getAttribute("aria-label")).toBe(w);
  }
  await host.unmount();
});
