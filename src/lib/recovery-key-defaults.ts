/**
 * OBSGATE1 · the default mode of a recovery key that neither its project's keys nor its project mode set (recovery-policy.ts
 * reads keys[key] → project mode → defaultRecoveryMode(key)). Keys that existed when this card merged keep observe word for
 * word; the high-risk classes (recovery-key-class.ts: safety / permission / delete-data / schema) observe first; any other key
 * added later is on. Rolling one back: `ledger scheduler-recovery <project> off --key <key> --reason ...`; a whole project: its mode.
 * The first time the gate reads a key that is on only by this default, one note op=recovery_default_on per project + key.
 * docs/architecture/recovery-key-defaults.md; tests/recovery-key-defaults.test.ts, tests/recovery-key-sample-sink.test.ts.
 */
import type { Database } from "bun:sqlite";
import { appendEvent } from "./ledger-write.js";
import { highRiskRecoveryKey } from "./recovery-key-class.js";
import type { RecoveryKey, RecoveryMode, RecoveryPolicy } from "./recovery-policy.js";

/** Frozen snapshot: every key on main when OBSGATE1 merged. Never add to it (a new key belongs to the new defaults). */
export const LEGACY_OBSERVE_KEYS: readonly string[] = Object.freeze([
  "askDefaultAll", "askReminder", "audit", "auditEscalate", "auditIdleFacts", "auditMirrorPush", "auditStall", "auditTrainQueue",
  "authorRebuild", "cardPause", "cardProcReap", "centerReplicaPull", "centerRequestBudget", "ciCancelRerun", "ciClaimUnsent",
  "ciCoverageGate", "ciIoMapFuse", "ciKnownFlaky", "ciLogPerJob", "ciManualResume", "ciProofReuse", "ciQueueFull",
  "ciSelectedGate", "ciTrainFailureClass", "ciWebBuild", "convIgnoredBuildArtifacts", "convergenceStall", "dagWriteScrub",
  "deployFirst", "deployReconcile", "effCountCarry", "effCountRefresh", "featureDeps", "fixLocalSwap", "iaWatchdogScope",
  "lendAuthorRebuild", "lendConfigFailure", "lendReclaimIntent", "lendUiShots", "lendUiUpload", "lendUsageReport",
  "localDelivery", "localFallback", "localReviewAdopt", "lockYield", "mainCarry", "mainCarryMerge", "mainCiPause",
  "manualCaseOwnership", "manualCaseSla", "manualMergeQueue", "manualRecovery", "manualStall", "materials", "mergeContentReview",
  "mergeContentUi", "mergeDeployDetach", "mergeDirect", "mergePipe", "mergeStaleYield", "mergeUnifiedCandidates", "mergeUnion",
  "mergeUnsentCancel", "mirrorSkipBlockedId", "modelOutcome", "nearMarker", "peerInstanceInfo", "peerLeaseRecovery",
  "placementReservations", "planGap", "pmRails", "poolIdleSkip", "privateMergeNarrow", "privateRepoMerge", "privateStartPlacement",
  "reclaimLocalFix", "reviewLocalFirst", "reviewSeatIdle", "roleModel", "selfHealBeforeManual", "skipEffectsAutoScope",
  "specObservationHours", "staleReplacement", "teamBody", "tmuxSockHeal", "trainCiTimeout", "uiCarry", "uiCarryOwnGlobs",
  "uiDelivery", "uiManualResume", "uiOwnerAskFresh", "uiOwnerCarry", "uiOwnerReask", "uiReviewCarry", "unifiedMergeQueue",
  "updateGap", "wakeStopped", "writeLocalEqual",
]);

/**
 * Old keys the sample-sink scan (recovery-key-defaults-scan.ts) finds no sample write for. May only shrink: give a key a sink
 * and take it out; tests/recovery-key-sample-sink.test.ts fails on any key not in LEGACY_OBSERVE_KEYS or a longer list.
 */
export const LEGACY_NO_SAMPLE_KEYS: readonly string[] = Object.freeze([
  "askReminder", "audit", "auditEscalate", "auditIdleFacts", "auditMirrorPush", "auditStall", "auditTrainQueue", "cardProcReap",
  "centerReplicaPull", "centerRequestBudget", "ciKnownFlaky", "ciManualResume", "ciProofReuse", "ciWebBuild", "convergenceStall",
  "deployFirst", "featureDeps", "lendConfigFailure", "lendUiUpload", "lendUsageReport", "localDelivery", "localReviewAdopt",
  "mainCarry", "mainCarryMerge", "manualCaseOwnership", "manualCaseSla", "manualRecovery", "mergeContentReview",
  "mergeDeployDetach", "modelOutcome", "nearMarker", "peerInstanceInfo", "placementReservations", "planGap", "pmRails",
  "poolIdleSkip", "skipEffectsAutoScope", "specObservationHours", "staleReplacement", "tmuxSockHeal", "uiManualResume",
  "unifiedMergeQueue", "updateGap",
]);

/** Permission keys (including peerPrAutoVerify) inherit observe from the classifier, never the frozen legacy snapshot. */
export function defaultRecoveryMode(key: RecoveryKey, legacy: readonly string[] = LEGACY_OBSERVE_KEYS,
  highRisk: (key: RecoveryKey) => boolean = highRiskRecoveryKey): RecoveryMode {
  return legacy.includes(key) || highRisk(key) ? "observe" : "on";
}

/** Policies recoveryPolicy answered on only by defaultRecoveryMode (the object itself, so an injected port never counts). */
const DEFAULT_ON = new WeakSet<RecoveryPolicy>();
/** recoveryPolicy's tail: `explicit` is keys[key] ?? project mode; nothing explicit and on = on by default. */
export function markDefaultOn(p: RecoveryPolicy, explicit: RecoveryMode | undefined): RecoveryPolicy {
  if (explicit === undefined && p.mode === "on") DEFAULT_ON.add(p);
  return p;
}

const noted = new WeakMap<Database, Set<string>>();
/**
 * The gate's read: a policy on by default leaves one project-level note per project + key (dedup in the ledger; a per-connection
 * memo saves the repeat transaction, kept only for a write that committed on its own). Bookkeeping only: a failed write (a query_only connection) never changes the gate.
 */
export function noteDefaultOn(db: Database, a: { project: string; mechanism: RecoveryKey }, p: RecoveryPolicy, now: number): RecoveryPolicy {
  if (!DEFAULT_ON.has(p)) return p;
  const dedupKey = `recovery-default-on:${JSON.stringify([a.project, a.mechanism])}`;
  const seen = noted.get(db) ?? new Set<string>();
  if (seen.has(dedupKey)) return p;
  try {
    appendEvent(db, { actor: "scheduler", now, dedupKey }, { project: a.project, target: "", kind: "note",
      text: `恢复键 ${a.mechanism} 未配置，按新键缺省档 on 生效（回退：ledger scheduler-recovery ${a.project} off --key ${a.mechanism} --reason …）`,
      data: { op: "recovery_default_on", mechanism: a.mechanism } });
    if (!db.inTransaction) noted.set(db, seen.add(dedupKey)); // inside an outer transaction a rollback could drop the note: no memo
  } catch { /* retried on the next read */ }
  return p;
}
