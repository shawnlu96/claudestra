/**
 * team-project-TEAMVIS8：团队卡详情的「会话」区。主场是别的机器的卡，点开按页向本机 local-api 要（登记一次 → 轮询到主场回传），只读。
 * 验收线：1) 查看器里没有 textarea / 可编辑元素 / 发送按钮，点遍所有能点的也不发消息 / say 请求；2) 主场到时没回 → 主场离线，
 * 不自动重发，点「重新获取」才再发一次；3) 403 清缓存、not_open 显示未开放。合成数据，fetch 全部拦在本文件、只回环；
 * happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; parentElement: El;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; remove(): void; click(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let nav: { openCollab(p: string): void; openCollabTask(t: string | null): void; closeCollab(): void };
let ui: { CollabView: unknown; ChatStoreProvider: unknown; TeamSource: unknown; sharedCollabProject: (i: Identity) => string };
let timing: (t: { pollMs: number; waitMs: number } | null) => void;
interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }

const PROJECT = "session-proj";
const HOME = "f".repeat(32);
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local", homeInstanceId: "mine-1" };
const NOW = Date.now();
const FOCUS = "R1";
const MASK = "[已遮蔽:疑似密钥]";
const ROOT = "/api/v1/shared-ledger/team-body/features/F1/tasks/task-1";
type Mode = "ok" | "offline" | "ticket-offline" | "not_open" | "403" | "expired";
let mode: Mode = "ok";
/** 这一轮经过 fetch 的请求（方法 + 路径） */
let seen: { method: string; path: string; body: string }[] = [];

function center(): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true } };
  const feature = { id: "F1", projectId: PROJECT, title: "会话事项", description: "看会话", rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const,
    counts: { total: 1, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const task = { taskId: "task-1", sourceTaskId: FOCUS, sourceRev: 1, sourceSeq: 9, stage: "review", assigneeCode: "peer-dev", executorInstanceId: HOME,
    pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] };
  const detail = { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: [{ key: FOCUS, oneLine: "在审的卡", deps: [], fileGlobs: [], estimate: "" }], bindings: [{ nodeKey: FOCUS, taskId: "task-1" }] },
    tasks: [task] } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}
const rec = (kind: string, sourceKey: string, text: string) =>
  ({ featureId: "F1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: "d".repeat(64) });
/** 最新一页（作者会话 5..7）和更早一页（作者 3，读完接审查员会话） */
const NEWEST = [
  rec("session-page", "author:5", "[用户]\n先把空列表的用例补上"),
  rec("session-page", "author:6", `[助手]\n补好了，顺手看了配置\n\n${MASK}\n[工具]\nRead: src/lib/list.ts\nBash: cat .env\n${MASK}\nEdit: src/lib/list.ts`),
  rec("session-page", "author:7", "[系统]\n上下文已压缩"),
];
const OLDER = [rec("session-page", "author:3", "[用户]\n开工：先写测试"), rec("session-page", "reviewer:2", "[助手]\n复核通过\n[工具]\nBash: bun test tests/list.test.ts")];

const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const c = center();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : "" });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === "/api/v1/agents") return json({ ok: true, agents: [] });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(c.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(c.detail);
    if (url.pathname === ROOT) return json({ schemaVersion: 1, teamId: "team-a", projectId: PROJECT, featureId: "F1", taskId: "task-1",
      records: [rec("event", "3", "开工：先写测试")], syncedAt: NOW - 60_000, homeOnline: true });
    if (url.pathname === `${ROOT}/session-pages` && method === "POST") {
      if (mode === "403") return json({ code: "not_member" }, 403);
      if (mode === "ticket-offline") return json({ code: "home_offline" }, 503);
      const cursor = (JSON.parse(String(init?.body)) as { cursor: string | null }).cursor;
      return json({ requestId: cursor === null ? "req-new" : "req-old", expiresAt: NOW + 600_000 });
    }
    const poll = url.pathname.match(/\/session-pages\/(req-\w+)$/);
    if (poll && method === "GET") {
      const base = { requestId: poll[1], expiresAt: NOW + 600_000, homeOnline: mode !== "offline" };
      if (mode === "offline") return json({ ...base, status: "pending", result: null });
      if (mode === "expired") return json({ code: "expired" }, 410);
      if (mode === "not_open") return json({ ...base, status: "ready", result: { kind: "refused", code: "not_open" } });
      return json({ ...base, status: "ready", result: poll[1] === "req-new" ? { kind: "page", records: NEWEST, nextCursor: "v1:author:5" }
        : { kind: "page", records: OLDER, nextCursor: null } });
    }
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  nav = await import(mod("collab/collab-nav.ts"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const sharedNav = await import(mod("collab/dag/shared-navigation.tsx"));
  timing = (await import(mod("collab/team-session/team-session-source.ts"))).setTeamSessionTimingForTest;
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: sharedNav.sharedCollabProject };
  timing({ pollMs: 10, waitMs: 120 });
});

