/** Home-side structural edges, independent of projection watermarks. Full replacement is per center/team/instance,
 * so live (a bounded, due-only slice) selects teams, while the full enabled mirror registry supplies endpoints.
 * Only split/declared/task fields are reconstructed; notes, lock paths and card evidence never enter the state or upload.
 * A mixed team stays observe (or pauses for off) because replacing only its on projects would delete the others' edges.
 * The mirror pass owns the push lock. Failures here never escape into projection work. tests/feature-deps-sync.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync } from "./instance-key.js";
import { productBoard } from "./ledger-product-board.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { sharedLedgerNotBefore } from "./shared-ledger-client-transport.js";
import { readSharedLedgerMirrors, resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { mirrorBackoffMs, type MirrorEntry } from "./shared-ledger-projector.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { parseFeatureDepsUpload, type FeatureDep, type FeatureDepsUpload } from "./shared-ledger-contract-feature-deps.js";
import { digest, integer, literal, nullable, object, record } from "./shared-ledger-contract-schema.js";

type Entries = readonly (readonly [string, MirrorEntry])[];
type UploadClient = Pick<SharedLedgerClient, "uploadFeatureDeps">;
interface SyncDeps {
  stateDir?: string; now?: () => number; requestGapMs?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch;
  client?: (credential: SharedLedgerLocalCredential) => UploadClient | null;
  /** Tests inject the complete registry, never the due-only live slice. */
  mirrors?: () => Entries;
}
const COMPUTE_MS = 300_000, RESEND_MS = 6 * 3600_000, DAY_MS = 86400_000;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const groupSchema = object({ hash: nullable(digest), scopeHash: nullable(digest), lastSentAt: nullable(integer), lastComputedAt: nullable(integer),
  unsupportedUntil: integer, cooldown: integer, failures: integer, nextAttemptAt: integer, wouldSend: nullable(parseFeatureDepsUpload) });
type GroupState = ReturnType<typeof groupSchema>;
interface SyncFile { schemaVersion: 1; groups: Record<string, GroupState>; notedDays: Record<string, number>; cooldowns: Record<string, number> }
const fresh = (): GroupState => ({ hash: null, scopeHash: null, lastSentAt: null, lastComputedAt: null,
  unsupportedUntil: 0, cooldown: 0, failures: 0, nextAttemptAt: 0, wouldSend: null });

/** Same recovery file and precedence as teamBody. Missing configuration observes; unreadable policy stops. */
export function featureDepsMode(projectId: string, path = RECOVERY_POLICY_PATH): RecoveryMode {
  return recoveryPolicy(projectId, "featureDeps", path).mode;
}
function readState(path: string): SyncFile {
  const state = readJsonStateSync(path);
  if (state.status === "missing") return { schemaVersion: 1, groups: {}, notedDays: {}, cooldowns: {} };
  if (state.status === "corrupt") throw new Error("feature deps state unreadable");
  const row = object({ schemaVersion: literal(1), groups: record, notedDays: record, cooldowns: record })(state.data);
  return { schemaVersion: 1, groups: Object.fromEntries(Object.entries(row.groups).map(([k, v]) => [k, groupSchema(v)])),
    notedDays: Object.fromEntries(Object.entries(row.notedDays).map(([k, v]) => [k, integer(v)])),
    cooldowns: Object.fromEntries(Object.entries(row.cooldowns).map(([k, v]) => [k, integer(v)])) };
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
  edges.sort((a, b) => JSON.stringify([a.projectId, a.from, a.to, a.kind]).localeCompare(JSON.stringify([b.projectId, b.from, b.to, b.kind])));
  return parseFeatureDepsUpload({ schemaVersion: 1, teamId: g.teamId, sourceInstanceId: g.sourceInstanceId, edges });
}
function realClient(credential: SharedLedgerLocalCredential, dir: string, deps: SyncDeps): UploadClient | null {
  const key = instanceKeySync(dir);
  return key ? new SharedLedgerClient(credential, key, { fetch: deps.fetch, now: deps.now, stateDir: dir }) : null;
}
function failed(file: SyncFile, g: Group, st: GroupState, error: unknown, now: number): boolean {
  if (error instanceof SharedLedgerRemoteError && [403, 404].includes(error.status)) {
    st.unsupportedUntil = now + RESEND_MS;
    const day = Math.floor(now / DAY_MS);
    if (file.notedDays[g.centerId] !== day) {
      file.notedDays[g.centerId] = day;
      console.warn("团队依赖：中心暂不支持 feature-deps，六小时后重试");
    }
  } else if (error instanceof SharedLedgerRemoteError && error.status === 429) {
    st.cooldown = now + Math.min(60_000, Math.max(0, error.retryAfterMs));
    file.cooldowns[g.centerId] = Math.max(file.cooldowns[g.centerId] ?? 0, st.cooldown);
    return true;
  } else {
    st.failures++;
    st.nextAttemptAt = now + mirrorBackoffMs(st.failures);
    // Fixed text: exceptions can contain credentials or local paths, neither belongs in the sync state or logs.
    console.warn("团队依赖：上传失败，独立退避后重试");
  }
  return false;
}

