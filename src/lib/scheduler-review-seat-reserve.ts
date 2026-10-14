/** Finishing reservations must only skip a bound reviewer when the canonical pool already counted its seat. */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { workingSeats } from "./scheduler-agent-pool-ledger.js";
import { reviewSeatMode } from "./scheduler-review-seat.js";

/** Read once per reservation simulation; begun creation and author bindings keep the legacy skip condition. */
export function finishingSeatReservation(db: Database, project: string) {
  const mode = reviewSeatMode(project), seats = mode === "on" ? workingSeats(db, project, null, mode) : null;
  return (taskId: string, role: "author" | "reviewer", family: AuthorFamily): "counted" | "local" | "unbound" => {
    const bound = db.query(`SELECT agent FROM scheduler_sessions
      WHERE taskId=? AND role=? AND family=? AND transport!='peer' AND state!='retired'`)
      .all(taskId, role, family) as { agent: string }[];
    if (bound.some((s) => role !== "reviewer" || mode !== "on" || seats === null || seats.get(s.agent)?.family === family)) return "counted";
    if (db.query(`SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='ensure_session'
      AND status IN ('submitted','unknown') AND receipt LIKE ? LIMIT 1`).get(taskId, `%ensure ${role} ${family}%`)) return "counted";
    // The planner reuses a bound local reviewer; a free peer cannot stand in for that local finishing seat.
    return bound.length ? "local" : "unbound";
  };
}
