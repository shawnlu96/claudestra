/** Clearing a group whose home mirrors were all switched off. Gone is judged only on the complete enabled registry, never
 * on the due-only live slice, and only for groups that really uploaded. The credential comes from the recorded (or, for older
 * state, registry-derived) center projects; resolveMirrorCredential needs no mirror entry. None available keeps the group.
 * on uploads one empty replacement and forgets the group on a matching receipt; observe records once; off never touches it.
 * tests/feature-deps-sync.test.ts.
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

interface Coverage { projects: string[]; centerProjects: string[] }
/** Recorded coverage, or (state written before it was recorded) the team's registry entries, disabled ones included.
 * No home entry left in either place means the original coverage is unknown: never cleared. */
function coverage(st: GroupState, key: [string, string, string], all: Entries): Coverage | null {
  const [centerId, teamId, self] = key;
  const team = all.filter(([, e]) => e.centerId === centerId && e.teamId === teamId), home = team.filter(([, e]) => e.sourceInstanceId === self);
  const projects = st.projects?.length ? st.projects : [...new Set(team.map(([, e]) => e.localProject))].sort();
  const centerProjects = st.centerProjects?.length ? st.centerProjects : [...new Set(home.map(([, e]) => e.projectId))].sort();
  return projects.length && centerProjects.length ? { projects, centerProjects } : null;
}

/** null = not gone (or unjudgeable); otherwise the combined mode of the projects the group last covered. */
function goneMode(st: GroupState, key: [string, string, string], d: StaleDeps, all: Entries): { mode: RecoveryMode; cover: Coverage } | null {
  const [centerId, teamId, source] = key, cover = coverage(st, key, all);
  if (st.lastSentAt === null || source !== d.self || !cover || homeEnabled(all, centerId, teamId, d.self)) return null;
  const modes = cover.projects.map(d.mode);
  return { mode: modes.includes("off") ? "off" : modes.includes("observe") ? "observe" : "on", cover };
}

/** Returns true when a 429 ended the pass. */
export async function clearStaleGroups(file: SyncFile, d: StaleDeps): Promise<boolean> {
  const all = d.mirrors();
  for (const [id, st] of Object.entries(file.groups)) {
    const key = parseId(id);
    if (!key) continue;
    const gone = goneMode(st, key, d, all), [centerId, teamId, self] = key;
    if (gone?.mode === "observe") { st.clearObservedAt ??= d.now(); continue; }
    if (gone?.mode !== "on" || uploadBlocked(file, centerId, st, d.now())) continue;
    const credential = gone.cover.centerProjects.map((projectId) => d.credential({ centerId, teamId, projectId }))
      .find((c) => c?.instanceId === self);
    if (!credential) continue;
    try {
      await d.wait();
      // Registry or policy may change during the gap: a re-enabled home or a switch away from on cancels the clear.
      if (goneMode(st, key, d, d.mirrors())?.mode !== "on" || d.notBefore(credential.baseUrl) > d.now()) continue;
      const client = d.client(credential);
      if (!client) continue;
      const receipt = await client.uploadFeatureDeps({ schemaVersion: 1, teamId, sourceInstanceId: self, edges: [] });
      if (receipt.schemaVersion !== 1 || receipt.accepted !== 0) throw new Error("receipt mismatch");
      delete file.groups[id];
    } catch (error) { if (uploadFailed(file, centerId, st, error, d.now())) return true; }
  }
  return false;
}
