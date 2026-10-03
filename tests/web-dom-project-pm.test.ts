/**
 * i28-PMSW2 侧栏 project 组头菜单的「主管 PM」：真挂载 ProjectGroup + ProjectMenu（happy-dom + React 19，guard TESTS_WEB_DOM）。
 * 接口（@/lib/api/project-pm）、manage 判定（contacts-data）、本机打开方式（host-info）mock 掉；
 * 拖拽放置与协作入口跟本卡无关，也换成空壳。纯逻辑见 tests/web-project-pm.test.ts。
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PmSwitchResult, ProjectPmView } from "../web/lib/api/project-pm";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; className: string; click(): void; dispatchEvent(e: unknown): boolean; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: El & { appendChild(c: Host): void } }

const state = {
  manage: true as boolean | null,
  openers: [] as { id: string; label: string; kind: "files" | "terminal" | "ide" }[],
  view: null as ProjectPmView | null,
  results: [] as PmSwitchResult[],
  posts: [] as { project: string; agent: string; dryRun: boolean }[],
  /** 置 true 时真 POST（dryRun=false）挂起，等测试手动 resolve（模拟慢链路） */
  hold: false,
  pending: [] as ((r: PmSwitchResult) => void)[],
};
mock.module("@/lib/api/project-pm", () => ({
  getProjectPm: async () => state.view!,
  switchProjectPm: async (project: string, agent: string, dryRun: boolean) => {
    state.posts.push({ project, agent, dryRun });
    if (state.hold && !dryRun) return new Promise<PmSwitchResult>((r) => state.pending.push(r));
    return state.results.shift() ?? { ok: true };
  },
}));
mock.module("@/features/chat/contacts-data", () => ({ useFullScope: () => state.manage }));
mock.module("@/features/chat/host-info", () => ({
  useHostInfo: () => ({ local: state.openers.length > 0, platform: "darwin", openers: state.openers }),
  openLocal: async () => ({ ok: true }),
}));
mock.module("@/features/chat/components/agent-dnd", () => ({ useAgentDrop: () => ({ over: false, handlers: {} }) }));
mock.module("@/features/collab/collab-entry", () => ({ CollabEntry: () => null }));

const GROUP = new URL("../web/features/chat/components/project-group.tsx", import.meta.url).href;
const MENU = new URL("../web/features/chat/components/project-menu.tsx", import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let ProjectGroup: (p: Record<string, unknown>) => unknown;
let ProjectMenu: () => unknown;
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ ProjectGroup } = (await import(GROUP)) as { ProjectGroup: typeof ProjectGroup });
  ({ ProjectMenu } = (await import(MENU)) as { ProjectMenu: typeof ProjectMenu });
  doc = (globalThis as unknown as { document: Doc }).document;
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  state.manage = true;
  state.openers = [];
  state.view = {
    active: "pm-a",
    candidates: [
      { name: "pm-a", runtime: "claude-code", online: true, registered: true },
      { name: "pm-b", runtime: "codex", online: true, registered: true },
    ],
  };
  state.results = [];
  state.posts = [];
  state.hold = false;
  state.pending = [];
});

