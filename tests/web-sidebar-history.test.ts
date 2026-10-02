import { describe, expect, test } from "bun:test";
import {
  buildSidebarEntries,
  filterAndRankWorkers,
  splitDormant,
  type SidebarEntry,
} from "@/features/chat/sidebar-entries";
import {
  HISTORY_MS,
  dispatcherNames,
  historyCount,
  isDispatchedSession,
  isHistoryAgent,
  splitGroupHistory,
  splitTeamHistory,
} from "@/features/chat/sidebar-history";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const ag = (name: string, p: Partial<AgentSession> = {}): AgentSession =>
  ({ name, displayName: name, purpose: "", status: "active", lastActivityTs: NOW - 1000, ...p }) as AgentSession;
const names = (xs: AgentSession[]) => xs.map((a) => a.name);
type Group = Extract<SidebarEntry, { kind: "group" }>;
const groupOf = (list: AgentSession[], id = "p"): Group => {
  const es = buildSidebarEntries(list, "", new Map<string, ProjectMeta>());
  const g = es.find((e): e is Group => e.kind === "group" && e.id === id);
  if (!g) throw new Error("no group");
  return g;
};

describe("isHistoryAgent（判定）", () => {
  test("已停 25 小时 → 历史；已停 23 小时 → 不是", () => {
    expect(isHistoryAgent(ag("a", { status: "stopped", lastActivityTs: NOW - 25 * H }), NOW)).toBe(true);
    expect(isHistoryAgent(ag("a", { status: "stopped", lastActivityTs: NOW - 23 * H }), NOW)).toBe(false);
  });
  test("已停且从未说话：沉寂已经收了（isDormantAgent 的老规则），不重复进历史", () => {
    const never = ag("a", { status: "stopped", lastActivityTs: null });
    expect(isHistoryAgent(never, NOW)).toBe(false);
    expect(splitDormant([{ kind: "row", a: never, children: [] }], NOW).dormantEntries).toHaveLength(1);
  });
  test("派出会话活着但 25 小时没对话 → 历史（有派发者 / 审查执行前缀都算）", () => {
    const old = { lastActivityTs: NOW - 25 * H };
    expect(isHistoryAgent(ag("worker-x", { ...old, parent: "pm" }), NOW)).toBe(true);
    for (const n of ["review-cc-1", "rv-2", "review-cx-3", "agent-task-4", "agent-lend-5"]) {
      expect(isHistoryAgent(ag(n, old), NOW)).toBe(true);
    }
    // 前端去掉了 agent- 前缀的执行会话名(lib/chat/agents.ts)：task-f00d / lend-85a0d64ad2 也算；用户起的 lend-pm 不算
    expect(isHistoryAgent(ag("task-f00d", old), NOW)).toBe(true);
    expect(isHistoryAgent(ag("lend-85a0d64ad2", old), NOW)).toBe(true);
    expect(isHistoryAgent(ag("lend-pm", old), NOW)).toBe(false);
    // 活着、23 小时：还不是
    expect(isHistoryAgent(ag("review-1", { lastActivityTs: NOW - 23 * H }), NOW)).toBe(false);
    // 活着、刚建还没说话：不是
    expect(isHistoryAgent(ag("review-1", { lastActivityTs: null }), NOW)).toBe(false);
  });
  test("忙碌的派出会话 → 不是（停了也不是）", () => {
    expect(isHistoryAgent(ag("review-1", { busy: true, lastActivityTs: NOW - 25 * H }), NOW)).toBe(false);
    expect(isHistoryAgent(ag("review-1", { busy: true, status: "stopped", lastActivityTs: NOW - 25 * H }), NOW)).toBe(false);
  });
  test("PM / 大总管 / 普通 agent 活着闲 3 天 → 不是", () => {
    const idle = { lastActivityTs: NOW - 72 * H };
    const list = [ag("pm", { ...idle, parent: "__master__" }), ag("review-1", { parent: "pm" })];
    const ds = dispatcherNames(list);
    expect(isDispatchedSession(list[0], ds)).toBe(false); // 自己派了人 = PM，不按派出会话判
    expect(isHistoryAgent(list[0], NOW, ds)).toBe(false);
    expect(isHistoryAgent(ag("plain", idle), NOW)).toBe(false);
    expect(isHistoryAgent(ag("boss", { ...idle, pinnedMaster: true }), NOW)).toBe(false);
    // 停了就照第一条进历史
    expect(isHistoryAgent(ag("plain", { ...idle, status: "stopped" }), NOW)).toBe(true);
  });
  test(">30 天的仍进沉寂不进历史", () => {
    const old = ag("review-old", { status: "stopped", lastActivityTs: NOW - 31 * 24 * H });
    expect(isHistoryAgent(old, NOW)).toBe(false);
    const { activeEntries, dormantEntries } = splitDormant([{ kind: "row", a: old, children: [] }], NOW);
    expect(activeEntries).toHaveLength(0);
    expect(dormantEntries).toHaveLength(1);
  });
  test("边界常量 = 24 小时", () => {
    expect(HISTORY_MS).toBe(24 * H);
  });
});

