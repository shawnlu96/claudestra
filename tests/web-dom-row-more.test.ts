/**
 * agents-ROWMORE1：会话行 / project 组头的常显 ⋯ 与顶栏 ⋮ 的「立即打断」，真 React + happy-dom（guard TESTS_WEB_DOM）。
 *   - ⋯ 与长按 / 右键打开的是同一个菜单（AgentMenu / ProjectMenu 单实例），菜单项、顺序、禁用、二级入口逐项相等；
 *     预期不写死菜单数组，以 buildAgentMenu 当前规则为准（兼容 APHIDE1 之后的菜单）；
 *   - 点 ⋯ 不进会话、不折叠、不起拖拽 / 左滑；长按 / 右键 / 左滑照旧；多选 / 无菜单项时不渲染 ⋯；
 *   - 顶栏宽窄两态都只有一个可见 ⋮，里面有「立即打断」；点一次 = 真 store.interrupt() 发一次 POST /agents/:name/interrupt。
 * 全权判定（contacts-data）、本机打开方式（host-info）照 web-dom-project-pm 的做法 mock（保留真实模块其余导出）；
 * 接口一律由本文件的 fetch 答，interrupt 之外全 404。
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { buildAgentMenu } from "../web/features/chat/agent-menu";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; className: string; tagName: string; parentElement: El | null;
  getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
  click(): void; focus(): void; dispatchEvent(e: unknown): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>;
  getBoundingClientRect(): { left: number; bottom: number };
}
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: El & { appendChild(c: Host): void }; activeElement: El | null }
type Opener = { id: string; label: string; kind: "files" | "terminal" | "ide" };

const state = { full: true as boolean | null, openers: [] as Opener[], posts: [] as string[], fail: "", hold: false, release: [] as (() => void)[] };
const contactsData: Record<string, unknown> = await import(new URL("../web/features/chat/contacts-data.ts", import.meta.url).href);
mock.module("@/features/chat/contacts-data", () => ({ ...contactsData, useFullScope: () => state.full }));
const hostInfo: Record<string, unknown> = await import(new URL("../web/features/chat/host-info.ts", import.meta.url).href);
mock.module("@/features/chat/host-info", () => ({
  ...hostInfo,
  useHostInfo: () => ({ local: state.openers.length > 0, platform: "darwin", openers: state.openers }),
  openLocal: async () => ({ ok: true }),
}));

const realFetch = globalThis.fetch;
async function fakeFetch(input: unknown, init?: { method?: string }) {
  const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
  const m = url.pathname.match(/\/agents\/([^/]+)\/interrupt$/);
  if (m && init?.method === "POST") {
    state.posts.push(decodeURIComponent(m[1]));
    if (state.hold) await new Promise<void>((r) => state.release.push(r));
    return state.fail ? Response.json({ ok: false, error: state.fail }, { status: 500 }) : Response.json({ ok: true });
  }
  return Response.json({ error: "not in fixture" }, { status: 404 });
}

const mod = (p: string) => new URL(`../web/features/chat/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
interface Store { state: { activeAgent: string }; produce(f: (s: { activeAgent: string }) => void): void }
let ui: Record<string, unknown> & { useChatStoreApi: () => Store };
let store: Store | null = null;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  globalThis.fetch = fakeFetch as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  (await import(new URL("../web/lib/i18n.tsx", import.meta.url).href)).setLang("zh");
  const cs = await import(mod("chat-store.ts"));
  const row = await import(mod("components/agent-row.tsx"));
  const menu = await import(mod("components/agent-menu.tsx"));
  const pg = await import(mod("components/project-group.tsx"));
  const pm = await import(mod("components/project-menu.tsx"));
  const tb = await import(mod("components/topbar-actions.tsx"));
  ui = { ChatStoreProvider: cs.ChatStoreProvider, useChatStoreApi: cs.useChatStoreApi, AgentRow: row.AgentRow, AgentMenu: menu.AgentMenu,
    ProjectGroup: pg.ProjectGroup, ProjectMenu: pm.ProjectMenu, TopBarActions: tb.TopBarActions };
});

afterAll(async () => {
  await React.act(async () => (await import(mod("../collab/team-view-entry.tsx"))).unmountOpenViewGuardForTest?.());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  state.full = true;
  state.openers = [];
  state.posts = [];
  state.fail = "";
  state.hold = false;
  state.release = [];
  store = null;
});

type H = (...a: unknown[]) => unknown;
const h = (...a: unknown[]) => (React.createElement as unknown as H)(...a);
const act = (f: () => unknown) => React.act(async () => { await f(); });
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
const W = globalThis as unknown as Record<string, new (t: string, o: object) => unknown>;
const ev = (type: string, o: object = {}) => {
  const Ctor = type.startsWith("touch") ? W.TouchEvent : type.startsWith("drag") ? W.DragEvent ?? W.Event : type.startsWith("pointer") ? W.PointerEvent ?? W.MouseEvent : W.MouseEvent;
  return new Ctor(type, { bubbles: true, cancelable: true, ...o });
};
const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y, identifier: 0 }], changedTouches: [{ clientX: x, clientY: y, identifier: 0 }] });

function Grab() {
  store = ui.useChatStoreApi();
  return null;
}

async function mount(node: unknown) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await act(() => root.render(h(ui.ChatStoreProvider, null, h(Grab), node) as never));
  await tick();
  return {
    host,
    render: (n: unknown) => act(() => root.render(h(ui.ChatStoreProvider, null, h(Grab), n) as never)),
    unmount: async () => { await act(() => root.unmount()); host.remove(); },
  };
}

/** 菜单的可观测形状：标题 + 每项（文字、是否危险 / 禁用、是否有二级 ▸） */
const menuShape = () => {
  const m = doc.body.querySelector('[role="menu"]');
  if (!m) return null;
  return Array.from(m.querySelectorAll('[role="menuitem"]')).map((b) => ({
    text: b.textContent ?? "", danger: b.className.includes("text-error"), disabled: b.hasAttribute("disabled"),
  }));
};
const closeMenu = async () => {
  const mask = doc.body.querySelector(".fixed.inset-0");
  if (mask) await act(() => mask.dispatchEvent(ev("pointerdown")));
  expect(menuShape()).toBeNull();
};
const more = (root: El) => root.querySelector("[data-row-more]");

