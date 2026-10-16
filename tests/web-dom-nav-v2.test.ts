/**
 * NAVV2-SHELLA1 新版整页宿主真挂到 happy-dom：同一份 NAVBAR1 夹具（tests/helpers/nav-shots.ts），/settings 答 navV2: true。
 * 390 = aside 里的整页宿主 + 底部栏；1280 = 图标栏 + 主区宿主（协作层 CollabSwitch 与 Sidebar 并排挂）。
 * 覆盖：五页切换、会话常在、两种外壳都找得到设置、受限设备只出授权页、一键回退当场生效、读失败保留上次值。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { navDom, type NavDomView, type NavOptions, TEAM_NAME } from "./helpers/nav-shots";

const opts: NavOptions = { navV2: true };
// 带 react 的 web 模块：运行时加载，不进根 tsc
const web = <T>(p: string) => require(`../web/features/${p}`) as T;
const navTab = () => web<{ resetNavTab(): void; setTab(t: string): void }>("nav/nav-tab.ts");
let dom: Awaited<ReturnType<typeof navDom>>;
beforeAll(async () => { dom = await navDom(opts, () => ({
  sidebar: require("../web/features/chat/components/sidebar.tsx"), store: require("../web/features/chat/chat-store.ts"),
  nav: require("../web/features/chat/components/nav-context.tsx"), asks: require("../web/features/asks/asks-store.ts"),
  collab: require("../web/features/collab/collab-nav.ts"), entry: require("../web/features/collab/team-view-entry.tsx"),
  contacts: require("../web/features/chat/contacts-data.ts"), collabEntry: require("../web/features/collab/collab-entry.tsx"),
})); });
afterEach(async () => {
  await dom.cleanup();
  await dom.React.act(async () => navTab().resetNavTab());
  opts.navV2 = true;
  delete opts.full;
  delete opts.shells;
});
afterAll(async () => dom.dispose());

const tab = (v: NavDomView, bar: "phone" | "rail", t: string) => v.host.querySelector(`[data-nav=${bar}] [data-nav-tab=${t}]`);
/** 宿主当前那一页（被 hidden 的宿主算「不盖」） */
const current = (v: NavDomView, at: "aside" | "main") => {
  const host = v.host.querySelector(`[data-v2-host=${at}]`);
  return host && !host.hasAttribute("hidden") ? host.getAttribute("data-v2-current") : null;
};
const section = (v: NavDomView, id: string) => v.host.querySelector(`[data-v2-section=${id}]:not([hidden])`);
/** 弹窗 portal 在 host 外：从整个 body 找（根 tsc 没有 DOM 类型，经 v.all 取） */
const inBody = (v: NavDomView, sel: string) => v.all(sel)[0] ?? null;
/** 主区协作层；notices 用探针代替真的同步条 / 更新提示（那两个要构建时生成的 build-info） */
const CollabSwitch = () => web<{ CollabSwitch(p: { notices: unknown }): unknown }>("collab/collab-switch.tsx").CollabSwitch({ notices: dom.React.createElement("i", { "data-notice-probe": "" }) });

test("[验收线 2] 读取规则：读到就用、读失败保留上次值、从没读到按缺省开", () => {
  const { resolveNavV2 } = web<{ resolveNavV2(r: boolean | null, l: boolean | null): boolean }>("nav/nav-v2.ts");
  expect([resolveNavV2(null, null), resolveNavV2(null, false), resolveNavV2(null, true)]).toEqual([true, false, true]);
  expect([resolveNavV2(false, true), resolveNavV2(true, false)]).toEqual([false, true]);
});

test("[验收线 1] 390 新版：冷开整页「今天」；五入口切换，「会话」不盖露出原列表，回到「今天」还是那一页", async () => {
  const v = await dom.mount(390);
  await v.until(() => !!section(v, "today")?.querySelector("[data-now=page]"), "v2 today");
  expect(v.host.querySelector("[data-nav-pages]")).toBeNull();
  expect(v.texts("[data-nav=phone] [data-nav-tab]")).toEqual(["2今天", "项目", "4会话", "团队", "我的"]);
  await v.click(tab(v, "phone", "projects"), "projects");
  await v.until(() => v.all("[data-v2-section=projects] [data-now-project]").length === 4, "project rows");
  expect(v.texts("[data-v2-section=projects] [data-v2-title]")).toEqual(["项目"]);
  await v.click(v.host.querySelector("[data-v2-section=projects] [data-now-project=proj-b]"), "project B");
  expect([v.seen.open, v.seen.toContent]).toEqual(["proj-b", 1]);
  expect(current(v, "aside")).toBe("projects"); // 横滑回列表页仍在「项目」
  await v.click(tab(v, "phone", "sessions"), "sessions");
  expect(current(v, "aside")).toBeNull();
  expect(v.host.querySelector("aside input[type=search]")).not.toBeNull();
  expect(v.texts("aside .overflow-y-auto").join(" ")).toContain("大总管");
  await v.click(tab(v, "phone", "team"), "team");
  await v.until(() => v.all(`[data-v2-section=team] button[aria-label='${TEAM_NAME}']`).length === 1, "team page");
  await v.click(tab(v, "phone", "today"), "today again");
  expect(v.all("[data-v2-section=today]")).toHaveLength(1); // 去过的页常挂，不重挂（滚动位置还在）
  await v.unmount();
});