const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount() {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const e = { kind: "group", id: "proj", meta: { id: "proj", name: "Proj", dirs: ["/tmp/proj"] }, items: [] };
  await React.act(async () =>
    root.render(React.createElement(React.Fragment, null,
      React.createElement("ul", null, React.createElement(ProjectGroup as never, { e, collapsed: true, groupBusy: false, onToggle: () => {} })),
      React.createElement(ProjectMenu as never))));
  const items = () => Array.from(doc.body.querySelectorAll('[role="menuitem"]'));
  const labels = () => items().map((b) => b.textContent ?? "");
  const item = (text: string) => items().find((b) => (b.textContent ?? "").includes(text))!;
  return {
    open: async () => {
      const head = host.querySelector("button")!;
      const MouseEv = (globalThis as unknown as { MouseEvent: new (t: string, o: object) => unknown }).MouseEvent;
      const ev = new MouseEv("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
      await React.act(async () => { head.dispatchEvent(ev); });
      await tick();
    },
    menu: () => doc.body.querySelector('[role="menu"]'),
    labels,
    click: async (text: string) => { await React.act(async () => item(text).click()); await tick(); },
    notes: () => Array.from(doc.body.querySelectorAll('[role="note"]')),
    disabled: () => Array.from(doc.body.querySelectorAll('[aria-disabled] [role="menuitem"]')).map((b) => b.textContent ?? ""),
    body: () => doc.body.textContent ?? "",
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

test("无 manage 授权、本机也没有打开方式：组头不挂手势，菜单打不开", async () => {
  state.manage = false;
  const ui = await mount();
  await ui.open();
  expect(ui.menu()).toBeNull();
  await ui.unmount();
});

test("无 manage 授权、有打开方式：菜单照常，但没有『主管 PM』", async () => {
  state.manage = false;
  state.openers = [{ id: "finder", label: "Finder", kind: "files" }];
  const ui = await mount();
  await ui.open();
  expect(ui.labels()).toEqual(["在 Finder 中显示"]);
  await ui.unmount();
});

test("有 manage、本机没有打开方式：菜单能打开且只显示『主管 PM』（带当前 PM 名）", async () => {
  const ui = await mount();
  await ui.open();
  expect(ui.menu()).not.toBeNull();
  expect(ui.labels()).toEqual(["主管 PM · pm-a▸"]);
  await ui.unmount();
});

test("二级页：返回项在首行，候选按 API 返回列出，当前 PM 打勾", async () => {
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  expect(ui.labels()).toEqual(["‹返回", "pm-a · Claude · 在线", "pm-b · Codex · 在线"]);
  const checked = Array.from(doc.body.querySelectorAll('[role="menuitem"]')).filter((b) => b.querySelector("svg path[d='M20 6 9 17l-5-5']"));
  expect(checked.map((b) => b.textContent)).toEqual(["pm-a · Claude · 在线"]);
  await ui.unmount();
});

test("点另一个 → 体检全绿 → 确认后 POST 一次，关菜单并提示", async () => {
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  expect(ui.labels()).toContain("›切到 pm-b");
  expect(ui.labels()).toContain("取消");
  await ui.click("切到 pm-b");
  expect(state.posts).toEqual([{ project: "proj", agent: "pm-b", dryRun: true }, { project: "proj", agent: "pm-b", dryRun: false }]);
  expect(ui.menu()).toBeNull();
  expect(ui.body()).toContain("主管 PM 已切到 pm-b");
  await ui.unmount();
});

test("体检不过：问题逐条以禁用样式列出，确认行不放行", async () => {
  state.results = [{ ok: false, status: 400, error: "pm-b is offline; peer p1 lacks a PM agent destination in peer-prs" }];
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  expect(ui.disabled()).toEqual(["›切到 pm-b"]);
  expect(ui.notes().map((n) => n.textContent)).toEqual(["pm-b is offline", "peer p1 lacks a PM agent destination in peer-prs"]);
  await ui.click("切到 pm-b");
  expect(state.posts.filter((p) => !p.dryRun)).toEqual([]);
  expect(ui.menu()).not.toBeNull();
  await ui.unmount();
});

test("确认时 403：原因留在菜单里，不关菜单、不提示", async () => {
  state.results = [{ ok: true }, { ok: false, status: 403, error: "project PM requires manage authorization" }];
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  await ui.click("切到 pm-b");
  expect(state.posts.filter((p) => !p.dryRun).length).toBe(1);
  expect(ui.menu()).not.toBeNull();
  expect(ui.notes().map((n) => n.textContent)).toContain("project PM requires manage authorization");
  expect(ui.body()).not.toContain("已切到");
  await ui.unmount();
});

test("长体检原因：整句折行显示，不单行省略", async () => {
  const long = "peer p1 lacks a PM agent destination in peer-prs (set peers.p1.pmAgent in ~/.claude-orchestrator/config.json)";
  state.results = [{ ok: false, status: 400, error: long }];
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  const [note] = ui.notes();
  expect(note.textContent).toBe(long);
  const text = note.querySelector("span:last-child")!;
  expect(text.className).not.toContain("truncate");
  expect(text.className).toContain("whitespace-normal");
  expect(text.className).toContain("break-words");
  await ui.unmount();
});

test("真 POST 在途：候选 / 取消 / 再次确认都锁住，不会并发第二次切换", async () => {
  state.hold = true;
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  await ui.click("切到 pm-b");
  // 锁定期间：确认 / 取消 / 候选都是禁用行，点了也不变
  expect(ui.disabled()).toEqual(["pm-a · Claude · 在线", "pm-b · Codex · 在线", "›体检中…", "取消"]);
  await ui.click("取消");
  await ui.click("pm-a");
  expect(state.posts.filter((p) => !p.dryRun).length).toBe(1);
  expect(ui.disabled()).toContain("取消");
  // 在途请求失败：原因留在菜单里，解锁可重选
  await React.act(async () => state.pending.shift()!({ ok: false, status: 403, error: "second request denied" }));
  await tick();
  expect(ui.menu()).not.toBeNull();
  expect(ui.notes().map((n) => n.textContent)).toEqual(["second request denied"]);
  expect(ui.disabled()).toEqual(["›切到 pm-b"]);
  await ui.unmount();
});

test("菜单关掉后结果才回来：不去关新开的菜单；失败原因改用轻提示带出", async () => {
  state.hold = true;
  const ui = await mount();
  await ui.open();
  await ui.click("主管 PM");
  await ui.click("pm-b");
  await ui.click("切到 pm-b");
  // 点遮罩关菜单，再重新打开（新的菜单实例）
  const MouseEv = (globalThis as unknown as { MouseEvent: new (t: string, o: object) => unknown }).MouseEvent;
  const overlay = doc.body.querySelector(".fixed.inset-0")!;
  await React.act(async () => { overlay.dispatchEvent(new MouseEv("pointerdown", { bubbles: true })); });
  expect(ui.menu()).toBeNull();
  await ui.open();
  expect(ui.menu()).not.toBeNull();
  await React.act(async () => state.pending.shift()!({ ok: false, status: 403, error: "late denied" }));
  await tick();
  expect(ui.menu()).not.toBeNull();
  expect(ui.labels()).toEqual(["主管 PM · pm-a▸"]);
  expect(ui.body()).toContain("主管 PM 切换失败：late denied");
  await ui.unmount();
});
