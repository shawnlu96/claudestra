import { describe, expect, test } from "bun:test";
import {
  DORMANT_MS,
  buildSidebarEntries,
  buildTeams,
  directCount,
  entryMembers,
  filterAndRankWorkers,
  isDormantAgent,
  splitDormant,
  splitMasterKids,
} from "@/features/chat/sidebar-entries";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";

const NOW = 1_800_000_000_000;
const ag = (name: string, p: Partial<AgentSession> = {}): AgentSession =>
  ({
    name,
    displayName: name,
    purpose: "",
    status: "active",
    lastActivityTs: NOW - 1000,
    ...p,
  }) as AgentSession;
const names = (xs: AgentSession[]) => xs.map((a) => a.name);
/** 行 = 名字，挂了执行者的行 = 名字{子,子}；组 = [id:顶层节点…] */
const node = (n: { a: AgentSession; children: AgentSession[] }) => (n.children.length ? `${n.a.name}{${names(n.children).join(",")}}` : n.a.name);
const shape = (es: ReturnType<typeof buildSidebarEntries>) =>
  es.map((e) => (e.kind === "row" ? node(e) : `[${e.id}:${e.nodes.map(node).join(",")}]`));

describe("filterAndRankWorkers（侧栏排序）", () => {
  test("只按置顶分层，层内保持原（最近活动）顺序", () => {
    const ws = [ag("a"), ag("b"), ag("c"), ag("d")];
    expect(names(filterAndRankWorkers(ws, "", new Set(["c"])))).toEqual(["c", "a", "b", "d"]);
  });
  test("未读不参与排序（2026-09-16 撤回的那条：有未读的不许跳到顶）", () => {
    const ws = [ag("a"), ag("b", { unread: 5 } as Partial<AgentSession>), ag("c")];
    expect(names(filterAndRankWorkers(ws, "", new Set()))).toEqual(["a", "b", "c"]);
  });
  test("搜索按 displayName / name / purpose 匹配（q 已小写）", () => {
    const ws = [ag("alpha", { purpose: "Web 前端" }), ag("beta", { displayName: "Car Talk" }), ag("gamma")];
    expect(names(filterAndRankWorkers(ws, "car", new Set()))).toEqual(["beta"]);
    expect(names(filterAndRankWorkers(ws, "web", new Set()))).toEqual(["alpha"]);
  });
  test("worker 从默认列表与名称搜索隐藏，store 仍保留它供直接打开", () => {
    const ws = [ag("pm"), ag("task-68", { kind: "worker", task: "T68 调度" }), ag("codex")];
    expect(names(filterAndRankWorkers(ws, "", new Set()))).toEqual(["pm", "codex"]);
    expect(names(filterAndRankWorkers(ws, "调度", new Set()))).toEqual([]);
    expect(names(ws)).toEqual(["pm", "task-68", "codex"]);
  });
  test("不改输入数组", () => {
    const ws = [ag("a"), ag("b")];
    filterAndRankWorkers(ws, "", new Set(["b"]));
    expect(names(ws)).toEqual(["a", "b"]);
  });
});

describe("buildSidebarEntries（project 分组）", () => {
  const meta = new Map<string, ProjectMeta>([["p1", { id: "p1", name: "P1", dirs: [] }]]);
  test("≥2 成员成组，组占最活跃成员的位次；单成员 project 不成组、平铺", () => {
    const ws = [ag("x"), ag("a", { projectId: "p1" }), ag("s", { projectId: "solo" }), ag("b", { projectId: "p1" })];
    expect(shape(buildSidebarEntries(ws, "", meta))).toEqual(["x", "[p1:a,b]", "s"]);
  });
  test("组带上 project 元数据", () => {
    const es = buildSidebarEntries([ag("a", { projectId: "p1" }), ag("b", { projectId: "p1" })], "", meta);
    expect(es[0].kind === "group" && es[0].meta?.name).toBe("P1");
  });
  test("搜索时不分组（返回空，调用方直接渲染过滤结果）", () => {
    expect(buildSidebarEntries([ag("a", { projectId: "p1" }), ag("b", { projectId: "p1" })], "a", meta)).toEqual([]);
  });
});

