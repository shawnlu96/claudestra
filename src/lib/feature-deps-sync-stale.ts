/** Clearing a group whose home mirrors were all switched off. Gone is judged only on the complete enabled registry, never
 * on the due-only live slice, and only for groups that really uploaded. The credential comes from the recorded center
 * projects (resolveMirrorCredential needs no mirror entry); none available keeps the group for the next pass, no failure.
 * on uploads one empty replacement and forgets the group on a matching receipt; observe records once; off never touches it.
 * tests/feature-deps-sync-stale.test.ts.
 */
import type { RecoveryMode } from "./recovery-policy.js";
import type { SharedLedgerClient } from "./shared-ledger-client.js";
import type { MirrorEntry } from "./shared-ledger-projector.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { uploadBlocked, uploadFailed, type GroupState, type SyncFile } from "./feature-deps-sync-state.js";

type Entries = readonly (readonly [string, MirrorEntry])[];
export interface StaleDeps {
  self: string; now: () => number;
  /** Complete registry, re-read after the request gap. */
  mirrors: () => Entries;
  mode: (localProject: string) => RecoveryMode;
  credential: (key: { centerId: string; teamId: string; projectId: string }) => SharedLedgerLocalCredential | null;
  notBefore: (baseUrl: string) => number;
  client: (credential: SharedLedgerLocalCredential) => Pick<SharedLedgerClient, "uploadFeatureDeps"> | null;
  wait: () => Promise<void>;
}

function parseId(id: string): [string, string, string] | null {
  try {
    const v: unknown = JSON.parse(id);
    return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string") ? v as [string, string, string] : null;
  } catch { return null; } // Not written by groupsOf: never a candidate for clearing.
}
const homeEnabled = (all: Entries, centerId: string, teamId: string, self: string): boolean =>
  all.some(([, e]) => e.enabled && e.centerId === centerId && e.teamId === teamId && e.sourceInstanceId === self);

/** null = not gone (or unjudgeable); otherwise the combined mode of the projects the group last covered. */
function goneMode(st: GroupState, key: [string, string, string], d: StaleDeps, all: Entries): RecoveryMode | null {
  const [centerId, teamId, source] = key;
  if (st.lastSentAt === null || source !== d.self || !st.projects?.length || homeEnabled(all, centerId, teamId, d.self)) return null;
  const modes = st.projects.map(d.mode);
  return modes.includes("off") ? "off" : modes.includes("observe") ? "observe" : "on";
}

/** Returns true when a 429 ended the pass. */
export async function clearStaleGroups(file: SyncFile, d: StaleDeps): Promise<boolean> {
  const all = d.mirrors();
  for (const [id, st] of Object.entries(file.groups)) {
    const key = parseId(id);
    if (!key) continue;
    const mode = goneMode(st, key, d, all), [centerId, teamId, self] = key;
    if (mode === "observe") { st.clearObservedAt ??= d.now(); continue; }
    if (mode !== "on" || uploadBlocked(file, centerId, st, d.now())) continue;
    const credential = (st.centerProjects ?? []).map((projectId) => d.credential({ centerId, teamId, projectId }))
      .find((c) => c?.instanceId === self);
    if (!credential) continue;
    try {
      await d.wait();
      // Registry or policy may change during the gap: a re-enabled home or a switch away from on cancels the clear.
      if (goneMode(st, key, d, d.mirrors()) !== "on" || d.notBefore(credential.baseUrl) > d.now()) continue;
      const client = d.client(credential);
      if (!client) continue;
      const receipt = await client.uploadFeatureDeps({ schemaVersion: 1, teamId, sourceInstanceId: self, edges: [] });
      if (receipt.schemaVersion !== 1 || receipt.accepted !== 0) throw new Error("receipt mismatch");
      delete file.groups[id];
    } catch (error) { if (uploadFailed(file, centerId, st, error, d.now())) return true; }
  }
  return false;
}
