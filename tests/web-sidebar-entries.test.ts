import { describe, expect, test } from "bun:test";
import {
  DORMANT_MS,
  buildSidebarEntries,
  filterAndRankWorkers,
  isDormantAgent,
  splitDormant,
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
const shape = (es: ReturnType<typeof buildSidebarEntries>) =>
  es.map((e) => (e.kind === "row" ? e.a.name : `[${e.id}:${names(e.items).join(",")}]`));

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