afterAll(async () => {
  timing(null);
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  nav.closeCollab();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
const posts = () => seen.filter((r) => r.method === "POST" && r.path.endsWith("/session-pages")).length;

/** 每次换一个 person：团队源、取页器都按身份（项目键）留着，换模式要新的 */
let n = 0;
async function open(m: Mode, width = 1280) {
  mode = m;
  seen = [];
  (globalThis as unknown as { window: { happyDOM: { setViewport(v: { width: number; height: number }): void } } }).window.happyDOM.setViewport({ width, height: 900 });
  const identity = { ...IDENTITY, person: `person-${++n}` };
  const project = ui.sharedCollabProject(identity);
  nav.openCollab(project);
  nav.openCollabTask(FOCUS);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.TeamSource, { identity }, h(ui.CollabView, { project }))) as never));
  const panel = () => Array.from(doc.body.querySelectorAll("aside")).find((a) => (a.textContent ?? "").includes(FOCUS)) ?? null;
  for (let i = 0; i < 150 && !panel()?.querySelector("[data-team-session]"); i++) await tick();
  const sec = () => panel()!.querySelector("[data-team-session]")!;
  const state = () => sec().getAttribute("data-team-session");
  const click = async (selector: string) => { const el = sec().querySelector(selector)!; await React.act(async () => el.click()); };
  /** 等到不在加载（或到时） */
  const settle = async () => { for (let i = 0; i < 100 && (state() === "loading" || state() === "idle"); i++) await tick(10); await tick(30); };
  const close = async () => { await React.act(async () => root.unmount()); host.remove(); nav.closeCollab(); };
  return { sec, state, click, settle, close, text: () => sec().textContent ?? "" };
}

for (const width of [1280, 390]) {
  test(`复现测试:${width} 宽 点开会话 → 消息的顺序 / 角色 / 工具名同主场，工具折叠、展开，标已遮蔽；翻页接上更早的和审查员会话`, async () => {
    const v = await open("ok", width);
    // 没点开：不发取页请求，也没有查看器
    expect(v.state()).toBe("idle");
    expect(posts()).toBe(0);
    expect(v.sec().querySelector("[data-session-viewer]")).toBeNull();
    await v.click("[data-session-toggle]");
    await v.settle();
    expect(v.state()).toBe("ready");
    expect(posts()).toBe(1);
    const roles = () => Array.from(v.sec().querySelectorAll("[data-role]")).map((x) => x.getAttribute("data-role"));
    expect(roles()).toEqual(["user", "assistant", "system"]);
    expect(v.text()).toContain("先把空列表的用例补上");
    expect(v.text()).toContain("补好了，顺手看了配置");
    expect(v.text()).toContain("上下文已压缩");
    // 三步工具收进一个框，默认只露最新一步；展开后三步按主场顺序
    const tools = () => Array.from(v.sec().querySelectorAll("[data-tool-row]")).map((x) => x.textContent ?? "");
    expect(v.text()).toContain("3 步工具调用");
    expect(tools()).toHaveLength(1);
    expect(tools()[0]).toContain("Edit");
    await v.click("[data-role=assistant] button[aria-expanded]");
    expect(tools().map((t) => t.match(/^(Read|Bash|Edit)/)?.[1])).toEqual(["Read", "Bash", "Edit"]);
    // 已遮蔽：文字段 1 段、Bash 那一步 1 段；不显示「已截断」
    expect(Array.from(v.sec().querySelectorAll("[data-masked]")).map((x) => x.textContent)).toEqual(["已遮蔽 1 段", "已遮蔽 1 段"]);
    expect(v.text()).not.toContain("已截断");
    // 工具行默认折叠，点开才有输出
    expect(v.sec().querySelector("[data-tool-output]")).toBeNull();
    const bash = Array.from(v.sec().querySelectorAll("[data-tool-row] button")).find((b) => (b.textContent ?? "").includes("Bash"))!;
    await React.act(async () => bash.click());
    expect(v.sec().querySelector("[data-tool-output]")!.textContent).toBe(`cat .env\n${MASK}`);
    // 翻页：按 cursor 再要一页，更早的排到前面，读完作者会话接审查员会话
    await v.click("[data-session-more]");
    await v.settle();
    expect(posts()).toBe(2);
    expect(JSON.parse(seen.filter((r) => r.method === "POST").at(-1)!.body)).toEqual({ cursor: "v1:author:5" });
    expect(roles()).toEqual(["user", "user", "assistant", "system", "assistant"]);
    expect(v.sec().querySelectorAll("[data-session-group]")).toHaveLength(2);
    expect(v.text()).toMatch(/开工：先写测试[\s\S]*先把空列表的用例补上[\s\S]*复核通过/);
    expect(v.sec().querySelector("[data-session-more]")).toBeNull();
    // 收起再点开：用缓存，不再发
    await v.click("[data-session-toggle]");
    await v.click("[data-session-toggle]");
    await v.settle();
    expect(posts()).toBe(2);
    expect(roles()).toHaveLength(5);
    await v.close();
  });
}