const AGENT = { name: "dev-a", displayName: "dev-a", purpose: "", cwd: "/tmp", status: "active", lastActivityTs: Date.now() - 60_000, projectId: "p" };

function rowNode(a: Record<string, unknown>, o: { onSelect?: () => void; manage?: boolean } = {}) {
  return h(React.Fragment, null,
    h("ul", null, h(ui.AgentRow, { a, active: false, busyLive: false, pinned: false, onTogglePin: () => {}, onSelect: o.onSelect ?? (() => {}), manage: o.manage })),
    h(ui.AgentMenu));
}

async function compareRowMenus(a: Record<string, unknown>) {
  let selected = 0;
  const ui0 = await mount(rowNode(a, { onSelect: () => selected++ }));
  const btn = more(ui0.host)!;
  expect(btn).not.toBeNull();
  await act(() => btn.click());
  const viaMore = menuShape();
  await closeMenu();
  const main = ui0.host.querySelector("li button")!;
  await act(() => main.dispatchEvent(ev("contextmenu", { clientX: 30, clientY: 30 })));
  const viaRight = menuShape();
  await closeMenu();
  await act(() => main.dispatchEvent(ev("touchstart", touch(30, 30))));
  await act(() => new Promise((r) => setTimeout(r, 520)));
  await act(() => main.dispatchEvent(ev("touchend", touch(30, 30))));
  const viaLong = menuShape();
  await closeMenu();
  await ui0.unmount();
  return { viaMore, viaRight, viaLong, selected };
}

