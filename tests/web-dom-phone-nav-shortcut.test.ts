/**
 * NAVBAR1 第 1 轮审查两条 P1 的复现（先红后绿）：
 * - team-shortcut：团队页「成员与位子」「规划与提案」在同一项目的协作视图已挂着时也要切过去（连续点、切到别的标签后再点、手机返回列表后再点）。
 *   协作视图换成探针：按 collab-nav 的项目 key 挂（同 CollabSwitch），里面是真的 useDagUi 标签状态和真的 TeamTabs。
 * - unread-total：导航「会话」角标 = 全部会话未读（夹具 b-pm 3 + d-dev 1），不随搜索清零，搜索不到的会话也算。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { navDom, type NavDomView, TEAM_NAME } from "./helpers/nav-shots";

const resetNavTab = () => (require("../web/features/nav/nav-tab.ts") as { resetNavTab(): void }).resetNavTab();
let dom: Awaited<ReturnType<typeof navDom>>;
beforeAll(async () => { dom = await navDom({}, () => ({
  sidebar: require("../web/features/chat/components/sidebar.tsx"), store: require("../web/features/chat/chat-store.ts"),
  nav: require("../web/features/chat/components/nav-context.tsx"), asks: require("../web/features/asks/asks-store.ts"),
  collab: require("../web/features/collab/collab-nav.ts"), entry: require("../web/features/collab/team-view-entry.tsx"),
  contacts: require("../web/features/chat/contacts-data.ts"), collabEntry: require("../web/features/collab/collab-entry.tsx"),
})); });
afterEach(async () => {
  await dom.cleanup();
  await dom.React.act(async () => resetNavTab());
  (require("../web/features/nav/collab-tab-hint.ts") as { takeCollabTab(): unknown }).takeCollabTab(); // 没被取走的提示不串到下一条
});
afterAll(async () => dom.dispose());

type Ui = { tab: string; setTab(t: string): void };
/** 协作视图探针：project 变了整棵重挂（CollabSwitch 的 key），标签状态用真的 useDagUi，团队标签用真的 TeamTabs */
function collabProbe(ui: { current: Ui | null }) {
  const h = dom.React.createElement as (...a: unknown[]) => unknown;
  const { useCollabNav } = require("../web/features/collab/collab-nav.ts") as { useCollabNav(): { project: string | null } };
  const { useDagUi } = require("../web/features/collab/dag/use-dag-ui.ts") as { useDagUi(f: unknown[]): Ui };
  const { TeamTabs } = require("../web/features/collab/team/team-tabs.tsx") as { TeamTabs: unknown };
  const none: unknown[] = [];
  function View() {
    const u = useDagUi(none);
    ui.current = u;
    return h("div", { "data-probe-tab": u.tab }, u.tab === "team" ? h(TeamTabs, { members: "MEMBERS_BODY", ops: "OPS_BODY", flow: null }) : null);
  }
  return function Collab() {
    const project = useCollabNav().project;
    return project ? h(View, { key: project }) : null;
  };
}

const shown = (v: NavDomView) => v.all("[data-probe-tab] [role=tabpanel]").filter((p) => !p.hasAttribute("hidden")).map((p) => p.textContent);
const probeTab = (v: NavDomView) => v.host.querySelector("[data-probe-tab]")?.getAttribute("data-probe-tab") ?? null;
const link = (v: NavDomView, tab: string) => v.host.querySelector(`[data-team-link=${tab}]`);

test("[验收线 2] team-shortcut：同一项目已开着时，连续点「成员与位子」「规划与提案」、切走标签再点、返回列表再点都切过去", async () => {
  const ui = { current: null as Ui | null };
  const v = await dom.mount(1280, collabProbe(ui));
  await v.click(v.host.querySelector("[data-nav=rail] [data-nav-tab=team]"), "team tab");
  await v.until(() => !!link(v, "members") && !link(v, "members")!.hasAttribute("aria-disabled"), "team links enabled");
  await v.click(link(v, "members"), "members");
  expect([probeTab(v), shown(v)]).toEqual(["team", ["MEMBERS_BODY"]]);
  const opened = v.seen.open;
  await v.click(link(v, "ops"), "ops");
  expect(v.seen.open).toBe(opened); // 同一项目：视图没重挂
  expect(shown(v)).toEqual(["OPS_BODY"]);
  await dom.React.act(async () => ui.current!.setTab("overview"));
  expect(probeTab(v)).toBe("overview");
  await v.click(link(v, "members"), "members again");
  expect([probeTab(v), shown(v)]).toEqual(["team", ["MEMBERS_BODY"]]);
  await v.unmount();
});

test("[验收线 1] team-shortcut：手机进了协作视图再返回列表（视图仍挂着），从团队页点「规划与提案」照样切到那一栏", async () => {
  const ui = { current: null as Ui | null };
  const v = await dom.mount(390, collabProbe(ui));
  await v.click(v.host.querySelector("[data-nav=phone] [data-nav-tab=team]"), "team tab");
  const row = () => v.host.querySelector(`[data-nav-pages=team] section[aria-label='团队项目'] button[aria-label='${TEAM_NAME}']`);
  await v.until(() => !!row() && !row()!.hasAttribute("aria-disabled") && !!link(v, "ops") && !link(v, "ops")!.hasAttribute("aria-disabled"), "team row");
  await v.click(row(), "team row"); // 点行进协作视图；同一项目上次停的标签会被记住（PROJTABS1），先切回总览
  await dom.React.act(async () => ui.current!.setTab("overview"));
  expect(probeTab(v)).toBe("overview");
  const before = v.seen.toContent;
  await v.click(link(v, "ops"), "ops");
  expect(v.seen.toContent).toBe(before + 1);
  expect([probeTab(v), shown(v)]).toEqual(["team", ["OPS_BODY"]]);
  await v.unmount();
});

test("[验收线 1] unread-total：「会话」角标是全部会话未读，搜索后切到别的入口不清零、搜不到的 d-dev 也算", async () => {
  const v = await dom.mount(390);
  const badge = () => v.texts("[data-nav=phone] [data-nav-tab=sessions]")[0];
  await v.until(() => badge() === "4会话", "unread badge");
  await v.click(v.host.querySelector("[data-nav=phone] [data-nav-tab=sessions]"), "sessions tab");
  const search = v.host.querySelector("aside input[type=search]");
  const g = globalThis as unknown as { HTMLInputElement: { prototype: object }; Event: new (t: string, o: object) => unknown };
  await dom.React.act(async () => {
    Object.getOwnPropertyDescriptor(g.HTMLInputElement.prototype, "value")!.set!.call(search, "b-pm");
    (search as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new g.Event("input", { bubbles: true }));
  });
  await dom.tick(50);
  expect(badge()).toBe("4会话");
  await v.click(v.host.querySelector("[data-nav=phone] [data-nav-tab=projects]"), "projects tab");
  expect(badge()).toBe("4会话");
  await v.unmount();
});
