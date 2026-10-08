/** UI port: bridge adapters supply explicit roles and bindings; names never establish identity. */
export interface ProjectScope { centerId: string; teamId: string }
export interface ProjectRef extends ProjectScope { projectId: string }
export interface SharedProject extends ProjectRef {
  name: string;
  rev: number;
  status: "active" | "archived";
  role: "owner" | "member" | null;
  local: { id: string; name: string; dirs: string[] } | null;
  availability: "ready" | "pending";
  operationId?: string;
  personId?: string;
  instanceId?: string;
}
/** Center team record without its code; `name` null means the center has no display name yet. */
export interface TeamRecord { name: string | null; rev: number }
export interface TeamDirectoryMember { personId: string; code: string; teamRole: "owner" | "member" }
/** `team` / `directory` null: the center team read is unavailable (old bridge or degraded read); never inferred from projects. */
export interface ProjectTeam extends ProjectScope {
  personId: string; teamRole: "owner" | "member" | null; team: TeamRecord | null; directory: TeamDirectoryMember[] | null;
}
export interface ProjectMember { personId: string; code: string; role: "owner" | "member"; status: "invited" | "active" | "removed" }
export interface ProjectSnapshot {
  sourceWarnings?: string[];
  teams: ProjectTeam[];
  projects: SharedProject[];
  localProjects: { id: string; name: string; personal: boolean; bound: boolean }[];
  peers: { id: string; name: string }[];
  capabilities?: { invite: boolean; leave: boolean };
}
export interface CreateProject extends ProjectScope { name: string; id?: string; localProjectId?: string; operationId: string }
export interface ProjectPatch { rev: number; name?: string; status?: "active" | "archived" }
export type ProjectRecipient = { personId: string; code?: never } | { code: string; personId?: never };
export interface ProjectInviteInput { peers: string[]; note: string; recipient: ProjectRecipient }
export interface SharedProjectsPort {
  list(signal: AbortSignal): Promise<ProjectSnapshot>;
  create(input: CreateProject, signal: AbortSignal): Promise<void>;
  updateTeam?(scope: ProjectScope, patch: { rev: number; name: string }, signal: AbortSignal): Promise<TeamRecord>;
  patch(ref: ProjectRef, patch: ProjectPatch, signal: AbortSignal): Promise<void>;
  members(ref: ProjectRef, signal: AbortSignal): Promise<ProjectMember[]>;
  invite(ref: ProjectRef, input: ProjectInviteInput, signal: AbortSignal): Promise<void>;
  remove(ref: ProjectRef, personId: string, signal: AbortSignal): Promise<void>;
  directories(ref: ProjectRef, dirs: string[], signal: AbortSignal): Promise<void>;
  leave(ref: ProjectRef, signal: AbortSignal): Promise<void>;
  complete(input: CreateProject, signal: AbortSignal): Promise<void>;
  cards?(signal: AbortSignal): Promise<ProjectCard[]>;
  answer?(card: ProjectCard, choices: string[], signal: AbortSignal): Promise<void>;
}
export interface ProjectCard {
  id: string; project: string; title: string; context: string; expiresAt: number; canAnswer: boolean;
  choice: import("./shared-projects-choice").SharedProjectChoice | null;
  accept: { id: string; label: string }; decline: { id: string; label: string };
}
export const projectKey = (ref: ProjectRef) => JSON.stringify([ref.centerId, ref.teamId, ref.projectId]);
export const teamKey = (ref: ProjectScope) => JSON.stringify([ref.centerId, ref.teamId]);
export const boundProjects = (snapshot: ProjectSnapshot) => snapshot.projects.filter(p => p.local && p.availability === "ready");
export const eligibleLocals = (snapshot: ProjectSnapshot) => snapshot.localProjects.filter(p => !p.personal && !p.bound);

/** Never render Error.message or arbitrary response fields, even when a proxy supplies HTML or credentials. */
export class ProjectFailure extends Error {
  constructor(readonly status: number, readonly current?: SharedProject, readonly conflict?: { code: string | null; team: TeamRecord | null }) {
    super(projectErrorText(status));
  }
}
/** Display only: a center name, else a fixed label with the team id; several centers add a short center tag in the same text. */
export function teamDisplayName(team: ProjectTeam, teams: readonly ProjectScope[], record = team.team): string {
  const name = !record ? `团队 ${team.teamId}（中心未提供显示名）` : record.name ?? `未命名团队 · ${team.teamId}`;
  return new Set(teams.map(t => t.centerId)).size > 1 ? `${name} · 中心 ${team.centerId.slice(-6)}` : name;
}
export function projectErrorText(status: number): string {
  if (status === 202) return "请在项目确认卡中由本人继续确认，再刷新查看本机可用状态。";
  if (status === 403) return "没有操作权限，请刷新项目权限后重试。";
  if (status === 404 || status === 501) return "这台机器暂不支持此操作，或项目已不可用。";
  if (status === 409) return "项目已被更新，请核对当前值后重试。";
  if (status === 401) return "设备凭据已失效，请重新配对。";
  return "操作未确认，请刷新查看结果后再试。";
}