/** Never throws, including corrupt state or computation errors. An empty changed snapshot is sent to clear old edges. */
export async function syncFeatureDeps(db: Database, live: Entries, deps: SyncDeps = {}): Promise<void> {
  const dir = deps.stateDir ?? STATE_DIR, now = deps.now ?? Date.now, path = join(dir, "feature-deps-sync.json");
  const policy = join(dir, "recovery-policy.json");
  try {
    // off must not create an instance id, read/write sync state, or derive the product board.
    if (!live.some(([, e]) => e.enabled && featureDepsMode(e.localProject, policy) !== "off")) return;
    const mirrors = deps.mirrors ?? (() => Object.entries(readSharedLedgerMirrors(dir)));
    const groups = groupsOf(live, mirrors(), instanceIdSync(dir)).filter((g) => groupMode(g, policy) !== "off");
    if (!groups.length) return;
    const file = readState(path), before = JSON.stringify(file);
    try {
      for (const g of groups) {
        const mode = groupMode(g, policy);
        if (mode === "off") continue;
        const st = file.groups[g.id] ??= fresh(), at = now(), scope = scopeOf(g);
        try {
          if (st.lastComputedAt === null || at - st.lastComputedAt >= COMPUTE_MS || at < st.lastComputedAt) {
            st.wouldSend = null; st.lastComputedAt = at; st.scopeHash = null;
            st.wouldSend = db.transaction(() => compute(db, g, at)).deferred(); st.scopeHash = scope;
          }
          if (mode !== "on" || !st.wouldSend || st.scopeHash !== scope) continue;
          const body = st.wouldSend, currentHash = hash(body);
          if (st.unsupportedUntil > at || Math.max(st.cooldown, file.cooldowns[g.centerId] ?? 0) > at || st.nextAttemptAt > at
            || (st.hash === currentHash && st.lastSentAt !== null && at - st.lastSentAt < RESEND_MS)) continue;
          const credential = resolveMirrorCredential(g.entries.find(([, e]) => e.sourceInstanceId === g.sourceInstanceId)![1], dir);
          if (!credential || credential.instanceId !== g.sourceInstanceId) throw new Error("credential unavailable");
          await (deps.sleep ?? Bun.sleep)(deps.requestGapMs ?? 600);
          // The policy or registry may change while waiting: never send a snapshot computed under older authority.
          const current = groupsOf(live, mirrors(), g.sourceInstanceId).find((x) => x.id === g.id);
          if (!current || groupMode(current, policy) !== "on" || scopeOf(current) !== scope
            || sharedLedgerNotBefore(credential.baseUrl, dir) > now()) continue;
          const client = deps.client ? deps.client(credential) : realClient(credential, dir, deps);
          if (!client) throw new Error("credential unavailable");
          const receipt = await client.uploadFeatureDeps(body);
          if (receipt.schemaVersion !== 1 || receipt.accepted !== body.edges.length) throw new Error("receipt mismatch");
          st.hash = currentHash; st.lastSentAt = now(); st.failures = 0; st.nextAttemptAt = 0; st.unsupportedUntil = 0;
        } catch (error) { if (failed(file, g, st, error, now())) break; }
      }
    } finally { if (JSON.stringify(file) !== before) writeJsonAtomicSync(path, file, { mode: 0o600 }); }
  } catch {
    console.error("团队依赖上传本轮失败（已隔离，不影响镜像推送）");
  }
}
