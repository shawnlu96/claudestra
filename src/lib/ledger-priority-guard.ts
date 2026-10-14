import { LedgerError } from "./ledger-store.js";

const CONTROLLED = /^(?:priority|workPriority|effectivePriority|priorityRecordId|priorityOrder|prioritySort|priorityNowStart|priorityStall|priorityPanel)$/i;

/** Legacy items.priority is display text. Every other priority key must use the dedicated writer. */
export function rejectPriorityFields(value: unknown, legacyItem = false, nested = false): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectPriorityFields(entry, false, true);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (CONTROLLED.test(key) && !(legacyItem && !nested && key === "priority")) {
      throw new LedgerError("invalid", `受控字段 ${key} 只能经 priority 专用入口登记`);
    }
    rejectPriorityFields(entry, false, true);
  }
}
