/**
 * 中心副本节点自动开卡的门（merge-arch-CREPAUTO1）。恢复键 centerReplicaAutostart（permission 类，缺省 observe）：off / observe 时
 * featureGate 照旧整 feature 跳过；on 且本机是该团队成员时放行，节点照常过开关 / 规格 / 车道门，再过这里的副本节点门。
 * 只读：台账、认领文件、模式与凭据文件；scheduler-autostart.ts 的 featureGate / nodeCandidate 各一行接进来（claim 事务重核也走它们）。
 * 认领与开卡在 center-replica-autostart-run.ts，台账写口在 center-replica-autostart-ledger.ts；tests/center-replica-autostart.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { instanceIdSync } from "./instance-id.js";
import { claimDedup, getClaim, settleDedup } from "./ledger-autostart-grant.js";
import { cardNames } from "./ledger-card-names.js";
import type { Feature } from "./ledger-feature.js";
import { getEventByDedup } from "./ledger-store.js";
import { STATE_DIR } from "./paths.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readCenterClaims } from "./shared-ledger-center-claims.js";
import { readSharedLedgerMode, resolveSharedLedgerCredential } from "./shared-ledger-mode.js";

export const CENTER_REPLICA_AUTOSTART_KEY = "centerReplicaAutostart" as const;

/** 读不到策略按 off：维持改动前的整 feature 跳过 */
export function centerReplicaMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    const mode = policy(project, CENTER_REPLICA_AUTOSTART_KEY).mode;
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch { return "off"; } // recoveryPolicy itself never throws; an injected port that does keeps the old skip
}

/** feature 是中心副本（模式文件记了 centerPlanned）；读不了 = 不是（featureGate 的共享原因照旧拦住它） */
export function isCenterReplica(featureId: string, dir = STATE_DIR): boolean {
  try { return !!readSharedLedgerMode(featureId, dir).centerPlanned; } catch { return false; } // unreadable: sharedLedgerPlanningReason already stops it
}

/** 本机是副本所属团队的成员：有该团队项目 owner:self 的 service 凭据且实例与本机一致（中心认领 credentialFor 同一口径） */
export function centerReplicaMember(featureId: string, dir = STATE_DIR): boolean {
  try {
    const cp = readSharedLedgerMode(featureId, dir).centerPlanned;
    if (!cp) return false;
    const c = resolveSharedLedgerCredential("owner:self", "service", cp.centerId, cp.teamId, cp.projectId, "project", dir);
    const me = instanceIdSync(dir);
    return !!c && c.kind === "service" && !!me && c.instanceId === me;
  } catch { return false; } // unreadable mode / credentials: not provably a member, the feature stays skipped
}

/** featureGate 的放行条件：开关 on、是中心副本、本机是成员 */
export function centerReplicaFeatureOpen(f: { id: string; project: string }): boolean {
  return centerReplicaMode(f.project) === "on" && centerReplicaMember(f.id);
}

/** 中心拒绝（冲突等）记下的 note 的去重键：同一副本版本 + 同一 arm 只试一次；中心发新版本（sync 后）或规格改了才再试 */
export const centerSkipDedup = (featureId: string, key: string, version: number, arm: string): string =>
  `center-replica-skip:${JSON.stringify([featureId, key, version, arm])}`;

/** 不可达 / 锁忙 / 认领文件读写失败这类一时的拒绝：不记 note，进程内冷却这么久再试，期间不占每轮唯一的开卡名额 */
const TRANSIENT_COOLDOWN_MS = 10 * 60_000;
const cooling = new Map<string, number>();
const coolKey = (featureId: string, key: string) => JSON.stringify([featureId, key]);
export function coolCenterNode(featureId: string, key: string, now: number): void {
  if (cooling.size > 500) for (const [k, until] of cooling) if (until <= now) cooling.delete(k);
  cooling.set(coolKey(featureId, key), now + TRANSIENT_COOLDOWN_MS);
}

