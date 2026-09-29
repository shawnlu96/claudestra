/**
 * project 管理的写操作（bridge /api/v1/projects → runManager project-*）。
 * 项目管理弹窗、侧栏菜单「移动到」、拖拽改 project 三处共用同一个入口。
 */
import { projectsAction } from "@/lib/api/system";
import { t } from "@/lib/i18n";

/** tpl + params：manager 的目录校验 / 角色校验报错（src/lib/project-dirs.ts、src/manager/project-guard.ts），按模板翻译 */
export type ProjResult = { ok?: boolean; error?: string; tpl?: string; params?: Record<string, string> };

export function projError(r: ProjResult, fallback: string): string {
  return r.tpl ? t(r.tpl, r.params) : r.error || fallback;
}

export async function projAction(body: Record<string, unknown>): Promise<ProjResult> {
  try {
    return await projectsAction<ProjResult>(body);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 把 agent 转到另一个 project（agent 必属一个 project，所以只有「转移」没有「移出」）。 */
export function assignAgentProject(agent: string, projectId: string): Promise<ProjResult> {
  return projAction({ action: "assign", agent, id: projectId });
}
