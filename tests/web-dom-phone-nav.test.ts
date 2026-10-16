/**
 * NAVBAR1 五个入口真挂到 happy-dom（React 19）：真的 Sidebar（里面挂 NavShell）、真的 chat store / 待办 store / collab-nav / 联系人与终端探测。
 * 夹具 tests/helpers/nav-shots.ts（规格「对照基准」），夹具之外一律 404，不连任何 bridge。390 = 手机底部栏 + 入口页，1280 = 竖向图标栏 +「我的」菜单。
 * 布局（底部栏不盖最后一行、指示条位置）在 tests/web-phone-nav-browser.test.ts 的真 Chromium 里断言。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { meEntries } from "../web/features/nav/me-entries";
import { navDom, type NavDomView, type NavOptions, TEAM_NAME } from "./helpers/nav-shots";

const opts: NavOptions = {};
// nav-tab.ts 带 react 与 today-nav（DOM 类型）：运行时加载，不进根 tsc
const resetNavTab = () => (require("../web/features/nav/nav-tab.ts") as { resetNavTab(): void }).resetNavTab();
let dom: Awaited<ReturnType<typeof navDom>>;
beforeAll(async () => { dom = await navDom(opts, () => ({
  sidebar: require("../web/features/chat/components/sidebar.tsx"), store: require("../web/features/chat/chat-store.ts"),
  nav: require("../web/features/chat/components/nav-context.tsx"), asks: require("../web/features/asks/asks-store.ts"),
  collab: require("../web/features/collab/collab-nav.ts"), entry: require("../web/features/collab/team-view-entry.tsx"),
  contacts: require("../web/features/chat/contacts-data.ts"), collabEntry: require("../web/features/collab/collab-entry.tsx"),
})); });
afterEach(async () => {
  await dom.cleanup();
  await dom.React.act(async () => resetNavTab());
  delete opts.full;
  delete opts.shells;
  delete opts.team;
});
afterAll(async () => dom.dispose());

const ALL_ME = ["设置", "全部已读", "项目管理", "多选管理", "伙伴机器", "用量看板", "新终端", "图片与文件"];
const tab = (v: NavDomView, bar: "phone" | "rail", t: string) => v.host.querySelector(`[data-nav=${bar}] [data-nav-tab=${t}]`);
const page = (v: NavDomView) => v.host.querySelector("[data-nav-pages]")?.getAttribute("data-nav-pages") ?? null;
const meLabels = (v: NavDomView, scope: string) => v.all(`${scope} [data-me-entry]`).map((e) => (e.textContent ?? "").replace(/\d+\/\d+ 在线$/, ""));

test("[验收线 2] 「我的」条目表：全权设备 + shells 200 是原顶栏 8 个；非全权不出管理类；shells 403 不出新终端；多选中那条叫「退出多选」", () => {
  const ids = (o: Parameters<typeof meEntries>[0]) => meEntries(o).map((e) => e.label);
  expect(ids({ full: true, shell: true, manage: false })).toEqual(ALL_ME);
  expect(ids({ full: false, shell: true, manage: false })).toEqual(["设置", "新终端", "图片与文件"]);
  expect(ids({ full: true, shell: false, manage: false })).toEqual(ALL_ME.filter((x) => x !== "新终端"));
  expect(ids({ full: true, shell: true, manage: true })).toContain("退出多选");
});

test("[验收线 1] 390 冷开落在「今天」，底部五个入口都有字；≥640 的图标栏不在 DOM 里", async () => {
  const v = await dom.mount(390);
  await v.until(() => v.all("[data-nav-pages=today] [data-now=page]").length === 1, "today page");
  expect(v.texts("[data-nav=phone] [data-nav-tab]")).toEqual(["2今天", "项目", "4会话", "团队", "我的"]);
  expect(tab(v, "phone", "today")?.getAttribute("aria-current")).toBe("page");
  expect(v.host.querySelector("[data-nav=rail]")).toBeNull();
  await v.unmount();
});

test("[验收线 1] 390「会话」露出原列表（标题、搜索、列表原样）；「项目」点一行进协作视图，返回后仍在「项目」", async () => {
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "sessions"), "sessions tab");
  expect(page(v)).toBeNull();
  expect(v.host.querySelector("aside input[type=search]")).not.toBeNull();
  expect(v.texts("aside .overflow-y-auto").join(" ")).toContain("大总管");
  await v.click(tab(v, "phone", "projects"), "projects tab");
  await v.until(() => v.all("[data-nav-pages=projects] [data-now-project]").length === 4, "project rows");
  await v.click(v.host.querySelector("[data-nav-pages=projects] [data-now-project=proj-b]"), "project B");
  expect([v.seen.open, v.seen.toContent]).toEqual(["proj-b", 1]);
  // 横滑回列表页（外壳的 toList，Sidebar 不重挂）：入口还是「项目」
  expect(page(v)).toBe("projects");
  expect(tab(v, "phone", "projects")?.getAttribute("aria-current")).toBe("page");
  await v.unmount();
});

test("[验收线 1] 390「团队」列出全部团队项目（含本机已有分组的那个），点一行进协作视图；没有团队绑定时写空态", async () => {
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "team"), "team tab");
  const row = () => v.host.querySelector(`[data-nav-pages=team] section[aria-label='团队项目'] button[aria-label='${TEAM_NAME}']`);
  await v.until(() => !!row() && !row()!.hasAttribute("aria-disabled"), "team row");
  await v.click(row(), "team row");
  expect(v.seen.open).toMatch(/^@team:|center|team/);
  expect(v.seen.toContent).toBe(1);
  expect(v.texts("[data-team-link]")).toEqual(["成员与位子", "规划与提案"]);
  await v.unmount();
});

test("[验收线 1] 没有团队绑定时「团队」入口照样在，页面写空态，两条入口灰掉", async () => {
  opts.team = false;
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "team"), "team tab");
  await v.until(() => dom.calls.includes("GET /api/v1/shared-projects/snapshot"), "team snapshot read");
  await dom.tick(100);
  expect(v.host.querySelector("[data-nav-pages=team] section[aria-label='团队项目']")).toBeNull();
  expect(v.texts("[data-team-empty]")).toEqual(["还没有团队项目，加入后会出现在这里"]);
  expect(v.all("[data-team-link]").map((e) => e.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
  await v.unmount();
});

test("[验收线 1][验收线 3] 390「我的」：条目表 + 版本行；多选管理回到「会话」并进多选；设置打开设置弹窗", async () => {
  opts.shells = 200;
  const v = await dom.mount(390);
  await v.click(tab(v, "phone", "me"), "me tab");
  await v.until(() => meLabels(v, "[data-nav-pages=me]").length === 8, "me entries");
  expect(meLabels(v, "[data-nav-pages=me]")).toEqual(ALL_ME);
  expect(v.texts("[data-nav-pages=me] [data-me-status]")).toEqual([]); // 夹具不带伙伴机器（navDom），在线数在浏览器测试里断言
  expect(v.texts("[data-me-version]")[0]).toContain("Floka Web");
  await v.click(v.host.querySelector("[data-nav-pages=me] [data-me-entry=manage]"), "manage");
  expect(page(v)).toBeNull();
  expect(v.texts("aside").join(" ")).toContain("已选 0 个");
  await v.click(tab(v, "phone", "me"), "me tab again");
  expect(v.texts("[data-nav-pages=me] [data-me-entry=manage]")).toEqual(["退出多选"]);
  await v.click(v.host.querySelector("[data-nav-pages=me] [data-me-entry=settings]"), "settings");
  await v.until(() => v.bodyText().includes("外观"), "settings modal");
  await v.unmount();
});

test("[验收线 2] 1280 竖向图标栏五个入口有字、冷开在「会话」；顶栏没有原来的无字图标；点今天 / 项目 / 团队换侧栏内容", async () => {
  const v = await dom.mount(1280);
  await v.until(() => v.texts("[data-nav=rail] [data-nav-tab]").length === 5, "rail");
  expect(v.texts("[data-nav=rail] [data-nav-tab]")).toEqual(["2今天", "项目", "4会话", "团队", "我的"]);
  expect(v.host.querySelector("[data-nav=phone]")).toBeNull();
  expect(page(v)).toBeNull();
  const head = v.host.querySelector("aside > div:nth-of-type(2)")!;
  for (const label of [...ALL_ME, "多选管理（批量删除）", "Peer 协作"]) expect(head.querySelector(`[aria-label='${label}'], [title='${label}']`)).toBeNull();
  expect(head.querySelector("svg circle[r='3']")).toBeNull(); // 原来内联的设置齿轮
  await v.click(tab(v, "rail", "today"), "today");
  await v.until(() => v.all("[data-nav-pages=today] [data-now-blocks]").length === 1, "compact today");
  await v.click(tab(v, "rail", "projects"), "projects");
  await v.until(() => v.all("[data-nav-pages=projects] [data-now-project]").length === 4, "projects page");
  await v.click(tab(v, "rail", "team"), "team");
  await v.until(() => v.all(`[data-nav-pages=team] button[aria-label='${TEAM_NAME}']`).length === 1, "team page");
  await v.click(tab(v, "rail", "sessions"), "sessions");
  expect(page(v)).toBeNull();
  await v.unmount();
});

test("[验收线 2][验收线 3] 1280「我的」菜单：条目与出现条件同原顶栏；点新终端 / 用量看板 / 项目管理打开原来的面板", async () => {
  opts.shells = 200;
  const v = await dom.mount(1280);
  const open = async () => {
    await v.click(tab(v, "rail", "me"), "me");
    await v.until(() => v.all("[role=menu] [data-me-entry]").length > 0, "me menu");
  };
  await v.until(() => !!tab(v, "rail", "me"), "rail me");
  await dom.tick(200); // 联系人（全权判定）与 /shells 回包
  const run = async (id: string, opened: () => boolean) => {
    await open();
    expect(meLabels(v, "[role=menu]")).toEqual(ALL_ME);
    await v.click(v.all(`[role=menu] [data-me-entry=${id}]`)[0], id);
    expect(v.all("[role=menu]")).toHaveLength(0); // 点了就收菜单
    await v.until(opened, `${id} opened`);
  };
  await run("shell", () => v.bodyText().includes("在这台机器上开一个 shell"));
  await run("stats", () => v.bodyText().includes("各会话上下文占用"));
  await run("projectAdmin", () => v.bodyText().includes("新建 project"));
  await v.unmount();
});

test("[验收线 2] 非全权设备不出管理类，shells 403 不出新终端", async () => {
  opts.full = false;
  opts.shells = 403;
  const v = await dom.mount(1280);
  await dom.tick(200);
  await v.click(tab(v, "rail", "me"), "me");
  await v.until(() => v.all("[role=menu] [data-me-entry]").length > 0, "me menu");
  expect(meLabels(v, "[role=menu]")).toEqual(["设置", "图片与文件"]);
  await v.unmount();
});
