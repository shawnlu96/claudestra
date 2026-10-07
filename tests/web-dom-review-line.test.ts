/**
 * RVB1 返修：审查员在审 / 审完的卡（ledgerReview）不上侧栏行，放在协作视图「团队」的成员节点上。真 React DOM（happy-dom）挂：
 *   - AgentRow（侧栏行）：只带 ledgerReview → 行上没有任何审查小标 / 整句；执行者的 ledgerTask 小标照旧；
 *   - TeamGraphNode（协作视图成员节点）：在审 → 「在审 CLR1 · 第 3 轮」；审完 → 结论 + P 数；没被派审的节点不多这一行。
 * 不出网：AgentRow 挂载时会探 /peers/contacts（useFullScope）和 /app-config.json，fetch 在本文件换成一律 404、afterAll 还原；
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LedgerReviewRef } from "../web/lib/chat/agents";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; querySelector(s: string): El | null; getAttribute(n: string): string | null; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

const mod = (p: string) => new URL(`../web/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let setLang: (l: "zh" | "en") => void;
let ui: { ChatStoreProvider: unknown; AgentRow: unknown; TeamGraphNode: unknown };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const cs = await import(mod("features/chat/chat-store.ts"));
  const row = await import(mod("features/chat/components/agent-row.tsx"));
  const team = await import(mod("features/collab/team-graph-parts.tsx"));
  ({ setLang } = await import(mod("lib/i18n.tsx")));
  ui = { ChatStoreProvider: cs.ChatStoreProvider, AgentRow: row.AgentRow, TeamGraphNode: team.TeamGraphNode };
});

afterAll(async () => {
  setLang("zh");
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

const noop = () => {};
const rv = (verdict: LedgerReviewRef["verdict"], p = [0, 0, 0], round = 2): LedgerReviewRef => ({ id: "CLR1", round, verdict, p0: p[0], p1: p[1], p2: p[2] });
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, displayName: name, purpose: "", cwd: "", status: "active", projectId: "p", ...extra });
const row = (a: Record<string, unknown>) => (h: H) =>
  h(ui.ChatStoreProvider, null, h(ui.AgentRow, { a, active: false, busyLive: false, pinned: false, onTogglePin: noop, onSelect: noop }));
const node = (a: Record<string, unknown>) => (h: H) =>
  h(ui.TeamGraphNode, { node: { id: `local:${a.name}`, name: a.name, role: "审查员", agent: a }, quotas: [], selected: false, onSelect: noop, now: Date.now() });

test("侧栏行：只被派审的审查员没有审查小标；执行者小标照旧", async () => {
  const reviewer = await mount(row(agent("review-pi", { ledgerReview: rv("changes", [0, 1, 3]) })));
  expect(reviewer.querySelector("[data-ledger-review]")).toBeNull();
  expect(reviewer.querySelector("[data-ledger-stage]")).toBeNull();
  expect(reviewer.textContent).not.toContain("CLR1");
  await reviewer.unmount();
  const dual = await mount(row(agent("task-dual", { ledgerTask: { id: "E1", stage: "build", round: 0 }, ledgerReview: rv(null) })));
  expect(dual.querySelector("[data-ledger-stage]")?.getAttribute("data-ledger-stage")).toBe("build");
  expect(dual.textContent).not.toContain("在审");
  await dual.unmount();
});

test("协作视图成员节点：在审显示卡号 + 轮次，审完显示结论 + P 数；没被派审不多这一行", async () => {
  const reviewing = await mount(node(agent("review-pi", { ledgerReview: rv(null, [0, 0, 0], 3) })));
  expect(reviewing.querySelector("[data-team-review]")?.getAttribute("data-team-review")).toBe("reviewing");
  expect(reviewing.querySelector("[data-team-review]")?.textContent).toBe("在审 CLR1 · 第 3 轮");
  await reviewing.unmount();
  const done = await mount(node(agent("review-pi", { ledgerReview: rv("changes", [0, 1, 3]) })));
  expect(done.querySelector("[data-team-review]")?.textContent).toBe("审完 CLR1 · 第 2 轮 · 要改 · P0 0 / P1 1 / P2 3");
  await done.unmount();
  await React.act(async () => setLang("en"));
  const en = await mount(node(agent("review-pi", { ledgerReview: rv("pass", [0, 0, 1]) })));
  expect(en.querySelector("[data-team-review]")?.textContent).toBe("Reviewed CLR1 · round 2 · Passed · P0 0 / P1 0 / P2 1");
  await en.unmount();
  await React.act(async () => setLang("zh"));
  const plain = await mount(node(agent("task-x")));
  expect(plain.querySelector("[data-team-review]")).toBeNull();
  await plain.unmount();
});
