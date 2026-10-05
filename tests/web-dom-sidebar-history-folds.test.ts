/**
 * followup-reliability-SBH2：活目录与历史目录的折叠偏好分开保存。真挂载 SidebarDirectory + ProjectGroup + TeamGroup + HistoryFold
 * （happy-dom + React 19，guard TESTS_WEB_DOM），localStorage 用 happy-dom 自带的持久对象，卸载再挂 = 刷新。
 * 同一 project id 同时出现在活目录与历史目录里：两组各自开合、各自记住；活目录沿用原 key（老偏好不丢），历史目录另起命名空间。
 * 拖拽 / 菜单 / 协作入口跟本卡无关，换成空壳。纯逻辑见 tests/web-sidebar-history.test.ts。
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SidebarEntry, TeamNode } from "../web/features/chat/sidebar-entries";
import type { AgentSession } from "../web/features/chat/type";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; getAttribute(n: string): string | null; click(): void; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: El & { appendChild(c: Host): void } }
interface Folds { projects: Set<string>; toggleProject(id: string): void; teams: Set<string>; toggleTeam(id: string): void }

// mock.module 对整个 bun test 进程生效：先取真模块再只覆盖用到的导出，别让后面的文件拿到缺导出的空壳
const partial = async (path: string, over: Record<string, unknown>) => {
  const real = await import(path);
  mock.module(path, () => ({ ...real, ...over }));
};
await partial("@/features/chat/contacts-data", { useFullScope: () => false });
await partial("@/features/chat/host-info", { useHostInfo: () => ({ local: false, platform: "darwin", openers: [] }) });
await partial("@/features/chat/components/agent-dnd", { useAgentDrop: () => ({ over: false, handlers: {} }) });
await partial("@/features/collab/collab-entry", { CollabEntry: () => null });

const mod = (p: string) => new URL(`../web/features/chat/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; clear(): void; readonly length: number; key(i: number): string | null };
let ui: {
  SidebarDirectory: unknown; useDirectoryFolds: (s: "active" | "history") => Folds;
  ProjectGroup: unknown; TeamGroup: unknown;
  buildSidebarDirectory: typeof import("../web/features/chat/sidebar-history").buildSidebarDirectory;
  isHistoryAgent: typeof import("../web/features/chat/sidebar-history").isHistoryAgent;
  filterAndRankWorkers: typeof import("../web/features/chat/sidebar-entries").filterAndRankWorkers;
};

const NOW = 1_800_000_000_000;
const ag = (name: string, p: Partial<AgentSession> = {}): AgentSession =>
  ({ name, displayName: name, purpose: "", status: "active", lastActivityTs: NOW - 1000, projectId: "p", ...p }) as AgentSession;
/** 同一个 project p：活的 lead→kid + dev，停掉的 old→oldkid + olddev；另有 creating 新会话 */
const AGENTS = [
  ag("lead"), ag("kid", { parent: "lead" }), ag("dev"), ag("fresh", { status: "creating", lastActivityTs: null }),
  ag("old", { status: "stopped" }), ag("oldkid", { status: "stopped", parent: "old" }), ag("olddev", { status: "stopped" }),
];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  storage = (globalThis as unknown as { localStorage: typeof storage }).localStorage;
  const dir = await import(mod("components/sidebar-history.tsx"));
  const pg = await import(mod("components/project-group.tsx"));
  const tg = await import(mod("components/team-group.tsx"));
  const sh = await import(mod("sidebar-history.ts"));
  const se = await import(mod("sidebar-entries.ts"));
  ui = { SidebarDirectory: dir.SidebarDirectory, useDirectoryFolds: dir.useDirectoryFolds, ProjectGroup: pg.ProjectGroup, TeamGroup: tg.TeamGroup,
    buildSidebarDirectory: sh.buildSidebarDirectory, isHistoryAgent: sh.isHistoryAgent, filterAndRankWorkers: se.filterAndRankWorkers };
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

beforeEach(() => storage.clear()); // 只清测试自己的 happy-dom 存储，不碰真实浏览器

/** 与 sidebar.tsx renderEntry 同形：组头 / 派发者开合按传入的 folds 走 */
function Harness() {
  const h = React.createElement;
  const activeFolds = ui.useDirectoryFolds("active");
  const d = ui.buildSidebarDirectory(AGENTS, new Map());
  const row = (a: AgentSession, s?: { lead?: unknown }) => h("li", { key: a.name, "data-agent": a.name }, (s?.lead as never) ?? null, a.name);
  const team = (n: TeamNode, f: Folds) =>
    h(ui.TeamGroup as never, { key: `t:${n.a.name}`, node: n, collapsed: f.teams.has(n.a.name), busy: false, onToggle: () => f.toggleTeam(n.a.name), row });
  const renderEntry = (e: SidebarEntry, f: Folds) => e.kind === "row" ? team(e, f)
    : h(ui.ProjectGroup as never, { key: `g:${e.id}`, e, collapsed: f.projects.has(e.id), groupBusy: false, onToggle: () => f.toggleProject(e.id) },
      e.nodes.map((n) => team(n, f)));
  return h(ui.SidebarDirectory as never, { activeEntries: d.activeEntries, historyEntries: d.historyEntries, historyCount: d.historyCount, activeFolds, renderEntry });
}

