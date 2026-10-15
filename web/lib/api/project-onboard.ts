/**
 * 项目「接入编排」：POST /api/v1/projects/:id/onboard（bridge/local-api/project-onboard.ts → `team onboard`，ONB-3）。
 * 清单、补段、出提案全由后端那条命令做；网页只读清单和转发。要 manage 授权，没有就 403。
 */
import { api, ApiError } from "./client";

export type OnboardItemStatus = "ok" | "todo" | "diff" | "blocked" | "done";
export interface OnboardItem {
  key: "project" | "git" | "scheduler" | "team";
  status: OnboardItemStatus;
  text: string;
}
export interface OnboardParams {
  localMerge?: boolean;
  /** 逗号分条，空 = 不传 */
  checks?: string;
  maxWorkers?: number;
}
/** git = 后端看到的仓库状态（no-origin = 只能走本地合并）；error = 整次被拦 / 失败的原因 */
export interface OnboardResult {
  ok: boolean;
  items: OnboardItem[];
  git: "origin" | "no-origin" | "not-git" | null;
  error: string | null;
  proposal: string | null;
}

const STATUSES = new Set<OnboardItemStatus>(["ok", "todo", "diff", "blocked", "done"]);
const isItem = (x: unknown): x is OnboardItem =>
  !!x && typeof x === "object" && typeof (x as OnboardItem).text === "string" && STATUSES.has((x as OnboardItem).status);

export async function onboardProject(project: string, p: OnboardParams, dryRun: boolean): Promise<OnboardResult> {
  try {
    const j = await api<Record<string, unknown>>(`/projects/${encodeURIComponent(project)}/onboard`, {
      method: "POST",
      json: { dryRun, ...(p.localMerge !== undefined ? { localMerge: p.localMerge } : {}), ...(p.checks?.trim() ? { checks: p.checks.trim() } : {}),
        ...(p.maxWorkers !== undefined ? { maxWorkers: p.maxWorkers } : {}) },
    });
    const git = j.git === "origin" || j.git === "no-origin" || j.git === "not-git" ? j.git : null;
    return { ok: j.ok === true, items: Array.isArray(j.items) ? j.items.filter(isItem) : [], git,
      error: j.ok === true ? null : typeof j.error === "string" ? j.error : "操作失败", proposal: typeof j.proposal === "string" ? j.proposal : null };
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    return { ok: false, items: [], git: null, error: msg || "操作失败", proposal: null };
  }
}
