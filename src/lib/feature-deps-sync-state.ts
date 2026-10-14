/** Persisted per-group state of feature-deps-sync.ts. Fields added after the first release are optional so older
 * files keep parsing; `projects` / `centerProjects` let a group that vanished from the registry still be judged and
 * cleared (feature-deps-sync-stale.ts). Exceptions never land here: only fixed reasons and counts.
 */
import { createHash } from "node:crypto";
import { readJsonStateSync } from "./state-file.js";
import { SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { mirrorBackoffMs } from "./shared-ledger-projector.js";
import { parseFeatureDepsUpload } from "./shared-ledger-contract-feature-deps.js";
import { array, digest, integer, literal, nullable, object, optional, record, text } from "./shared-ledger-contract-schema.js";

const DAY_MS = 86400_000;
export const COMPUTE_MS = 300_000, RESEND_MS = 6 * 3600_000;
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const names = array(text(256, 1), 1000);
const groupSchema = object({ hash: nullable(digest), scopeHash: nullable(digest), lastSentAt: nullable(integer), lastComputedAt: nullable(integer),
  unsupportedUntil: integer, cooldown: integer, failures: integer, nextAttemptAt: integer, wouldSend: nullable(parseFeatureDepsUpload),
  projects: optional(names), centerProjects: optional(names), skipped: optional(literal("too_many_edges")), skippedEdges: optional(integer),
  clearObservedAt: optional(integer) });
type Later = "projects" | "centerProjects" | "skipped" | "skippedEdges" | "clearObservedAt";
export type GroupState = Omit<ReturnType<typeof groupSchema>, Later> & Partial<Pick<ReturnType<typeof groupSchema>, Later>>;
export interface SyncFile { schemaVersion: 1; groups: Record<string, GroupState>; notedDays: Record<string, number>; cooldowns: Record<string, number> }
export const fresh = (): GroupState => ({ hash: null, scopeHash: null, lastSentAt: null, lastComputedAt: null,
  unsupportedUntil: 0, cooldown: 0, failures: 0, nextAttemptAt: 0, wouldSend: null });

export function readState(path: string): SyncFile {
  const state = readJsonStateSync(path);
  if (state.status === "missing") return { schemaVersion: 1, groups: {}, notedDays: {}, cooldowns: {} };
  if (state.status === "corrupt") throw new Error("feature deps state unreadable");
  const row = object({ schemaVersion: literal(1), groups: record, notedDays: record, cooldowns: record })(state.data);
  return { schemaVersion: 1, groups: Object.fromEntries(Object.entries(row.groups).map(([k, v]) => [k, groupSchema(v)])),
    notedDays: Object.fromEntries(Object.entries(row.notedDays).map(([k, v]) => [k, integer(v)])),
    cooldowns: Object.fromEntries(Object.entries(row.cooldowns).map(([k, v]) => [k, integer(v)])) };
}

/** At most one log line per key and UTC day; `notedDays` already holds per-center days, these keys start with "#". */
export function noteOncePerDay(file: SyncFile, key: string, now: number, message: string): void {
  const day = Math.floor(now / DAY_MS);
  if (file.notedDays[key] === day) return;
  file.notedDays[key] = day;
  console.warn(message);
}

/** Upload-side failure for one group. Returns true on 429, which ends the pass for every center. */
export function uploadFailed(file: SyncFile, centerId: string, st: GroupState, error: unknown, now: number): boolean {
  if (error instanceof SharedLedgerRemoteError && [403, 404].includes(error.status)) {
    st.unsupportedUntil = now + RESEND_MS;
    const day = Math.floor(now / DAY_MS);
    if (file.notedDays[centerId] !== day) {
      file.notedDays[centerId] = day;
      console.warn("团队依赖：中心暂不支持 feature-deps，六小时后重试");
    }
  } else if (error instanceof SharedLedgerRemoteError && error.status === 429) {
    st.cooldown = now + Math.min(60_000, Math.max(0, error.retryAfterMs));
    file.cooldowns[centerId] = Math.max(file.cooldowns[centerId] ?? 0, st.cooldown);
    return true;
  } else {
    st.failures++;
    st.nextAttemptAt = now + mirrorBackoffMs(st.failures);
    // Fixed text: exceptions can contain credentials or local paths, neither belongs in the sync state or logs.
    console.warn("团队依赖：上传失败，独立退避后重试");
  }
  return false;
}
/** Shared gate before any upload: unsupported window, own or center-wide cooldown, failure backoff. */
export const uploadBlocked = (file: SyncFile, centerId: string, st: GroupState, at: number): boolean =>
  st.unsupportedUntil > at || Math.max(st.cooldown, file.cooldowns[centerId] ?? 0) > at || st.nextAttemptAt > at;
