/** Only acknowledgement reminders belong here; asks whose answers authorize or trigger work must keep blocking merges. */
import type { Ask } from "./ledger-asks.js";

const MANUAL_DELIVER_NOTICE_CREATOR = "system:manual-deliver-notice";
export const PRIORITY_STALL_CREATOR = "system:priority-stall";
export const ASK_REMINDER_SOURCES: readonly string[] = Object.freeze([MANUAL_DELIVER_NOTICE_CREATOR, PRIORITY_STALL_CREATOR]);

/** Match the persisted creator exactly, regardless of transport; an authorize ask is always a decision. */
export const isReminderOwnerAction = (a: Pick<Ask, "kind" | "createdBy">): boolean =>
  a.kind === "owner_action" && a.createdBy !== null && ASK_REMINDER_SOURCES.includes(a.createdBy);