test("[验收线 1][验收线 3] 390「我的」→ 设置进宿主子页（返回回到「我的」），点一页打开原设置弹窗；回退开关在这页", async () => {
  opts.shells = 200;
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "me"), "me");
  await v.until(() => v.all("[data-v2-section=me] [data-me-entry]").length === 8, "me entries");
  await v.click(v.host.querySelector("[data-v2-section=me] [data-me-entry=settings]"), "settings entry");
  expect(current(v, "aside")).toBe("settings");
  expect(tab(v, "phone", "me")?.getAttribute("aria-current")).toBe("page");
  await v.until(() => v.all("[data-v2-section=settings] [data-v2-settings]").length === 11, "settings pages");
  await v.until(() => !!v.host.querySelector("[data-v2-section=settings] [data-nav-v2-toggle]:not([disabled])"), "rollback toggle");
  await v.click(v.host.querySelector("[data-v2-section=settings] [data-v2-settings=appearance]"), "appearance");
  await v.until(() => v.bodyText().includes("字号"), "settings modal");
  await v.click(v.host.querySelector("[data-v2-section=settings] [data-v2-back]"), "back");
  expect(current(v, "aside")).toBe("me");
  await v.unmount();
});

test("[验收线 3] 受限设备：新版设置页只列本地页、不出回退开关（PUT 要 manage），「我的」不出管理类", async () => {
  opts.full = false;
  opts.shells = 403;
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "me"), "me");
  await v.until(() => v.all("[data-v2-section=me] [data-me-entry]").length === 2, "me entries");
  await v.click(v.host.querySelector("[data-v2-section=me] [data-me-entry=settings]"), "settings entry");
  await v.until(() => v.all("[data-v2-settings]").length > 0, "settings pages");
  expect(v.all("[data-v2-settings]").map((e) => e.getAttribute("data-v2-settings"))).toEqual(["general", "appearance", "security", "labs"]);
  expect(v.host.querySelector("[data-nav-v2-toggle]")).toBeNull();
  await v.unmount();
});

test("[验收线 1][验收线 4] 1280 新版：侧栏常驻会话列表，今天 / 项目 / 团队画在主区；点会话（closingCollab）退回「会话」露出聊天", async () => {
  const v = await dom.mount(1280, CollabSwitch);
  await v.until(() => v.texts("[data-nav=rail] [data-nav-tab]").length === 5, "rail");
  expect(current(v, "main")).toBeNull(); // 电脑冷开在「会话」
  await v.click(tab(v, "rail", "today"), "today");
  await v.until(() => !!section(v, "today")?.querySelector("[data-now=page]"), "main today");
  expect(current(v, "main")).toBe("today");
  expect(v.host.querySelector("[data-nav-pages]")).toBeNull();
  expect(v.host.querySelector("aside input[type=search]")).not.toBeNull(); // 会话列表没被撤
  expect(v.all("[data-v2-host=main] [data-v2-notices] [data-notice-probe]")).toHaveLength(1); // 同步 / 更新提示跟着宿主上来（E02 / E03）
  await v.click(tab(v, "rail", "projects"), "projects");
  await v.until(() => v.all("[data-v2-host=main] [data-v2-section=projects] [data-now-project]").length === 4, "main projects");
  const { closingCollab } = web<{ closingCollab(fn: () => void): () => void }>("collab/collab-switch.tsx");
  let opened = 0;
  await dom.React.act(async () => closingCollab(() => { opened++; })());
  expect([opened, current(v, "main"), tab(v, "rail", "sessions")?.getAttribute("aria-current")]).toEqual([1, null, "page"]);
  expect(v.all("[data-v2-notices]")).toHaveLength(0); // 不盖就不挂第二份
  await v.unmount();
});

test("[验收线 2] 一键回退：新版设置页关掉开关当场换回 NAVBAR1 旧布局，旧布局里「我的」→ 设置仍能再打开回来", async () => {
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "me"), "me");
  await v.until(() => v.all("[data-v2-section=me] [data-me-entry=settings]").length === 1, "me entries");
  await v.click(v.host.querySelector("[data-v2-section=me] [data-me-entry=settings]"), "settings entry");
  await v.until(() => !!v.host.querySelector("[data-nav-v2-toggle]:not([disabled])"), "toggle");
  opts.navV2 = false; // 夹具 PUT 按它回体
  await v.click(v.host.querySelector("[data-nav-v2-toggle]"), "turn off");
  await v.until(() => !v.host.querySelector("[data-v2-shell]") && !!v.host.querySelector("[data-nav-pages=me]"), "old layout");
  expect(dom.calls).toContain("PUT /api/v1/settings");
  await v.click(v.host.querySelector("[data-nav-pages=me] [data-me-entry=settings]"), "old settings");
  await v.until(() => !!inBody(v, "[data-nav-v2-toggle]:not([disabled])"), "toggle in modal");
  opts.navV2 = true;
  await v.click(inBody(v, "[data-nav-v2-toggle]"), "turn on");
  await v.until(() => !!v.host.querySelector("[data-v2-shell]"), "v2 again");
  await v.unmount();
});

test("[验收线 2] 读失败保留上次值：已经是旧布局时 /settings 503，回前台刷新后仍是旧布局", async () => {
  opts.navV2 = false;
  const v = await dom.mount(390);
  await v.until(() => !!v.host.querySelector("[data-nav-pages=today]"), "old layout");
  const real = globalThis.fetch;
  let failed = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input instanceof Request ? input.url : input).includes("/settings")) return real(input, init);
    failed++;
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  try {
    const win = globalThis as unknown as { dispatchEvent(e: Event): void };
    await dom.React.act(async () => { win.dispatchEvent(new Event("focus")); });
    await dom.tick(100);
    expect(failed).toBeGreaterThan(0);
    expect(v.host.querySelector("[data-v2-shell]")).toBeNull();
    expect(v.host.querySelector("[data-nav-pages=today]")).not.toBeNull();
  } finally {
    globalThis.fetch = real;
  }
  await v.unmount();
});
