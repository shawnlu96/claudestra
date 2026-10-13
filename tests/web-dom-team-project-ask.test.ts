/**
 * team-project-UXASK2 授权正确性：全站收件箱抽屉（AsksDrawer → AskCard → AskActions）里的团队项目确认卡用专用控件作答。
 * 带「选本机项目」的邀请卡预选推荐项、没选不能确认、提交恰好是按钮 + select wire；建项目卡两颗按钮各发自己的 id；
 * 规则不认的卡（按钮被改过）不出作答控件；canAnswer 为假按钮禁用并有说明；DOM 里没有 bind.params。
 * 先红：main 上同一张邀请卡走通用 ReplyChoices，不预选、不选也能点确认，提交只有按钮。
 * 真挂载到 happy-dom 里跑 React 19（guard TESTS_WEB_DOM）；fetch 全拦在本文件（只认 /app-config.json、/api/v1/asks 与作答），
 * happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WebAsk } from "../web/features/asks/asks-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  id: string; textContent: string | null; disabled: boolean; value: string; remove(): void;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null;
  click(): void; dispatchEvent(e: unknown): boolean;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void }; getElementById(id: string): El | null }
interface Store { start(key: string): () => void; openDrawer(focus?: string | null): void; closeDrawer(): void }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let store: Store;
let AsksDrawer: unknown;
let activeAnswered: () => unknown;

const NOW = Date.now();
const SECRET = { centerId: "sentinel-center-7f3a", teamId: "sentinel-team-91c2", instanceId: "sentinel-instance-4be0", code: "sentinel-invite-code" };
const ask = (over: Partial<WebAsk>): WebAsk => ({
  id: "x", fromAgent: null, assignee: null, createdBy: null, project: "master", taskId: null, title: "", context: "", body: "", kind: "authorize", kindHint: null,
  source: "system", options: [], allowText: false, blocking: true, urgency: "normal", state: "open", answer: null,
  createdAt: NOW - 60_000, updatedAt: NOW - 60_000, expiresAt: NOW + 3_600_000, canAnswer: true, ...over,
});
const buttons = (a: string, d: string, la: string, ld: string) => ({ type: "buttons", buttons: [{ id: a, label: la, style: "success" }, { id: d, label: ld, style: "secondary" }] });
const select = { type: "select", id: "sl_join_local", placeholder: "选本机项目",
  options: [{ value: "create", label: "新建本机项目" }, { value: "local-app", label: "绑定本机工作区" }] };
function asks(canAnswer = true): WebAsk[] {
  return [
    ask({ id: "join", createdBy: "system:shared-ledger-join-offer", title: "邀请加入团队项目 合成项目", context: "合成邀请", canAnswer,
      options: [buttons("sl_join_accept", "sl_join_decline", "确认加入", "不加入"), select],
      extra: { sharedProjectChoice: { selectId: "sl_join_local", recommended: "create" } } as WebAsk["extra"],
      bind: { action: "shared-ledger.join", params: SECRET } }),
    ask({ id: "create", createdBy: "system:shared-projects", title: "创建团队项目 合成项目", context: "合成建项目", canAnswer,
      options: [buttons("shared_project_confirm", "shared_project_cancel", "确认创建", "取消创建")], bind: { action: "shared-projects.create", params: SECRET } }),
    ask({ id: "decide", fromAgent: "agent-dev-1", kind: "decide", source: "reply", title: "接口命名二选一", canAnswer,
      options: [buttons("opt_a", "opt_b", "用 A", "用 B")] }),
    ask({ id: "tampered", createdBy: "system:shared-projects", title: "被改过的合成卡", context: "按钮不对", canAnswer,
      options: [buttons("shared_project_confirm", "shared_project_other", "确认创建", "别的按钮")], bind: { action: "shared-projects.create", params: SECRET } }),
  ];
}

let current: WebAsk[] = [];
const posts: { path: string; body: { choices?: string[] } }[] = [];
const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === "/api/v1/asks") return json({ ok: true, asks: current, full: true, now: Date.now() });
    if (url.pathname.endsWith("/answer")) {
      posts.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ ok: true });
    }
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  ({ asksStore: store } = (await import(mod("asks/asks-store.ts"))) as { asksStore: Store });
  ({ AsksDrawer } = (await import(mod("asks/components/asks-drawer.tsx"))) as { AsksDrawer: unknown });
  ({ activeAnswered } = (await import(mod("asks/answer-cooldown.ts"))) as { activeAnswered: () => unknown });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
let machine = 0;
/** 每次换一个机器 key：asks store 整份重来；上一张答完的淡出 / 冷却先等它过去 */
async function mount(canAnswer = true) {
  for (let i = 0; i < 100 && activeAnswered(); i++) await tick(50);
  current = asks(canAnswer);
  posts.length = 0;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  let stop = () => {};
  await React.act(async () => {
    stop = store.start(`fixture-${++machine}`);
    store.openDrawer();
    root.render(React.createElement(AsksDrawer as never, { onOpenChat() {} }));
  });
  for (let i = 0; i < 100 && !doc.getElementById("ask-join"); i++) await tick();
  const card = (id: string) => doc.getElementById(`ask-${id}`)!;
  const button = (id: string, label: string) => Array.from(card(id).querySelectorAll("button")).find((b) => b.textContent === label) ?? null;
  const unmount = async () => {
    await React.act(async () => { store.closeDrawer(); root.unmount(); stop(); });
    host.remove();
  };
  return { card, button, unmount };
}
async function pick(el: El, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  await React.act(async () => { setter.call(el, value); el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("change", { bubbles: true })); });
}
async function click(el: El | null) {
  await React.act(async () => el!.click());
  await tick(50);
}

