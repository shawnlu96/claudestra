/**
 * The registry task name a ledger task writes for its executor (IDLINK1). The card id is the identity convention the
 * scheduler reads back (scheduler-existing-author.ts: first whitespace word = card id, case-insensitive), so the name
 * always starts with it: a title already led by the id is kept as is, any other title becomes `<id> <title>`.
 * The caller truncates after this, so the id is never cut off.
 */
export function registryTaskLabel(taskId: string, title: string): string {
  const id = taskId.trim(), t = title.trim();
  if (!id) return t;
  if (!t) return id;
  return (t.split(/\s+/)[0] ?? "").toLowerCase() === id.toLowerCase() ? t : `${id} ${t}`;
}

/**
 * Null when the (already truncated) registry task name still leads with the whole card id; otherwise why it must not be
 * written. A card id longer than the registry limit cannot survive truncation, and a clipped id is a different first word
 * that the scheduler reads as an identity conflict, so the caller skips the task name instead of reporting it linked.
 */
export function registryTaskIdError(taskId: string, task: string, max: number): string | null {
  const id = taskId.trim();
  if (!id || (task.trim().split(/\s+/)[0] ?? "").toLowerCase() === id.toLowerCase()) return null;
  return `卡号 ${id} 有 ${id.length} 个字符，超过 registry 任务名上限 ${max}，截断后调度器认不出卡号，任务名没写；请换短卡号或人工 team-link`;
}