test("[验收线 1] 会话行：⋯ / 右键 / 长按打开同一菜单，项、顺序、危险 / 禁用、二级 ▸ 一致，且与 buildAgentMenu 当前规则对得上", async () => {
  state.openers = [{ id: "finder", label: "Finder", kind: "files" }, { id: "iterm", label: "iTerm", kind: "terminal" }, { id: "ghostty", label: "Ghostty", kind: "terminal" }];
  for (const a of [AGENT, { ...AGENT, status: "stopped" }, { ...AGENT, mission: { goal: "x" } }]) {
    const r = await compareRowMenus(a);
    expect(r.viaMore).not.toBeNull();
    expect(r.viaRight).toEqual(r.viaMore);
    expect(r.viaLong).toEqual(r.viaMore);
    expect(r.selected).toBe(0);
    const rule = buildAgentMenu(a as never, state.openers, "darwin", true)!;
    expect(r.viaMore!.length).toBe(rule.length);
    expect(r.viaMore!.map((x) => x.text.endsWith("▸"))).toEqual(rule.map((x) => !!x.submenu));
  }
});

test("[验收线 1] 非全权：菜单只剩打开目录时 ⋯ 照样有且同一份；连打开方式都没有就不出现空 ⋯", async () => {
  state.full = false;
  state.openers = [{ id: "finder", label: "Finder", kind: "files" }];
  const r = await compareRowMenus(AGENT);
  expect(r.viaMore).toEqual([{ text: "在 Finder 中显示", danger: false, disabled: false }]);
  expect(r.viaRight).toEqual(r.viaMore);
  state.openers = [];
  const u = await mount(rowNode(AGENT));
  expect(more(u.host)).toBeNull();
  await u.unmount();
});

test("[验收线 1][验收线 3] 无菜单 / 多选：mock、大总管（与长按一致不挂菜单）、多选模式均不渲染 ⋯", async () => {
  for (const [a, manage] of [[{ ...AGENT, mock: true }, false], [{ ...AGENT, pinnedMaster: true }, false], [AGENT, true]] as const) {
    const u = await mount(rowNode(a, { manage }));
    expect(more(u.host)).toBeNull();
    await act(() => u.host.querySelector("li button")!.dispatchEvent(ev("contextmenu", { clientX: 5, clientY: 5 })));
    expect(menuShape()).toBeNull();
    await u.unmount();
  }
});

test("[验收线 3] 点 ⋯ 不进会话、不起左滑 / 拖拽；按钮可聚焦、有名字；主按钮的左滑与长按照旧", async () => {
  let selected = 0;
  const u = await mount(rowNode(AGENT, { onSelect: () => selected++ }));
  const btn = more(u.host)!;
  expect(btn.tagName).toBe("BUTTON");
  expect(btn.getAttribute("type")).toBe("button");
  expect(btn.getAttribute("aria-label")).toBe("更多操作");
  expect(btn.getAttribute("draggable")).toBe("false");
  // 不嵌套：⋯ 与进会话的按钮是兄弟
  expect(btn.parentElement!.querySelector("button button")).toBeNull();
  btn.focus();
  expect(doc.activeElement).toBe(btn);
  await act(() => btn.click()); // 键盘 Enter / Space 对原生 button 即 click
  expect(menuShape()).not.toBeNull();
  expect(selected).toBe(0);
  await closeMenu();
  // 从 ⋯ 起手横滑：事件不冒到滑动层，左滑操作区不出现
  await act(() => btn.dispatchEvent(ev("touchstart", touch(300, 20))));
  await act(() => btn.dispatchEvent(ev("touchmove", touch(200, 20))));
  await act(() => btn.dispatchEvent(ev("touchend", touch(200, 20))));
  expect(u.host.textContent).not.toContain("删除");
  const drag = ev("dragstart") as { defaultPrevented: boolean };
  await act(() => btn.dispatchEvent(drag));
  expect(drag.defaultPrevented).toBe(true);
  // 主按钮：横滑照样露出左滑操作
  const main = u.host.querySelector("li button")!;
  await act(() => main.dispatchEvent(ev("touchstart", touch(300, 20))));
  await act(() => main.dispatchEvent(ev("touchmove", touch(200, 20))));
  await act(() => main.dispatchEvent(ev("touchend", touch(200, 20))));
  expect(u.host.querySelectorAll("li button").length).toBeGreaterThan(2);
  await u.unmount();
});

