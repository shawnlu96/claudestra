/** Add-only V1 read extension (team-collab-parity-plan §5.2 P1-D). The frozen contract/responses files stay untouched:
 * old clients never see these keys, and a center without the extension answers 404 for ext-capabilities.
 * Reads carry ids, codes, types and times only — never task text, event data or summaries.
 */
import type { SharedLedgerDag } from "./shared-ledger-contract.js";
import { array, boolean, choice, id, integer, invalid, literal, nullable, object, record, text, unique, type Schema } from "./shared-ledger-contract-schema.js";
import { dagSchema, validateDag } from "./shared-ledger-contract-validation.js";

export interface SharedLedgerExtCapabilities {
  schemaVersion: 1; teamId: string;
  reads: { versions: boolean; activity: boolean; ext1: boolean; activityExt: boolean };
  /** Upload permission is separate: `reads.*` true never authorizes sending ext1 projections. */
  uploads: { projectionExt1: boolean };
}
/** `by` is the member code (actorCode), never a person name; unknown history is null, not "" / 0. */
interface SharedLedgerFeatureVersion extends SharedLedgerDag { reason: string; at: number | null; by: string | null }
export interface SharedLedgerFeatureVersions { schemaVersion: 1; teamId: string; projectId: string; serverSeq: number; versions: SharedLedgerFeatureVersion[] }
type SharedLedgerActivityItem =
  | { src: "center"; serverSeq: number; kind: string; by: string; at: number }
  | { src: "home"; sourceSeq: number; taskId: string; type: string; at: number };
export interface SharedLedgerFeatureActivity {
  schemaVersion: 1; teamId: string; projectId: string; serverSeq: number; items: SharedLedgerActivityItem[]; truncated: boolean;
}

/** What an old center (404) means: nothing extra to read, nothing extra to upload. */
export const EXT_CAPABILITIES_OFF: Omit<SharedLedgerExtCapabilities, "teamId"> = Object.freeze({ schemaVersion: 1,
  reads: Object.freeze({ versions: false, activity: false, ext1: false, activityExt: false }), uploads: Object.freeze({ projectionExt1: false }) });

const extCapabilities: Schema<SharedLedgerExtCapabilities> = object({ schemaVersion: literal(1), teamId: id,
  reads: object({ versions: boolean, activity: boolean, ext1: boolean, activityExt: boolean }),
  uploads: object({ projectionExt1: boolean }) });

/** Nodes/bindings go through the frozen dagSchema + validateDag, so a version cannot diverge from a V1 dag. */
function version(value: unknown): SharedLedgerFeatureVersion {
  const { reason, at, by, ...dag } = record(value);
  const parsed = dagSchema(dag);
  validateDag(parsed);
  return { ...parsed, reason: text(2000)(reason), at: nullable(integer)(at), by: nullable(id)(by) };
}
function versions(value: unknown): SharedLedgerFeatureVersions {
  const parsed = object({ schemaVersion: literal(1), teamId: id, projectId: id, serverSeq: integer, versions: array(version) })(value);
  unique(parsed.versions.map((v) => String(v.version)));
  return parsed;
}

const activityItem = {
  center: object({ src: literal("center"), serverSeq: integer, kind: text(80, 1), by: id, at: integer }),
  home: object({ src: literal("home"), sourceSeq: integer, taskId: id, type: text(80, 1), at: integer }),
};
function activity(value: unknown): SharedLedgerFeatureActivity {
  const item = (v: unknown): SharedLedgerActivityItem => activityItem[choice(["center", "home"])(record(v).src)](v);
  const parsed = object({ schemaVersion: literal(1), teamId: id, projectId: id, serverSeq: integer, items: array(item), truncated: boolean })(value);
  if (parsed.items.some((i) => i.src === "center" && i.serverSeq > parsed.serverSeq)) invalid();
  return parsed;
}

/** Path cursor for `features/{id}/activity/{afterServerSeq}`: canonical non-negative safe integer or null (never query). */
export function parseActivityCursor(segment: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(segment)) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) ? n : null;
}

const reads = { extCapabilities, versions, activity };
export function parseSharedLedgerReadResponse<K extends keyof typeof reads>(kind: K, value: unknown): ReturnType<typeof reads[K]> {
  return reads[kind](value) as ReturnType<typeof reads[K]>;
}
