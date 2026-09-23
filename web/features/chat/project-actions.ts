/**
 * project 管理的写操作（BFF /api/projects → bridge /api/v1/projects → runManager project-*）。
 * 项目管理弹窗、侧栏菜单「移动到」、拖拽改 project 三处共用同一个入口。
 */
export async function projAction(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 把 agent 转到另一个 project（agent 必属一个 project，所以只有「转移」没有「移出」）。 */
export function assignAgentProject(agent: string, projectId: string): Promise<{ ok?: boolean; error?: string }> {
  return projAction({ action: "assign", agent, id: projectId });
}
