/** A worker slot follows the card through write, review and fix; new dispatches reuse it. */
export function cardWorkerSlots(held: readonly { resource: string; taskId: string }[], taskId: string): string[] {
  return [...new Set(held.filter((row) => row.taskId === taskId && row.resource.startsWith("slot:")).map((row) => row.resource))];
}