describe("沉寂（💤）", () => {
  test("isDormantAgent：>30 天没动静；从未说话则看是否已停止；忙碌永不算", () => {
    expect(isDormantAgent(ag("a", { lastActivityTs: NOW - DORMANT_MS - 1 }), NOW)).toBe(true);
    expect(isDormantAgent(ag("a", { lastActivityTs: NOW - DORMANT_MS + 1 }), NOW)).toBe(false);
    expect(isDormantAgent(ag("a", { lastActivityTs: null, status: "stopped" }), NOW)).toBe(true);
    expect(isDormantAgent(ag("a", { lastActivityTs: null, status: "active" }), NOW)).toBe(false);
    expect(isDormantAgent(ag("a", { lastActivityTs: NOW - DORMANT_MS * 2, busy: true }), NOW)).toBe(false);
  });
  test("整组全员沉寂才下沉；有一个活跃成员就整组留在上面", () => {
    const old = NOW - DORMANT_MS * 2;
    const ws = [
      ag("a", { projectId: "p1", lastActivityTs: old }),
      ag("b", { projectId: "p1" }),
      ag("c", { projectId: "p2", lastActivityTs: old }),
      ag("d", { projectId: "p2", lastActivityTs: old }),
      ag("e", { lastActivityTs: old }),
    ];
    const { activeEntries, dormantEntries } = splitDormant(buildSidebarEntries(ws, "", new Map()), NOW);
    expect(shape(activeEntries)).toEqual(["[p1:a,b]"]);
    expect(shape(dormantEntries)).toEqual(["[p2:c,d]", "e"]);
  });
});

