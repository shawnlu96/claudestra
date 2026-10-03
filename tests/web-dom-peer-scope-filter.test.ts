/** Real React inputs: searching only changes candidate visibility, never scopes or external gates. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { scopeGateError } from "../src/lib/peer-scope-gate";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; value: string; checked: boolean; disabled: boolean;
  click(): void; dispatchEvent(e: unknown): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>;
}
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: { appendChild(c: Host): void } }
type Candidate = { name: string; external: boolean; status: string };
type PickerProps = { localAgents: Candidate[]; sel: string[]; onChange(v: string[]): void; onOpened(): void };
const candidates: Candidate[] = [
  { name: "中文协作", external: true, status: "active" },
  { name: "AlphaDesk", external: true, status: "active" },
  { name: "private", external: false, status: "stopped" },
  { name: "lend-abcdef0123", external: true, status: "active" },
];
const SHARED = new URL("../web/features/chat/components/peers-shared.tsx", import.meta.url).href;
const PANEL = new URL("../web/features/chat/components/peers-modal.tsx", import.meta.url).href;
const JOIN = new URL("../web/features/chat/components/peers-join-confirm.tsx", import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let ScopePicker: (p: PickerProps) => ReturnType<ReactNS["createElement"]>;
let PeersPanel: () => ReturnType<ReactNS["createElement"]>;
let JoinConfirm: (p: { code: string }) => ReturnType<ReactNS["createElement"]>;
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ ScopePicker } = await import(SHARED));
  ({ PeersPanel } = await import(PANEL));
  ({ JoinConfirm } = await import(JOIN));
  doc = (globalThis as unknown as { document: Doc }).document;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = () => React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
const rows = (host: El) => Array.from(host.querySelectorAll('input[type="checkbox"]')).slice(1);
const button = (host: El, name: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === name)!;
async function input(el: El | null, value: string) {
  expect(el).not.toBeNull();
  const dom = globalThis as unknown as {
    HTMLInputElement: { prototype: object }; Event: new (type: string, options: object) => unknown;
  };
  await React.act(async () => {
    // Bypass React's value tracker exactly as a browser's user input does.
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}

function intercept() {
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    const path = new URL(String(url), "https://fixture.example.test").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    let response: unknown;
    if (path === "/app-config.json") response = { mode: "direct" };
    else if (path === "/api/v1/peers") response = { ok: true, localAgents: candidates, pendingInvites: [], peers: [
      { name: "demo", baseUrl: "https://peer.example.test", handshakeDone: true, exposedAgents: ["中文协作", "historical-worker"] },
    ] };
    else if (path === "/api/v1/relay/status") response = { ok: false };
    else if (path === "/api/v1/peers/inspect") response = { ok: true, reachable: true, name: "demo", agents: ["remote"] };
    else if (["/api/v1/peers/demo/scope", "/api/v1/peers/invite-new", "/api/v1/peers/join-auto"].includes(path)) response = { ok: true };
    else throw new Error(`Unexpected request ${method} ${path}`);
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch);
  return { requests, restore: () => fetchSpy.mockRestore() };
}

async function mount(element: ReturnType<ReactNS["createElement"]>) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(element));
  await tick();
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

async function withPicker(initial: string[], run: (ui: Awaited<ReturnType<typeof mount>>, changes: string[][], saved: string[][]) => Promise<void>) {
  const network = intercept();
  const changes: string[][] = [], saved: string[][] = [];
  function Harness() {
    const [sel, setSel] = React.useState(initial);
    return React.createElement(React.Fragment, null,
      React.createElement(ScopePicker, { localAgents: candidates, sel, onChange: v => { changes.push(v); setSel(v); },
        onOpened: () => { throw new Error("Searching must not open external gates"); } }),
      React.createElement("button", { onClick: () => saved.push(sel) }, "save"));
  }
  const ui = await mount(React.createElement(Harness));
  try {
    await run(ui, changes, saved);
    expect(network.requests).toEqual([]);
  } finally { await ui.unmount(); network.restore(); }
}

test("ScopePicker filters display names: Chinese, case, trimmed whitespace, zero results and clear", async () => {
  await withPicker([], async ({ host }, changes) => {
    const search = host.querySelector('input[type="search"]');
    expect(rows(host).length).toBe(4);
    await input(search, "  中文  ");
    expect(rows(host).length).toBe(1);
    expect(host.textContent).toContain("中文协作");
    expect(host.textContent).not.toContain("AlphaDesk");
    await input(search, "  aLpHa  ");
    expect(rows(host).length).toBe(1);
    expect(host.textContent).toContain("AlphaDesk");
    await input(search, "no-such-session");
    expect(rows(host).length).toBe(0);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("no-such-session");
    await React.act(async () => button(host, "清空").click());
    expect(search!.value).toBe("");
    expect(rows(host).length).toBe(4);
    await input(search, "   ");
    expect(rows(host).length).toBe(4);
    expect(changes).toEqual([]);
  });
});

test("hidden selections survive search/clear and onChange; saving while hidden submits the full sel", async () => {
  await withPicker(["historical-worker"], async ({ host }, changes, saved) => {
    await React.act(async () => rows(host)[0]!.click());
    expect(changes).toEqual([["historical-worker", "中文协作"]]);
    const search = host.querySelector('input[type="search"]');
    await input(search, "Alpha");
    await React.act(async () => rows(host)[0]!.click());
    expect(changes.at(-1)).toEqual(["historical-worker", "中文协作", "AlphaDesk"]);
    await input(search, "missing");
    await React.act(async () => button(host, "save").click());
    expect(saved).toEqual([["historical-worker", "中文协作", "AlphaDesk"]]);
    await React.act(async () => button(host, "清空").click());
    expect(rows(host).map(r => r.checked)).toEqual([true, true, false, false]);
    expect(changes.length).toBe(2);
  });
});

test("external locks and legacy * cancellation stay intact; server still bans master and *", async () => {
  await withPicker([], async ({ host }, changes) => {
    await input(host.querySelector('input[type="search"]'), "private");
    expect(rows(host)[0]!.disabled).toBe(true);
    await React.act(async () => rows(host)[0]!.click());
    expect(changes).toEqual([]);
    expect(host.textContent).toContain("未开闸");
    expect(host.querySelectorAll('input[type="checkbox"]')[0]!.disabled).toBe(true);
  });
  await withPicker(["*"], async ({ host }, changes) => {
    await input(host.querySelector('input[type="search"]'), "Alpha");
    expect(rows(host)[0]!.checked).toBe(true);
    expect(rows(host)[0]!.disabled).toBe(true);
    await React.act(async () => host.querySelector('input[type="checkbox"]')!.click());
    expect(changes).toEqual([[]]);
  });
  expect(scopeGateError(["master"], {})).toContain("大总管");
  expect(scopeGateError(["*"], {})).toContain('"*"');
});

test("real edit-scope, new-invite and two-way-join entrances share the same search and preserve saved selections", async () => {
  const network = intercept();
  const ui = await mount(React.createElement(PeersPanel));
  let joinUi: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    await React.act(async () => button(ui.host, "修改").click());
    const edit = ui.host.querySelector('input[type="search"]');
    const before = network.requests.length;
    await input(edit, "Alpha");
    expect(network.requests.length).toBe(before);
    await React.act(async () => button(ui.host, "保存").click());
    await tick();
    expect(network.requests.find(r => r.path.endsWith("/demo/scope"))?.body?.agents).toEqual(["中文协作", "historical-worker"]);
    await React.act(async () => button(ui.host, "邀请对方").click());
    const invite = ui.host.querySelector('input[type="search"]');
    await input(invite, "中文");
    await React.act(async () => rows(ui.host)[0]!.click());
    await input(invite, "missing");
    await React.act(async () => button(ui.host, "生成邀请串").click());
    await tick();
    expect(network.requests.find(r => r.path.endsWith("/invite-new"))?.body?.agents).toEqual(["中文协作"]);
    joinUi = await mount(React.createElement(JoinConfirm, { code: "synthetic-invite" }));
    await React.act(async () => joinUi!.host.querySelector('input[type="checkbox"]')!.click());
    await tick();
    const joinSearch = joinUi.host.querySelector('input[type="search"]');
    await input(joinSearch, "  ALPHA  ");
    // The first checkbox is two-way join, the second is *, then the matching candidate.
    await React.act(async () => joinUi!.host.querySelectorAll('input[type="checkbox"]')[2]!.click());
    const beforeSearch = network.requests.length;
    await input(joinSearch, "missing");
    expect(network.requests.length).toBe(beforeSearch);
    await React.act(async () => button(joinUi!.host, "加入").click());
    await tick();
    expect(network.requests.find(r => r.path.endsWith("/join-auto"))?.body?.agents).toEqual(["AlphaDesk"]);
    expect(network.requests.some(r => r.path.includes("/external"))).toBe(false);
  } finally { if (joinUi) await joinUi.unmount(); await ui.unmount(); network.restore(); }
});
