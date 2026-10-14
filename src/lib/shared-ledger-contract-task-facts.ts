/** Sub-DAG card facts: `GET /v1/teams/{teamId}/features/{featureId}/task-facts`, a standalone endpoint.
 * The closed V1 parsers forbid extra keys, so these facts never ride on feature detail or ext-capabilities.
 * An old center has no such route and answers 403 (its catch-all forbidden), not 404.
 * Rows carry ids, kinds and times only — never actor, text or summary. The center vendors this file: schema is its only import.
 */
import { array, choice, id, integer, invalid, literal, nullable, object, positive, unique } from "./shared-ledger-contract-schema.js";

export const TASK_FACT_KINDS = ["stage", "deliver", "review", "verify", "deploy", "ask", "ask_cancel", "decision", "dispatch"] as const;
type SharedLedgerTaskFactKind = typeof TASK_FACT_KINDS[number];
/** Resource under `/v1/teams/{teamId}/`; group 1 is the feature id. The bridge proxy and the center share this one pattern. */
export const TASK_FACTS_RESOURCE = /^features\/([A-Za-z0-9_.:-]+)\/task-facts$/;

/** doneAt set ⇒ the card is finished: stageSince and lastEvent are null. Unknown times are null, never 0. */
export interface SharedLedgerTaskFact {
  taskId: string; stageSince: number | null; doneAt: number | null; lastEvent: { at: number; kind: SharedLedgerTaskFactKind } | null;
}
export interface SharedLedgerTaskFacts {
  schemaVersion: 1; teamId: string; projectId: string; featureId: string; serverSeq: number; tasks: SharedLedgerTaskFact[];
}

const fact = object({ taskId: id, stageSince: nullable(positive), doneAt: nullable(positive),
  lastEvent: nullable(object({ at: positive, kind: choice(TASK_FACT_KINDS) })) });
const facts = object({ schemaVersion: literal(1), teamId: id, projectId: id, featureId: id, serverSeq: integer, tasks: array(fact) });

/** Closed at every level; the tasks cap is the detail tasks cap (array default 1000). */
export function parseSharedLedgerTaskFacts(value: unknown): SharedLedgerTaskFacts {
  const parsed = facts(value);
  unique(parsed.tasks.map((t) => t.taskId));
  if (parsed.tasks.some((t) => t.doneAt !== null && (t.stageSince !== null || t.lastEvent !== null))) invalid();
  return parsed;
}