describe("派发关系构树（parent → 执行者挂在派发者下面）", () => {
  const MASTER = "__master__";
  const meta = new Map<string, ProjectMeta>();
  const build = (ws: AgentSession[], masterName?: string) => shape(buildSidebarEntries(ws, "", meta, masterName));
  test("父子：执行者挂在派发者下面，同 project 的其他 agent 照常平铺；组头按顶层节点数算", () => {
    const ws = [
      ag("t1", { projectId: "p", parent: "pm" }),
      ag("codex", { projectId: "p" }),
      ag("pm", { projectId: "p" }),
      ag("t3", { projectId: "p", parent: "pm" }),
    ];
    // 组占最活跃成员（t1）的位次，节点序同理：pm 这组排在 codex 前面
    expect(build(ws)).toEqual(["[p:pm{t1,t3},codex]"]);
  });
  test("组头计数：只有派发者 + 执行者 = 1 个顶层节点 → 不出组头，整棵挂在一行上", () => {
    const ws = [ag("pm", { projectId: "p" }), ag("t1", { projectId: "p", parent: "pm" }), ag("t3", { projectId: "p", parent: "pm" })];
    expect(build(ws)).toEqual(["pm{t1,t3}"]);
  });
  test("父已停止：照样挂着", () => {
    const ws = [ag("pm", { status: "stopped", lastActivityTs: null }), ag("t1", { parent: "pm" })];
    expect(build(ws)).toEqual(["pm{t1}"]);
  });
  test("父不在列表（remove / 归档）：执行者回到自己的 project 下平铺", () => {
    const ws = [ag("t1", { projectId: "p", parent: "gone" }), ag("x", { projectId: "p" })];
    expect(build(ws)).toEqual(["[p:t1,x]"]);
  });
  test("父在调用方 scope 外：bridge 不下发 parent → 执行者在自己的 project 下平铺，不挂任何人", () => {
    // 派发者 pm 在 project q、scope 外看不到；t1 / t2 属于 p
    const ws = [ag("t1", { projectId: "p", parent: null }), ag("t2", { projectId: "p" })];
    expect(build(ws)).toEqual(["[p:t1,t2]"]);
  });
  test("跨 project：执行者跟着派发者走（进派发者所在的组）", () => {
    const ws = [ag("t1", { projectId: "other", parent: "pm" }), ag("pm", { projectId: "p" }), ag("x", { projectId: "p" })];
    expect(build(ws)).toEqual(["[p:pm{t1},x]"]);
  });
  test("大总管下挂：单独拿出来（顶部卡片下），不进项目列表；大总管不在列表时当没有 parent", () => {
    const ws = [ag("t1", { parent: MASTER }), ag("t1a", { parent: "t1" }), ag("x")];
    expect(build(ws, MASTER)).toEqual(["x"]);
    expect(names(buildTeams(ws, MASTER).underMaster)).toEqual(["t1", "t1a"]);
    expect(build(ws)).toEqual(["t1{t1a}", "x"]);
  });
  test("只挂一层：孙辈也平铺进顶层派发者这一组", () => {
    const ws = [ag("pm"), ag("t1", { parent: "pm" }), ag("t1a", { parent: "t1" })];
    expect(build(ws)).toEqual(["pm{t1,t1a}"]);
  });
  test("成环：环上的都当没有 parent；挂在环成员下面的照常挂", () => {
    const ws = [ag("a", { parent: "b" }), ag("b", { parent: "a" }), ag("c", { parent: "a" }), ag("s", { parent: "s" })];
    expect(build(ws)).toEqual(["a{c}", "b", "s"]);
  });
  test("沉寂整组判断：执行者还活跃，沉寂的派发者这一组不下沉；全员沉寂才下沉", () => {
    const old = NOW - DORMANT_MS * 2;
    const ws = [ag("t1", { parent: "pm" }), ag("pm", { lastActivityTs: old }), ag("q", { lastActivityTs: old }), ag("q1", { parent: "q", lastActivityTs: old })];
    const { activeEntries, dormantEntries } = splitDormant(buildSidebarEntries(ws, "", meta), NOW);
    expect(shape(activeEntries)).toEqual(["pm{t1}"]);
    expect(shape(dormantEntries)).toEqual(["q{q1}"]);
    expect(names(entryMembers(dormantEntries[0]))).toEqual(["q", "q1"]);
  });
  test("搜索：平铺不挂树，任务名参与匹配", () => {
    const ws = [ag("pm"), ag("t1", { parent: "pm", task: "T1 沙箱隔离" }), ag("t3", { parent: "pm", task: "T3 值守卡片" })];
    expect(names(filterAndRankWorkers(ws, "沙箱", new Set()))).toEqual(["t1"]);
    expect(buildSidebarEntries(ws, "沙箱", meta)).toEqual([]);
  });
  test("「派出 N」只数直接派出的：提升上来的孙辈不算", () => {
    const ws = [ag("pm"), ag("t1", { parent: "pm" }), ag("t1a", { parent: "t1" })];
    const [n] = buildTeams(ws).nodes;
    expect(directCount(n.a.name, n.children)).toBe(1);
    expect(directCount(MASTER, [ag("h", { parent: MASTER }), ag("h1", { parent: "h" })])).toBe(1);
  });
  test("大总管下挂也走沉寂：沉寂的收进底部，当普通行", () => {
    const old = NOW - DORMANT_MS * 2;
    const kids = [ag("h"), ag("z", { lastActivityTs: old })];
    const { awake, dormantRows } = splitMasterKids(kids, NOW);
    expect(names(awake)).toEqual(["h"]);
    expect(shape(dormantRows)).toEqual(["z"]);
    expect(shape(splitDormant(dormantRows, NOW).dormantEntries)).toEqual(["z"]);
  });
  test("普通 agent（大总管建的常驻 agent，没有 parent）留在自己的项目组里", () => {
    const ws = [ag("codex", { projectId: "p" }), ag("relay", { projectId: "p" }), ag("t1", { projectId: "p", parent: "codex" })];
    expect(build(ws, MASTER)).toEqual(["[p:codex{t1},relay]"]);
    expect(buildTeams(ws, MASTER).underMaster).toEqual([]);
  });
  test("置顶只作用于顶层行：被置顶的执行者不把整组拽上去，留在派发者下面", () => {
    const ws = [ag("x"), ag("pm"), ag("t1", { parent: "pm" })];
    const ranked = filterAndRankWorkers(ws, "", new Set(["t1"]));
    expect(names(ranked)).toEqual(["x", "pm", "t1"]);
    expect(build(ranked)).toEqual(["x", "pm{t1}"]);
    // 置顶派发者 = 整组上去
    expect(build(filterAndRankWorkers(ws, "", new Set(["pm"])))).toEqual(["pm{t1}", "x"]);
  });
});