async function mount() {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(Harness)));
  const all = () => Array.from(host.querySelectorAll("button"));
  /** 组头按钮：文本以 project id 开头（无 meta 时显示 id）；第 0 个在活目录，第 1 个在历史目录 */
  const heads = () => all().filter((b) => /^(📁|📂)p\d/.test((b.textContent ?? "").trim()));
  const historyBtn = () => all().find((b) => (b.textContent ?? "").includes("历史"))!;
  const teamBtn = (name: string) => host.querySelector(`[data-agent="${name}"] button[aria-expanded]`);
  return {
    shown: () => Array.from(host.querySelectorAll("[data-agent]")).map((e) => e.getAttribute("data-agent")),
    heads,
    click: async (b: El | null) => { await React.act(async () => b!.click()); },
    historyBtn, teamBtn,
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

test("同一 project 的活 / 历史两组各自折叠，刷新后各自保持", async () => {
  let ui1 = await mount();
  await ui1.click(ui1.historyBtn());
  expect(ui1.heads()).toHaveLength(2);
  expect(ui1.shown()).toEqual(["lead", "kid", "dev", "fresh", "old", "oldkid", "olddev"]);
  // 折叠历史组：活组不受影响
  await ui1.click(ui1.heads()[1]);
  expect(ui1.shown()).toEqual(["lead", "kid", "dev", "fresh"]);
  // 再折叠活组、展开历史组：互不牵连
  await ui1.click(ui1.heads()[0]);
  await ui1.click(ui1.heads()[1]);
  expect(ui1.shown()).toEqual(["old", "oldkid", "olddev"]);
  await ui1.unmount();
  // 刷新：活组仍收起、历史组仍展开
  ui1 = await mount();
  expect(ui1.shown()).toEqual(["old", "oldkid", "olddev"]);
  expect(JSON.parse(storage.getItem("cstra_proj_collapsed")!)).toEqual(["p"]);
  expect(JSON.parse(storage.getItem("cstra_history_proj_collapsed")!)).toEqual([]);
  await ui1.unmount();
});

test("历史里的派发者折叠只写历史命名空间，活目录的派发者照旧", async () => {
  const u = await mount();
  await u.click(u.historyBtn());
  await u.click(u.teamBtn("old"));
  expect(u.shown()).toEqual(["lead", "kid", "dev", "fresh", "old", "olddev"]);
  expect(storage.getItem("cstra_team_collapsed")).toBeNull();
  expect(JSON.parse(storage.getItem("cstra_history_team_collapsed")!)).toEqual(["old"]);
  await u.click(u.teamBtn("lead"));
  expect(u.shown()).toEqual(["lead", "dev", "fresh", "old", "olddev"]);
  expect(JSON.parse(storage.getItem("cstra_team_collapsed")!)).toEqual(["lead"]);
  await u.unmount();
});

test("升级前存下的活目录偏好原样生效，不被清也不被搬到历史；其它 key 不动", async () => {
  storage.setItem("cstra_proj_collapsed", JSON.stringify(["p", "other"]));
  storage.setItem("cstra_team_collapsed", JSON.stringify(["lead"]));
  storage.setItem("cstra_directory_history_open", JSON.stringify(["all"]));
  storage.setItem("cstra_pinned", JSON.stringify(["dev"]));
  const before = new Map(Array.from({ length: storage.length }, (_, i) => storage.key(i)!).map((k) => [k, storage.getItem(k)]));
  const u = await mount();
  // 活组按老偏好收起；历史组没有老偏好，默认展开（老偏好不会串过去把历史也收起）
  expect(u.shown()).toEqual(["old", "oldkid", "olddev"]);
  for (const [k, v] of before) expect(storage.getItem(k)).toBe(v);
  expect(storage.getItem("cstra_history_proj_collapsed")).toBeNull();
  await u.unmount();
});

test("active / creating 默认可达，stopped 仍可搜索 / 在历史里找到", async () => {
  const u = await mount();
  expect(u.shown()).toEqual(["lead", "kid", "dev", "fresh"]);
  expect(u.historyBtn().textContent).toContain("3");
  await u.click(u.historyBtn());
  expect(u.shown()).toContain("olddev");
  await u.unmount();
  expect(ui.filterAndRankWorkers(AGENTS, "olddev", new Set()).map((a) => a.name)).toEqual(["olddev"]);
  expect(AGENTS.filter(ui.isHistoryAgent).map((a) => a.name)).toEqual(["old", "oldkid", "olddev"]);
});
