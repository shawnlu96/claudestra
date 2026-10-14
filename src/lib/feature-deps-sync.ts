/** Home-side structural edges, independent of projection watermarks. Full replacement is per center/team/instance,
 * so live (a bounded, due-only slice) selects teams, while the full enabled mirror registry supplies endpoints.
 * Only split/declared/task fields are reconstructed; notes, lock paths and card evidence never enter the state or upload.
 * A mixed team stays observe (or pauses for off) because replacing only its on projects would delete the others' edges.
 * The mirror pass owns the push lock. Failures here never escape into projection work. tests/feature-deps-sync.test.ts.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync } from "./instance-key.js";
import { productBoard } from "./ledger-product-board.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import { sharedLedgerNotBefore } from "./shared-ledger-client-transport.js";
import { readSharedLedgerMirrors, resolveMirrorCredential } from "./shared-ledger-mirror.js";
import type { MirrorEntry } from "./shared-ledger-projector.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { parseFeatureDepsUpload, type FeatureDep, type FeatureDepsUpload } from "./shared-ledger-contract-feature-deps.js";
import { COMPUTE_MS, RESEND_MS, fresh, hash, readState, uploadBlocked, uploadFailed, type GroupState } from "./feature-deps-sync-state.js";
import { computeErrorHandled, mergeFeatureDeps } from "./feature-deps-sync-edges.js";
import { clearStaleGroups } from "./feature-deps-sync-stale.js";

type Entries = readonly (readonly [string, MirrorEntry])[];
type UploadClient = Pick<SharedLedgerClient, "uploadFeatureDeps">;
interface SyncDeps {
  stateDir?: string; now?: () => number; requestGapMs?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch;
  client?: (credential: SharedLedgerLocalCredential) => UploadClient | null;
  /** Tests inject the complete registry, never the due-only live slice. */
  mirrors?: () => Entries;
}
/** Same recovery file and precedence as teamBody. Missing configuration observes; unreadable policy stops. */
export function featureDepsMode(projectId: string, path = RECOVERY_POLICY_PATH): RecoveryMode {
  return recoveryPolicy(projectId, "featureDeps", path).mode;
}
interface Group { id: string; centerId: string; teamId: string; sourceInstanceId: string; entries: Entries }
function groupsOf(live: Entries, all: Entries, sourceInstanceId: string): Group[] {
  const teams = new Set(live.filter(([, e]) => e.enabled).map(([, e]) => JSON.stringify([e.centerId, e.teamId])));
  return [...teams].sort().flatMap((team) => {
    const entries = all.filter(([, e]) => e.enabled && JSON.stringify([e.centerId, e.teamId]) === team);
    const home = entries.find(([, e]) => e.sourceInstanceId === sourceInstanceId)?.[1];
    return home ? [{ id: JSON.stringify([home.centerId, home.teamId, sourceInstanceId]), centerId: home.centerId,
      teamId: home.teamId, sourceInstanceId, entries }] : [];
  });
}
function groupMode(g: Group, path: string): RecoveryMode {
  const modes = [...new Set(g.entries.map(([, e]) => e.localProject))].map((p) => featureDepsMode(p, path));
  return modes.includes("off") ? "off" : modes.includes("observe") ? "observe" : "on";
}
const scopeOf = (g: Group): string => hash(g.entries.map(([id, e]) =>
  [id, e.centerId, e.teamId, e.projectId, e.centerFeatureId, e.sourceInstanceId, e.localProject]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function compute(db: Database, g: Group, now: number): FeatureDepsUpload {
  const endpoints = new Map(g.entries);
  const edges: FeatureDep[] = [];
  for (const project of [...new Set(g.entries.map(([, e]) => e.localProject))].sort()) {
    const board = productBoard(db, project, now);
    for (const e of [...board.deps, ...board.links.filter((e) => e.kind === "task")]) {
      if (e.kind !== "split" && e.kind !== "declared" && e.kind !== "task") continue;
      const from = endpoints.get(e.from), to = endpoints.get(e.to);
      if (!from || !to || from.localProject !== project || to.localProject !== project || from.projectId !== to.projectId
        || to.sourceInstanceId !== g.sourceInstanceId || from.centerFeatureId === to.centerFeatureId) continue;
      edges.push({ projectId: to.projectId, from: from.centerFeatureId, to: to.centerFeatureId, kind: e.kind, satisfied: e.satisfied, count: e.count });
    }
  }
  return parseFeatureDepsUpload({ schemaVersion: 1, teamId: g.teamId, sourceInstanceId: g.sourceInstanceId, edges: mergeFeatureDeps(edges) });
}
function realClient(credential: SharedLedgerLocalCredential, dir: string, deps: SyncDeps): UploadClient | null {
  const key = instanceKeySync(dir);
  return key ? new SharedLedgerClient(credential, key, { fetch: deps.fetch, now: deps.now, stateDir: dir }) : null;
}
/** Never throws, including corrupt state or computation errors. An empty changed snapshot is sent to clear old edges;
 * a group whose home mirrors are all off is cleared by feature-deps-sync-stale.ts. */
export async function syncFeatureDeps(db: Database, live: Entries, deps: SyncDeps = {}): Promise<void> {
  const dir = deps.stateDir ?? STATE_DIR, now = deps.now ?? Date.now, path = join(dir, "feature-deps-sync.json");
  const policy = join(dir, "recovery-policy.json"), modeOf = (p: string) => featureDepsMode(p, policy);
  const mirrors = deps.mirrors ?? (() => Object.entries(readSharedLedgerMirrors(dir)));
  const wait = () => (deps.sleep ?? Bun.sleep)(deps.requestGapMs ?? 600);
  const clientFor = (credential: SharedLedgerLocalCredential) => deps.client ? deps.client(credential) : realClient(credential, dir, deps);
  try {
    // off must not create an instance id, read/write sync state, or derive the product board. Disabled registry entries
    // still count so a team whose home mirrors were all switched off can be cleared.
    if (!live.some(([, e]) => e.enabled && modeOf(e.localProject) !== "off") && !mirrors().some(([, e]) => modeOf(e.localProject) !== "off")) return;
    const self = instanceIdSync(dir);
    const groups = groupsOf(live, mirrors(), self).filter((g) => groupMode(g, policy) !== "off");
    const file = readState(path), before = JSON.stringify(file);
    let limited = false;
    try {
      for (const g of groups) {
        const mode = groupMode(g, policy);
        if (mode === "off") continue;
        const st = file.groups[g.id] ??= fresh(), at = now(), scope = scopeOf(g);
        delete st.clearObservedAt;
        try {
          if (st.lastComputedAt === null || at - st.lastComputedAt >= COMPUTE_MS || at < st.lastComputedAt) {
            st.wouldSend = null; st.lastComputedAt = at; st.scopeHash = null;
            try {
              st.wouldSend = db.transaction(() => compute(db, g, at)).deferred(); st.scopeHash = scope;
              delete st.skipped; delete st.skippedEdges;
            } catch (error) { if (computeErrorHandled(file, st, error, mode, at)) continue; throw error; }
          }
          if (mode !== "on" || !st.wouldSend || st.scopeHash !== scope) continue;
          const body = st.wouldSend, currentHash = hash(body);
          if (uploadBlocked(file, g.centerId, st, at) || (st.hash === currentHash && st.lastSentAt !== null && at - st.lastSentAt < RESEND_MS)) continue;
          const credential = resolveMirrorCredential(g.entries.find(([, e]) => e.sourceInstanceId === g.sourceInstanceId)![1], dir);
          if (!credential || credential.instanceId !== g.sourceInstanceId) throw new Error("credential unavailable");
          await wait();
          // The policy or registry may change while waiting: never send a snapshot computed under older authority.
          const current = groupsOf(live, mirrors(), g.sourceInstanceId).find((x) => x.id === g.id);
          if (!current || groupMode(current, policy) !== "on" || scopeOf(current) !== scope
            || sharedLedgerNotBefore(credential.baseUrl, dir) > now()) continue;
          const client = clientFor(credential);
          if (!client) throw new Error("credential unavailable");
          const receipt = await client.uploadFeatureDeps(body);
          if (receipt.schemaVersion !== 1 || receipt.accepted !== body.edges.length) throw new Error("receipt mismatch");
          st.hash = currentHash; st.lastSentAt = now(); st.failures = 0; st.nextAttemptAt = 0; st.unsupportedUntil = 0;
          rememberSent(st, current);
        } catch (error) { if (uploadFailed(file, g.centerId, st, error, now())) { limited = true; break; } }
      }
      if (!limited) await clearStaleGroups(file, { self, now, mirrors, mode: modeOf, wait, client: clientFor,
        credential: (key) => resolveMirrorCredential(key, dir), notBefore: (baseUrl) => sharedLedgerNotBefore(baseUrl, dir) });
    } finally { if (JSON.stringify(file) !== before) writeJsonAtomicSync(path, file, { mode: 0o600 }); }
  } catch {
    console.error("团队依赖上传本轮失败（已隔离，不影响镜像推送）");
  }
}

/** Coverage of the replacement the center now holds, written only with a validated receipt: a later unsent computation
 * must not drop a project whose off policy still has to block a stale clear. Needed once the mirror entries are gone. */
function rememberSent(st: GroupState, g: Group): void {
  st.projects = [...new Set(g.entries.map(([, e]) => e.localProject))].sort();
  st.centerProjects = [...new Set(g.entries.filter(([, e]) => e.sourceInstanceId === g.sourceInstanceId).map(([, e]) => e.projectId))].sort();
}
