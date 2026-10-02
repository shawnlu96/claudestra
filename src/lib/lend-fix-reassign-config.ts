/** scheduler.json remote.fixReassignMin (i28-RA1, lend-fix-reassign.ts); no imports, so scheduler-config.ts can take it without a cycle. */
export interface FixReassignPolicy {
  /** Minutes a fix may wait on a write-lease holder that cannot take it before it is reassigned; absent = 20. */
  fixReassignMin?: number;
}
export const FIX_REASSIGN_DEFAULT_MIN = 20;

export function parseFixReassign(raw: unknown, where: string): FixReassignPolicy {
  if (raw === undefined) return {};
  if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > 1440) throw new Error(`${where}.fixReassignMin must be 1..1440`);
  return { fixReassignMin: raw as number };
}
