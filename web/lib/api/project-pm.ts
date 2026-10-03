/**
 * 项目主管 PM：GET / POST /api/v1/projects/:id/pm（bridge/local-api/project-pm.ts，i28-PMSW1）。
 * 候选、体检、切换全由后端算；网页只读和转发，不改任何配置。要 manage 授权，没有就 403。
 */
import { api, ApiError } from "./client";

export interface PmCandidate {
  name: string;
  runtime: string;
  online: boolean;
  registered: boolean;
}
export interface ProjectPmView {
  active: string | null;
  candidates: PmCandidate[];
}
/** 切换 / 体检结果：失败时 error 原样带回（体检不过是 "a; b; c" 一串问题） */
export type PmSwitchResult = { ok: true } | { ok: false; status: number; error: string };

const path = (project: string) => `/projects/${encodeURIComponent(project)}/pm`;

export async function getProjectPm(project: string): Promise<ProjectPmView> {
  const j = await api<Partial<ProjectPmView>>(path(project));
  return { active: typeof j.active === "string" ? j.active : null, candidates: Array.isArray(j.candidates) ? j.candidates : [] };
}

export async function switchProjectPm(project: string, agent: string, dryRun: boolean): Promise<PmSwitchResult> {
  try {
    const j = await api<{ ok?: boolean; error?: string }>(path(project), { method: "POST", json: { agent, dryRun } });
    return j.ok === false ? { ok: false, status: 200, error: j.error || "操作失败" } : { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
    return { ok: false, status: 0, error: (e as Error).message || "操作失败" };
  }
}
