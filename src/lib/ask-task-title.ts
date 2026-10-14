/**
 * GET /asks 每行补卡号对应的任务标题（UXASK1）：网页卡头写「项目 · 任务标题」。
 * 只给读得了台账的凭据（allowed = local-api/asks.ts 的 ledger）：guest 拿不到任务标题，一个字段都不加。
 * 同一个 taskId 只查一次；查不到 / 查的时候抛错 → 这一行不加，列表照常返回。共享卡的 taskId 是中心卡号，本机查不到，自然不加。
 */
export const TASK_TITLE_MAX = 80;

export function withTaskTitles<T extends { taskId: string | null }>(
  rows: T[],
  lookup: (taskId: string) => string | null | undefined,
  allowed: boolean,
): (T & { taskTitle?: string })[] {
  if (!allowed) return rows;
  const titles = new Map<string, string | null>();
  const titleOf = (id: string): string | null => {
    if (!titles.has(id)) {
      let title: string | null = null;
      try {
        title = lookup(id) || null;
      } catch {
        // 台账读失败只少一个标题，不连累整张列表
      }
      titles.set(id, title ? [...title].slice(0, TASK_TITLE_MAX).join("") : null);
    }
    return titles.get(id) ?? null;
  };
  return rows.map((r) => {
    const title = r.taskId ? titleOf(r.taskId) : null;
    return title ? { ...r, taskTitle: title } : r;
  });
}
