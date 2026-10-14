/**
 * UXHOME1：侧栏「团队」区只删重复的行（web/features/collab/shared-projects/grouped-projects.ts）。
 * 哪些项目成组用 sidebar.tsx 真正在用的 buildSidebarDirectory 算，不在测试里另写一套成组规则。
 */
import { expect, test } from "bun:test";
import { buildSidebarDirectory } from "@/features/chat/sidebar-history";
import { filterAndRankWorkers } from "@/features/chat/sidebar-entries";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";
import { groupedProjectIds, teamAreaProjects } from "@/features/collab/shared-projects/grouped-projects";
import type { ProjectSnapshot, SharedProject } from "@/lib/shared-projects-model";

const agent = (name: string, projectId: string, over: Partial<AgentSession> = {}): AgentSession =>
  ({ name, displayName: name, purpose: "", cwd: "/repo", status: "active", projectId, ...over });
const AGENTS = [agent("a1", "team-group"), agent("a2", "team-group"), agent("b1", "team-solo"), agent("c1", "local-group"), agent("c2", "local-group"), agent("d1", "local-solo")];
const META = new Map<string, ProjectMeta>(["team-group", "team-solo", "local-group", "local-solo"].map((id) => [id, { id, name: id, dirs: [] }]));
const shared = (projectId: string, local: string | null, over: Partial<SharedProject> = {}): SharedProject => ({ centerId: "c1", teamId: "t1", projectId, name: `团队 ${projectId}`,
  rev: 1, status: "active", role: "member", local: local ? { id: local, name: local, dirs: [] } : null, availability: "ready", personId: "p1", instanceId: "inst-a", ...over });
const SNAPSHOT: ProjectSnapshot = { teams: [], localProjects: [], peers: [],
  projects: [shared("center-group", "team-group"), shared("center-solo", "team-solo"), shared("center-unbound", null), shared("center-pending", "local-solo", { availability: "pending" })] };

/** 同 sidebar.tsx：搜索时传空列表（不成组），否则是过滤排序后的会话 */
const entries = (q: string, agents = AGENTS) => buildSidebarDirectory(q ? [] : filterAndRankWorkers(agents, q, new Set()), META).activeEntries;
const rows = (q: string, agents = AGENTS) => teamAreaProjects(SNAPSHOT, groupedProjectIds(entries(q, agents))).map((p) => p.projectId);

test("[验收线 4] 已成组的绑定项目不在团队区重复出现，单成员绑定项目的行仍在；没绑定 / 还没就绪的本来就不列", () => {
  expect([...groupedProjectIds(entries(""))].sort()).toEqual(["local-group", "team-group"]);
  expect(rows("")).toEqual(["center-solo"]);
});

test("[验收线 4] 搜索时侧栏不成组，团队区列出全部行；不给条目（合成夹具）也是全部", () => {
  expect(rows("a1")).toEqual(["center-group", "center-solo"]);
  expect(teamAreaProjects(SNAPSHOT, groupedProjectIds()).map((p) => p.projectId)).toEqual(["center-group", "center-solo"]);
});

test("成组只看此刻活着的会话：组里只剩一个活会话（另一个已停）就不成组，团队区的行回来", () => {
  const stopped = AGENTS.map((a) => (a.name === "a2" ? { ...a, status: "stopped" as const } : a));
  expect(rows("", stopped)).toEqual(["center-group", "center-solo"]);
  expect(rows("", [])).toEqual(["center-group", "center-solo"]);
});