function groupNode(collapsed: boolean, onToggle: () => void) {
  const e = { kind: "group", id: "proj", meta: { id: "proj", name: "Proj", emoji: "🚀", dirs: ["/tmp/proj"] }, items: [] };
  return h(React.Fragment, null, h("ul", null, h(ui.ProjectGroup, { e, collapsed, groupBusy: false, onToggle })), h(ui.ProjectMenu));
}

test("[验收线 1][验收线 3] 项目组头：⋯ 与右键 / 长按同一个 ProjectMenu；点 ⋯ 不折叠；线条文件夹替代 emoji", async () => {
  state.openers = [{ id: "finder", label: "Finder", kind: "files" }];
  let toggled = 0;
  const u = await mount(groupNode(true, () => toggled++));
  const head = u.host.querySelector("li button")!;
  const btn = more(u.host)!;
  expect(btn).not.toBeNull();
  expect(head.querySelector("[data-row-more]")).toBeNull(); // ⋯ 不在折叠按钮里面
  await act(() => btn.click());
  await tick();
  const viaMore = menuShape();
  await closeMenu();
  await act(() => head.dispatchEvent(ev("contextmenu", { clientX: 40, clientY: 40 })));
  await tick();
  const viaRight = menuShape();
  await closeMenu();
  await act(() => head.dispatchEvent(ev("touchstart", touch(40, 40))));
  await act(() => new Promise((r) => setTimeout(r, 520)));
  await act(() => head.dispatchEvent(ev("touchend", touch(40, 40))));
  await tick();
  const viaLong = menuShape();
  await closeMenu();
  // 有 manage：打开目录 + 主管 PM ▸ + 接入编排（ProjectMenu 现有规则）
  expect(viaMore![0]).toEqual({ text: "在 Finder 中显示", danger: false, disabled: false });
  expect(viaMore!.map((x) => x.text)).toContain("接入编排");
  expect(viaRight).toEqual(viaMore);
  expect(viaLong).toEqual(viaMore);
  expect(toggled).toBe(0);
  await act(() => new Promise((r) => setTimeout(r, 750))); // 过了长按松手的吞点窗口
  await act(() => head.click());
  expect(toggled).toBe(1);
  // 组头不再显示 emoji（自定义 🚀 / 默认 📁📂），收起 = folder，展开 = folder-open
  expect(head.textContent).not.toMatch(/🚀|📁|📂/u);
  const closedPath = head.querySelector("svg + svg path")?.getAttribute("d");
  await u.render(groupNode(false, () => toggled++));
  const openHead = u.host.querySelector("li button")!;
  expect(openHead.textContent).not.toMatch(/🚀|📁|📂/u);
  const openPath = openHead.querySelector("svg + svg path")?.getAttribute("d");
  expect(closedPath?.startsWith("M20 20a2")).toBe(true);
  expect(openPath?.startsWith("m6 14 1.5-2.9")).toBe(true);
  await u.unmount();
});

test("[验收线 1] 项目组头：无 manage 且本机无打开方式时没有菜单，也不出现空 ⋯", async () => {
  state.full = false;
  const u = await mount(groupNode(true, () => {}));
  expect(more(u.host)).toBeNull();
  await u.unmount();
});