/** 副本节点门（nodeCandidate 在 arm 算出后调）：非副本 = null。记过中心拒绝、冷却中、认领文件不可读、认领已成孤儿都不开 */
export function centerReplicaNodeStop(db: Database, f: { id: string; currentVersion: number }, key: string, arm: string, now: number,
  dir = STATE_DIR): string | null {
  if (!isCenterReplica(f.id, dir)) return null;
  const noted = getEventByDedup(db, centerSkipDedup(f.id, key, f.currentVersion, arm));
  if (noted) return `中心拒绝过这个节点（#${noted.seq}）：同一副本版本、同一份规格不再自动认领；中心发新版本或改了规格卡再试`;
  if ((cooling.get(coolKey(f.id, key)) ?? 0) > now) return "上次认领时中心不可达或本机认领记录忙，冷却中";
  let mine;
  try { mine = readCenterClaims(dir).filter((c) => c.localFeatureId === f.id && c.key === key); }
  catch { return "本机中心认领记录不可读"; } // corrupt claims file: every claim path refuses anyway
  return mine.some((c) => c.state === "orphan") ? "这个节点的中心认领已成孤儿（开卡失败回滚过），要先撤销中心绑定" : null;
}

/** 本机对这个副本节点已有的中心认领（pending / committed）的卡号：认领沿用它，不按默认卡号重新认领；没有 / 不是副本 / 读不了 = null */
export function centerClaimTaskId(featureId: string, key: string, dir = STATE_DIR): string | null {
  if (!isCenterReplica(featureId, dir)) return null;
  try {
    return readCenterClaims(dir).find((c) => c.localFeatureId === featureId && c.key === key && (c.state === "committed" || c.state === "pending"))?.taskId ?? null;
  } catch { return null; } // unreadable: centerReplicaNodeStop stops the node before any claim
}

/**
 * 台账 claim（ledger-autostart.ts claimNode）的卡名：副本节点有本机认领时按认领的卡号派生（agent / 分支与 start_node 显式 taskId 同一规则），
 * 否则 null 走 cardNames。来源是本机认领文件，仍不收调用方给的值。
 */
export function centerReplicaCardNames(db: Database, f: Feature, key: string, dir = STATE_DIR): ReturnType<typeof cardNames> | null {
  const taskId = centerClaimTaskId(f.id, key, dir);
  if (!taskId) return null;
  const low = taskId.toLowerCase();
  return { slug: cardNames(db, f, key).slug, taskId, agent: `agent-${`task-${low.replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48)}`, branch: `feat/${low}` };
}

/**
 * 断链补建（[验收线 3]）：同一 arm 的上一次 claim 结成 unknown（进程在建卡前断了）、它的卡号一张卡都没建、中心那份认领仍 committed，
 * 就再给一次补建，arm 换成由原 arm 派生的补建 arm；补建 arm 也 claim 过就不再给（台账 dedup 兜底，最多一次）。别的情况 null（照旧 armed）。
 */
export function centerRepairArm(db: Database, f: { id: string }, key: string, taskId: string, arm: string, priorSeq: number, dir = STATE_DIR): string | null {
  if (!isCenterReplica(f.id, dir)) return null;
  const prior = getClaim(db, priorSeq);
  if (!prior || prior.taskId !== taskId || getEventByDedup(db, settleDedup(priorSeq))?.data.outcome !== "unknown") return null;
  if (db.query("SELECT id FROM tasks WHERE id = ? COLLATE NOCASE").get(taskId)) return null;
  let committed = false;
  try { committed = readCenterClaims(dir).some((c) => c.localFeatureId === f.id && c.key === key && c.state === "committed" && c.taskId === taskId); }
  catch { return null; } // unreadable: centerReplicaNodeStop stops the node anyway
  const again = createHash("sha256").update(`center-repair:${arm}`).digest("hex").slice(0, 16);
  return committed && !getEventByDedup(db, claimDedup(f.id, key, again)) ? again : null;
}

/** 已有本机 committed 认领（补建卡），否则是要新认领 */
export function centerClaimAction(featureId: string, key: string, dir = STATE_DIR): "repair" | "claim" {
  try { return readCenterClaims(dir).some((c) => c.localFeatureId === featureId && c.key === key && c.state === "committed") ? "repair" : "claim"; }
  catch { return "claim"; } // unreadable: the node gate already stopped it; the label is only for the observe record
}
