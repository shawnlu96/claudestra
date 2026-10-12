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
