import { LedgerError } from "./ledger-store.js";

const CONTROLLED = new Set(["workPriority", "effectivePriority", "priorityRecordId", "priorityOrder", "prioritySort", "priorityNowStart", "priorityStall", "priorityPanel"]);

/** Ordinary priority is legacy display text at any depth; readPriority ignores extra.priority. Exact controlled keys use the dedicated writer. */
export function rejectPriorityFields(value: unknown, _legacyItem = false): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectPriorityFields(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (CONTROLLED.has(key)) {
      throw new LedgerError("invalid", `受控字段 ${key} 只能经 priority 专用入口登记`);
    }
    rejectPriorityFields(entry);
  }
}