describe("splitGroupHistory / splitTeamHistory（显示拆分）", () => {
  const stale = { status: "stopped" as const, lastActivityTs: NOW - 48 * H };
  const list = [
    ag("pm", { projectId: "p" }),
    ag("review-live", { projectId: "p", parent: "pm" }),
    ag("review-done", { projectId: "p", parent: "pm", ...stale }),
    ag("rv-done2", { projectId: "p", parent: "pm", lastActivityTs: NOW - 30 * H }),
    ag("dev", { projectId: "p" }),
    ag("old-solo", { projectId: "p", ...stale }),
    ag("review-busy", { projectId: "p", busy: true, lastActivityTs: NOW - 48 * H }),
  ];

  test("组头计数只算在用的；全收起的节点进组底历史", () => {
    const g = groupOf(list);
    expect(g.items).toHaveLength(7);
    const { e, history } = splitGroupHistory(g, NOW, dispatcherNames(list));
    expect(names(e.items).sort()).toEqual(["dev", "pm", "review-busy", "review-live"]);
    expect(e.nodes.map((n) => n.a.name)).toEqual(["pm", "dev", "review-busy"]);
    expect(history.map((n) => n.a.name)).toEqual(["old-solo"]);
    expect(historyCount(history)).toBe(1);
  });

  test("PM 卡片下的子列表：用完的执行者收进历史", () => {
    const g = groupOf(list);
    const pmNode = g.nodes.find((n) => n.a.name === "pm")!;
    const { node, history } = splitTeamHistory(pmNode, NOW, dispatcherNames(list));
    expect(names(node.children)).toEqual(["review-live"]);
    expect(names(history)).toEqual(["review-done", "rv-done2"]);
  });

  test("派发者和下挂的全收起 → 整个节点进组的历史，自身不再拆（历史里不套历史）", () => {
    const l2 = [
      ag("pm2", { projectId: "p", ...stale }),
      ag("review-a", { projectId: "p", parent: "pm2", ...stale }),
      ag("dev", { projectId: "p" }),
    ];
    const { e, history } = splitGroupHistory(groupOf(l2), NOW, dispatcherNames(l2));
    expect(names(e.items)).toEqual(["dev"]);
    expect(history.map((n) => n.a.name)).toEqual(["pm2"]);
    expect(historyCount(history)).toBe(2);
    const t = splitTeamHistory(history[0], NOW, dispatcherNames(l2));
    expect(t.history).toHaveLength(0);
    expect(names(t.node.children)).toEqual(["review-a"]);
  });

  test("整组沉寂的组（在「💤 沉寂」里）不拆", () => {
    const ancient = { status: "stopped" as const, lastActivityTs: NOW - 40 * 24 * H };
    const l3 = [ag("x", { projectId: "p", ...ancient }), ag("y", { projectId: "p", ...ancient })];
    const g = groupOf(l3);
    expect(splitDormant([g], NOW).dormantEntries).toHaveLength(1);
    const { e, history } = splitGroupHistory(g, NOW);
    expect(e.items).toHaveLength(2);
    expect(history).toHaveLength(0);
  });

  test("搜索：历史里的 agent 照样搜得到（搜索平铺，不折叠）", () => {
    const hits = filterAndRankWorkers(list, "review-done", new Set());
    expect(names(hits)).toEqual(["review-done"]);
    expect(isHistoryAgent(hits[0], NOW, dispatcherNames(list))).toBe(true);
    expect(buildSidebarEntries(hits, "review-done", new Map())).toHaveLength(0); // 有 q 时不分组 → 平铺渲染
  });
});