test("分组：『团队项目确认 · 3』在『等你处理 · 1』前面，拍板卡留在等你处理", async () => {
  const m = await mount();
  try {
    const heads = Array.from(doc.body.querySelectorAll("[role=dialog] h2")).map((h) => (h.textContent ?? "").replace(/\s+/g, " "));
    expect(heads).toEqual(["团队项目确认 · 3", "等你处理 · 1"]);
    const sections = Array.from(doc.body.querySelectorAll("[role=dialog] section")).map((s) => Array.from(s.querySelectorAll("article")).map((a) => a.id));
    expect(sections).toEqual([["ask-join", "ask-create", "ask-tampered"], ["ask-decide"]]);
  } finally { await m.unmount(); }
});

test("邀请卡：推荐项默认选中；清空后『确认加入』禁用；确认只发一次，choices 恰好是按钮 + select", async () => {
  const m = await mount();
  try {
    const sel = m.card("join").querySelector("select")!;
    expect(sel.value).toBe("create");
    await pick(sel, "");
    expect(m.button("join", "确认加入")!.disabled).toBe(true);
    await click(m.button("join", "确认加入"));
    expect(posts).toEqual([]);
    await pick(m.card("join").querySelector("select")!, "create");
    expect(m.button("join", "确认加入")!.disabled).toBe(false);
    const accept = m.button("join", "确认加入")!;
    await React.act(async () => { accept.click(); accept.click(); });
    await tick(50);
    expect(posts).toEqual([{ path: "/api/v1/ledger/master/asks/join/answer", body: { choices: ["[button:sl_join_accept]", "[select:sl_join_local:create]"] } }]);
  } finally { await m.unmount(); }
});

test("邀请卡：一打开就点『确认加入』，提交带上推荐的本机项目（main 上只发按钮、不带本机项目）", async () => {
  const m = await mount();
  try {
    await click(m.button("join", "确认加入"));
    expect(posts.map((p) => p.body.choices)).toEqual([["[button:sl_join_accept]", "[select:sl_join_local:create]"]]);
  } finally { await m.unmount(); }
});

for (const [label, id] of [["确认创建", "shared_project_confirm"], ["取消创建", "shared_project_cancel"]] as const) {
  test(`建项目卡（无选择行）：『${label}』只发 [button:${id}]`, async () => {
    const m = await mount();
    try {
      expect(m.card("create").querySelector("select")).toBeNull();
      await click(m.button("create", label));
      expect(posts).toEqual([{ path: "/api/v1/ledger/master/asks/create/answer", body: { choices: [`[button:${id}]`] } }]);
    } finally { await m.unmount(); }
  });
}

test("规则不认的卡（按钮被改过）：没有任何作答控件，只说格式不对", async () => {
  const m = await mount();
  try {
    const card = m.card("tampered");
    const answerButtons = Array.from(card.querySelectorAll("button")).filter((b) => b.getAttribute("aria-label") !== "删除");
    expect(answerButtons.map((b) => b.textContent)).toEqual([]);
    expect(card.querySelectorAll("select, textarea, input").length).toBe(0);
    expect(card.textContent).toContain("这张确认卡格式不对，不能在这里确认");
  } finally { await m.unmount(); }
});

test("canAnswer 为假：团队项目确认卡的按钮禁用，有只能看的说明，点了不发", async () => {
  const m = await mount(false);
  try {
    for (const [id, label] of [["join", "确认加入"], ["join", "不加入"], ["create", "确认创建"], ["create", "取消创建"]] as const) {
      expect({ id, label, disabled: m.button(id, label)?.disabled }).toEqual({ id, label, disabled: true });
    }
    expect(m.card("join").textContent).toContain("这个登录凭据只能看，作答要在 owner 本人的设备上");
    expect(m.card("create").textContent).toContain("这个登录凭据只能看，作答要在 owner 本人的设备上");
    await click(m.button("create", "确认创建"));
    expect(posts).toEqual([]);
  } finally { await m.unmount(); }
});

test("DOM 里没有 bind.params 的任何键值；拍板卡照旧用通用控件", async () => {
  const m = await mount();
  try {
    const html = (doc.body as unknown as { innerHTML: string }).innerHTML;
    for (const [k, v] of Object.entries(SECRET)) {
      expect({ k, key: html.includes(`"${k}"`), value: html.includes(v) }).toEqual({ k, key: false, value: false });
    }
    expect(html).not.toContain("批准的是");
    await click(m.button("decide", "用 A"));
    expect(posts.map((p) => p.body.choices)).toEqual([["[button:opt_a]"]]);
  } finally { await m.unmount(); }
});
