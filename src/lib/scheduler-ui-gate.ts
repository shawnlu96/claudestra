/**
 * Read-only projection of the owner's screenshot authorization for a UI card. Observe never opens an ask, but PM (or the
 * scheduler) may have; the same binding, approve-button, expiry and non-external checks as the merge gate decide what
 * counts. Reading an existing ask has no external effect, so observe must not pretend it isn't there.
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk } from "./ledger-asks.js";
import { isManager } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";

const UI_ASK_ACTION = "scheduler_ui_screenshot";

type UiGate = PlannerSnapshot["uiGate"];

function boundTo(params: unknown): { task: unknown; head?: string; specRev?: number; screenshotsDigest?: string } {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  return { task: p.task, ...(typeof p.head === "string" ? { head: p.head } : {}),
    ...(typeof p.specRev === "number" ? { specRev: p.specRev } : {}),
    ...(typeof p.screenshotsDigest === "string" ? { screenshotsDigest: p.screenshotsDigest } : {}) };
}

/** The newest live screenshot ask decides; the planner then checks its head / specRev / digest against the card. */
export function projectUiGate(db: Database, task: LedgerTask, now: number): UiGate {
  const rows = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' ORDER BY createdAt DESC, id DESC LIMIT 20`)
    .all(task.id) as { id: string }[];
  for (const { id } of rows) {
    const ask = getAsk(db, id);
    const from = ask?.fromAgent;
    if (!ask?.bind || ask.bind.action !== UI_ASK_ACTION || !from || ask.state === "superseded") continue;
    if (from !== "scheduler" && !isManager(db, from, task)) continue;
    const { task: boundTask, ...bound } = boundTo(ask.bind.params);
    if (boundTask !== task.id) continue;
    if (ask.expiresAt <= now || (ask.state !== "open" && ask.state !== "answered")) return { state: "none" };
    if (ask.state === "open") return { state: "open", ...bound };
    const check = checkAsk(ask, bindHash(ask.bind, from), from, now);
    return check.ok ? { state: "approved", ...bound, ownerVerified: ask.answer?.external !== true } : { state: "rejected", ...bound };
  }
  return { state: "none" };
}
