/**
 * REPLPULL1 background center-replica pull: every 5 minutes, per local project bound to a center project with an owner:self
 * service credential, one call of the existing syncCenterReplicas (no other center read, no other writer). Recovery key
 * centerReplicaPull, read per local project each round:
 * - off: no call. observe: a dryRun sync over a read-only ledger connection (`readDb`, closed after the round; no lock, nothing
 *   written, an existing instance key only read) and one log line per would-be create / replay / skip / refusal, once per (center feature, version / reason) for the
 *   life of the process. on: a real sync over `db`; landed / replayed features get the replica writer's usual events.
 * - A failed round (network, 401, timeout, unreadable state, a feature whose detail read or landing failed) logs one line with
 *   the error name / fixed reason only; the next round retries.
 * - A policy read that fails (source "error", or a policy port that throws) counts as off for that project (fail closed: no
 *   center request, no write) and logs one fixed line.
 * - The sync lock is taken with no wait: while a CLI `center-replica sync` (or an earlier round) runs, this round is skipped.
 * Wiring (timer, ledger, policy) lives in shared-ledger-center-replica-pull-wiring.ts. tests/shared-ledger-center-replica-pull.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { InstanceKey } from "./instance-key.js";
import { STATE_DIR } from "./paths.js";
import type { RecoveryKey, RecoveryMode } from "./recovery-policy.js";
import { readSharedLedgerBindings } from "./shared-ledger-gate-bindings.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { syncCenterReplicas, type ReplicaResult } from "./shared-ledger-center-replica.js";

export const CENTER_REPLICA_PULL_INTERVAL_MS = 5 * 60_000;
const KEY: RecoveryKey = "centerReplicaPull";
const WOULD: Record<ReplicaResult["result"], string> = {
  created: "本会新建", replayed: "本会更新", unchanged: "", skipped: "本会跳过", refused: "本会拒收", failed: "",
};

export interface CenterReplicaPullDeps {
  /** Writable ledger (on). */
  db: () => Database;
  /** A fresh read-only ledger connection (observe); the round closes it. */
  readDb: () => Database;
  /** recoveryPolicy shape: it never throws; an unreadable file / unknown key comes back as mode off with source "error". */
  policy: (project: string, key: RecoveryKey) => { mode: RecoveryMode; source?: "config" | "default" | "error" };
  log: (line: string) => void;
  stateDir?: string;
  fetch?: typeof fetch;
  key?: () => InstanceKey | null;
  now?: () => number;
  /** observe dedup across rounds: `<center feature>@<version or reason>` already logged. */
  seen?: Set<string>;
}

export interface CenterReplicaPullRound { project: string; mode: RecoveryMode; busy?: boolean; error?: string; features: ReplicaResult[] }

/** Local projects with at least one center binding whose scope has a usable service credential (others are not pulled). */
function pullableProjects(dir = STATE_DIR): string[] {
  const out = new Set<string>();
  for (const b of readSharedLedgerBindings(dir)) {
    if (resolveMirrorCredential({ centerId: b.centerId, teamId: b.teamId, projectId: b.projectId }, dir)) out.add(b.localProjectId ?? b.projectId);
  }
  return [...out];
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

/** One round over every pullable project; never throws. */
export async function runCenterReplicaPull(deps: CenterReplicaPullDeps): Promise<CenterReplicaPullRound[]> {
  const dir = deps.stateDir ?? STATE_DIR, seen = deps.seen ?? new Set<string>(), rounds: CenterReplicaPullRound[] = [];
  let projects: string[];
  try { projects = pullableProjects(dir); }
  catch (e) { deps.log(`[center-replica-pull] 读绑定失败: ${errorName(e)}`); return rounds; }
  for (const project of projects) {
    let mode: RecoveryMode;
    try {
      const policy = deps.policy(project, KEY);
      mode = policy.mode;
      // recoveryPolicy reports a bad file as off + source "error": logged with a fixed text (its diagnostic names local paths).
      if (policy.source === "error") { deps.log(`[center-replica-pull] ${project} 读档位失败: 恢复策略不可用，本轮按 off 处理`); mode = "off"; }
    } catch (e) {
      // Fail closed: an unreadable policy must not start center reads or writes; logged so it is not mistaken for a chosen off.
      deps.log(`[center-replica-pull] ${project} 读档位失败: ${errorName(e)}，本轮按 off 处理`);
      mode = "off";
    }
    if (mode === "off") { rounds.push({ project, mode, features: [] }); continue; }
    rounds.push(await pullProject(deps, dir, seen, project, mode));
  }
  return rounds;
}

async function pullProject(deps: CenterReplicaPullDeps, dir: string, seen: Set<string>, project: string, mode: "observe" | "on"): Promise<CenterReplicaPullRound> {
  let readOnly: Database | null = null;
  try {
    const db = mode === "observe" ? (readOnly = deps.readDb()) : deps.db();
    const out = await syncCenterReplicas(db, { stateDir: dir, localProject: project, dryRun: mode === "observe", syncLock: "skip",
      ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.key ? { key: deps.key } : {}), ...(deps.now ? { now: deps.now } : {}) });
    const busy = "busy" in out && out.busy === true;
    // Scope errors (list read) and feature-level failures (detail read, landing) together: one line per round.
    const errors = [...new Set([...out.scopes.flatMap((s) => (s.error ? [s.error] : [])),
      ...out.features.flatMap((f) => (f.result === "failed" ? [f.reason] : []))])];
    const error = errors.length ? errors.join("；") : undefined;
    if (error) deps.log(`[center-replica-pull] ${project} 本轮失败: ${error}`);
    if (mode === "observe") logWouldBe(deps.log, seen, project, out.features);
    return { project, mode, features: out.features, ...(busy ? { busy } : {}), ...(error ? { error } : {}) };
  } catch (e) {
    deps.log(`[center-replica-pull] ${project} 本轮失败: ${errorName(e)}`);
    return { project, mode, error: errorName(e), features: [] };
  } finally {
    readOnly?.close();
  }
}

function logWouldBe(log: (line: string) => void, seen: Set<string>, project: string, features: readonly ReplicaResult[]) {
  for (const f of features) {
    const verb = WOULD[f.result];
    if (!verb) continue;
    const mark = `${f.centerFeatureId}@${"version" in f ? `v${f.version}` : f.reason}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const detail = "version" in f ? `${f.localFeatureId} v${f.version}` : f.reason;
    log(`[center-replica-pull] observe ${project}: ${verb} ${f.centerFeatureId}（${detail}）`);
  }
}