test("复现测试:查看器只读：没有 textarea / 可编辑元素 / 发送按钮；点遍所有元素，只有取页请求，没有消息 / say 请求", async () => {
  const v = await open("ok");
  await v.click("[data-session-toggle]");
  await v.settle();
  const viewer = v.sec();
  expect(viewer.querySelector("textarea, input, select, [contenteditable=''], [contenteditable='true'], [role='textbox']")).toBeNull();
  expect(Array.from(viewer.querySelectorAll("button")).map((b) => b.textContent ?? "").filter((t) => /发送|对它说|Send/i.test(t))).toEqual([]);
  seen = [];
  // 点三轮：展开的工具行、翻页后新出来的元素也都点到
  for (let round = 0; round < 3; round++) {
    for (const el of Array.from(v.sec().querySelectorAll("*"))) {
      if (el.hasAttribute("data-session-toggle")) continue; // 收起会把查看器拿掉，留到最后单独点
      // svg 没有 click()：一律派发冒泡的 click 事件
      const Click = (globalThis as unknown as { MouseEvent: new (type: string, init: { bubbles: boolean }) => unknown }).MouseEvent;
      await React.act(async () => void (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new Click("click", { bubbles: true })));
    }
    await v.settle();
  }
  await v.click("[data-session-toggle]");
  await tick(60);
  const writes = seen.filter((r) => r.method !== "GET");
  expect(writes.every((r) => r.method === "POST" && r.path === `${ROOT}/session-pages`)).toBe(true);
  expect(writes.every((r) => Object.keys(JSON.parse(r.body) as object).join() === "cursor")).toBe(true);
  expect(seen.filter((r) => /messages|\/say\b|\/send\b|terminal|\/chat\b/.test(r.path))).toEqual([]);
  await v.close();
});

test("复现测试:主场到时没回 → 主场离线，不自动重发；点「重新获取」才再发一次", async () => {
  const v = await open("offline");
  await v.click("[data-session-toggle]");
  expect(v.state()).toBe("loading");
  expect(v.text()).toContain("正在向主场机器读取会话");
  await v.settle();
  expect(v.state()).toBe("home_offline");
  expect(v.text()).toContain("主场离线，暂时看不了会话");
  expect(posts()).toBe(1);
  const polls = seen.filter((r) => r.method === "GET" && r.path.includes("/session-pages/")).length;
  // 再等几个等待窗口：既不重发也不再轮询
  await tick(400);
  expect(posts()).toBe(1);
  expect(seen.filter((r) => r.method === "GET" && r.path.includes("/session-pages/")).length).toBe(polls);
  await v.click("[data-session-retry]");
  await v.settle();
  expect(posts()).toBe(2);
  expect(v.state()).toBe("home_offline");
  // 主场回来了：再点一次读到
  mode = "ok";
  await v.click("[data-session-retry]");
  await v.settle();
  expect(posts()).toBe(3);
  expect(v.state()).toBe("ready");
  expect(v.text()).toContain("先把空列表的用例补上");
  await v.close();

  // 登记时中心就说主场离线：同一句，不轮询
  const early = await open("ticket-offline");
  await early.click("[data-session-toggle]");
  await early.settle();
  expect(early.text()).toContain("主场离线，暂时看不了会话");
  expect(seen.some((r) => r.path.includes("/session-pages/"))).toBe(false);
  await early.close();
});

test("复现测试:403 → 不在成员里并清掉已读到的页；not_open → 主场未开放；请求过期 → 可点重新获取", async () => {
  const v = await open("ok");
  await v.click("[data-session-toggle]");
  await v.settle();
  expect(v.sec().querySelectorAll("[data-role]")).toHaveLength(3);
  // 翻页时被移出项目：已显示的收掉，缓存清空（收起再点开要重新取，仍是 403）
  mode = "403";
  await v.click("[data-session-more]");
  await v.settle();
  expect(v.state()).toBe("not_member");
  expect(v.text()).toContain("你不在该项目成员里");
  expect(v.sec().querySelectorAll("[data-role]")).toHaveLength(0);
  expect(v.sec().querySelector("[data-session-retry]")).toBeNull();
  const before = posts();
  await v.click("[data-session-toggle]");
  await v.click("[data-session-toggle]");
  await v.settle();
  expect(posts()).toBe(before + 1);
  expect(v.text()).not.toContain("先把空列表的用例补上");
  await v.close();

  const off = await open("not_open");
  await off.click("[data-session-toggle]");
  await off.settle();
  expect(off.state()).toBe("not_open");
  expect(off.text()).toContain("主场未开放会话");
  expect(off.sec().querySelector("[data-session-retry]")).toBeNull();
  await off.close();

  const expired = await open("expired");
  await expired.click("[data-session-toggle]");
  await expired.settle();
  expect(expired.state()).toBe("expired");
  expect(expired.text()).toContain("请求已过期");
  expect(posts()).toBe(1);
  await tick(200);
  expect(posts()).toBe(1);
  await expired.click("[data-session-retry]");
  await expired.settle();
  expect(posts()).toBe(2);
  await expired.close();
});