/** 顶栏：可见 ⋮ 的个数（宽 = 去掉祖先带 @xl:hidden 的；窄 = 去掉祖先带 `hidden @xl:flex` 那组平铺按钮的），以及其中的「立即打断」 */
function topbar(host: El) {
  const dots = Array.from(host.querySelectorAll('[aria-label="更多操作"]'));
  const hiddenIn = (el: El, wide: boolean) => {
    for (let p: El | null = el; p && p !== host; p = p.parentElement) {
      const c = ` ${p.className} `;
      if (wide && c.includes(" @xl:hidden ")) return true;
      if (!wide && c.includes(" hidden ") && !c.includes(" @xl:hidden ")) return true;
    }
    return false;
  };
  const view = (wide: boolean) => {
    const vis = dots.filter((d) => !hiddenIn(d, wide));
    const items = vis.flatMap((d) => Array.from(d.parentElement!.querySelectorAll("[data-interrupt-item]")).filter((i) => !hiddenIn(i, wide)));
    return { menus: vis.length, interrupt: items.length };
  };
  return { wide: view(true), narrow: view(false), item: () => host.querySelector("[data-interrupt-item]") };
}

async function mountTop(agent: Record<string, unknown>) {
  const u = await mount(h(ui.TopBarActions, { agent, busy: false, onManage: () => {} }));
  await act(() => store!.produce((s) => { s.activeAgent = agent.name as string; }));
  return u;
}

test("[验收线 2] 顶栏：普通会话（合并菜单）/ 大总管 / 受限设备，宽窄两态都只有一个可见 ⋮，且都有「立即打断」；点一次 = 一次 interrupt POST", async () => {
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["普通", AGENT, true], ["大总管", { ...AGENT, name: "master", pinnedMaster: true }, true], ["受限设备", AGENT, false],
  ];
  for (const [label, agent, full] of cases) {
    state.full = full;
    state.posts = [];
    const u = await mountTop(agent);
    const v = topbar(u.host);
    expect([label, v.wide, v.narrow]).toEqual([label, { menus: 1, interrupt: 1 }, { menus: 1, interrupt: 1 }]);
    expect(v.item()!.textContent).toContain("立即打断");
    await act(() => v.item()!.click());
    await tick();
    expect([label, state.posts]).toEqual([label, [agent.name as string]]);
    await u.unmount();
  }
});

test("[验收线 2] mock / 非 active：没有「立即打断」，宽顶栏也不多出 ⋮", async () => {
  for (const agent of [{ ...AGENT, mock: true }, { ...AGENT, status: "stopped" }]) {
    for (const full of [true, false]) {
      state.full = full;
      const u = await mountTop(agent);
      const v = topbar(u.host);
      expect(v.item()).toBeNull();
      expect(v.wide.menus).toBeLessThanOrEqual(1);
      expect(v.narrow.menus).toBeLessThanOrEqual(1);
      await u.unmount();
    }
  }
  expect(state.posts).toEqual([]);
});

test("[验收线 2] 请求中再点不重发；失败把原因留在菜单项上", async () => {
  state.hold = true;
  state.fail = "agent busy elsewhere";
  const u = await mountTop(AGENT);
  const item = topbar(u.host).item()!;
  await act(() => item.click());
  expect(item.hasAttribute("disabled")).toBe(true);
  await act(() => item.click());
  expect(state.posts).toEqual(["dev-a"]);
  await act(() => state.release.forEach((r) => r()));
  await tick();
  expect(state.posts).toEqual(["dev-a"]);
  const alert = u.host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("agent busy elsewhere");
  expect(item.hasAttribute("disabled")).toBe(false);
  await u.unmount();
});

test("[验收线 2] 切会话：旧菜单的动作不投给新会话；顶栏换成新会话后打的是新会话", async () => {
  const u = await mountTop(AGENT);
  const old = topbar(u.host).item()!;
  await act(() => store!.produce((s) => { s.activeAgent = "dev-b"; }));
  await act(() => old.click());
  await tick();
  expect(state.posts).toEqual([]);
  await u.render(h(ui.TopBarActions, { agent: { ...AGENT, name: "dev-b" }, busy: false, onManage: () => {} }));
  await act(() => topbar(u.host).item()!.click());
  await tick();
  expect(state.posts).toEqual(["dev-b"]);
  await u.unmount();
});
