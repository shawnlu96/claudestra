import { describe, expect, test } from "bun:test";
import { buildAgentMenu, moveTargets } from "@/features/chat/agent-menu";
import { beginAgentDrag, currentDrag, dropTarget, endAgentDrag } from "@/features/chat/sidebar-dnd";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";

const ag = (name: string, p: Partial<AgentSession> = {}): AgentSession =>
  ({ name, displayName: name, purpose: "", status: "active", projectId: "a", ...p }) as AgentSession;
const pj = (id: string, name = id, emoji?: string): ProjectMeta => ({ id, name, emoji, dirs: [] });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("buildAgentMenu（侧栏右键 / 长按菜单内容）", () => {
  test("运行中：重启 / 停止 / 清空 / 移动到 / 归档，停止标红，移动到带二级", () => {
    const items = buildAgentMenu(ag("w"))!;
    expect(ids(items)).toEqual(["restart", "kill", "clear", "move", "archive"]);
    expect(items.find((i) => i.id === "kill")?.danger).toBe(true);
    expect(items.find((i) => i.id === "move")?.submenu).toBe(true);
  });
  test("已停止：启动 / 移动到 / 归档——没有停止和清空", () => {
    expect(ids(buildAgentMenu(ag("w", { status: "stopped" }))!)).toEqual(["start", "move", "archive"]);
  });
  test("大总管 / mock 没有菜单", () => {
    expect(buildAgentMenu(ag("m", { pinnedMaster: true }))).toBeNull();
    expect(buildAgentMenu(ag("k", { mock: true }))).toBeNull();
  });
});

describe("moveTargets（移动到的候选）", () => {
  const projects = [pj("b", "乙"), pj("a", "甲"), pj("c", "丙")];
  test("排除当前所属，按显示名排序", () => {
    expect(ids(moveTargets(ag("w", { projectId: "a" }), projects))).toEqual(["c", "b"]);
  });
  test("未分组 agent 可选全部", () => {
    expect(ids(moveTargets(ag("w", { projectId: null }), projects))).toHaveLength(3);
  });
  test("不改原数组顺序", () => {
    moveTargets(ag("w"), projects);
    expect(ids(projects)).toEqual(["b", "a", "c"]);
  });
});

describe("dropTarget（拖到哪里算改 project）", () => {
  const d = { name: "agent-w", projectId: "a" };
  test("拖到别的 project 组头 → 该 project", () => {
    expect(dropTarget(d, { projectId: "b" })).toBe("b");
  });
  test("拖到别的 project 的 agent 行 → 那个 project", () => {
    expect(dropTarget(d, { projectId: "b", agentName: "agent-x" })).toBe("b");
  });
  test("同 project / 自己 / 无归属目标 / 没在拖 → 不可放", () => {
    expect(dropTarget(d, { projectId: "a" })).toBeNull();
    expect(dropTarget(d, { projectId: "b", agentName: "agent-w" })).toBeNull();
    expect(dropTarget(d, { projectId: null })).toBeNull();
    expect(dropTarget(d, {})).toBeNull();
    expect(dropTarget(null, { projectId: "b" })).toBeNull();
  });
  test("模块级拖拽态：begin / current / end", () => {
    expect(currentDrag()).toBeNull();
    beginAgentDrag(d);
    expect(currentDrag()).toEqual(d);
    endAgentDrag();
    expect(currentDrag()).toBeNull();
  });
});
