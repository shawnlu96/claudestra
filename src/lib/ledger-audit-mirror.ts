/**
 * team-project-N8B7：共享镜像推送连续失败报给 PM（规则 mirror_push_failing）。
 * 事实只从镜像状态文件（shared-ledger-mirror.ts readSharedLedgerMirrors）读本项目镜像中的 feature：投影失败看 lastError / failures，
 * DAG 版本推送失败看 dagError；两类分开，各自 failures ≥ 3 报一条。理由只用状态文件里的固定理由（shared-ledger-source-dag-push.ts
 * SOURCE_DAG_REASONS、shared-ledger-projector.ts mirrorErrorSummary），不读、不回显被拦的原文。镜像循环、推送、外发闸都不动。
 * 去重 key = featureId + 类别 + 固定理由 + 随成功而变的值（DAG：本机当前 DAG 版本号；投影：lastPushSeq）。
 * 开关 = 恢复策略 auditMirrorPush（缺省 observe；策略读不了 = off）：
 * - off：不评估（不进 evaluated，旧发现原样留着）。
 * - observe：照常评估、进 evaluated（建基线、结清旧的），条目不进 findings、不推；每条写进 skipped，reason 以「观察中：」开头，
 *   `ledger audit --dry-run` 的 skipped 里可见。切 on 时基线已在，首轮照推、不被首轮静默吞掉。
 * - on：照常推送。
 * 状态文件读不了 / 坏了：本规则 skipped，其他规则不受影响。tests/ledger-audit-mirror*.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { AuditFinding, AuditRule } from "./ledger-audit.js";
import { getFeature } from "./ledger-feature.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { readSharedLedgerMirrors } from "./shared-ledger-mirror.js";

export const MIRROR_PUSH_RULES = ["mirror_push_failing"] as const;
/** 连续失败满这么多次才报 */
export const MIRROR_PUSH_FAILURES = 3;

/** 一个镜像中 feature 的一类推送失败 */
interface MirrorPushFact {
  featureId: string;
  kind: "projection" | "dag";
  /** 状态文件里的固定理由 */
  reason: string;
  failures: number;
  /** 最近一次失败的时刻 */
  at: number;
  /** 随成功而变的值：DAG = 本机当前 DAG 版本号（读不到 = "none"），投影 = lastPushSeq（没推成过 = "none"） */
  mark: number | string;
}
/** undefined = 快照没带（规则不跑也不列 skipped）；unreadable = 状态文件读不了（skipped） */
export interface MirrorPushInputs { mirrorPush?: { facts: readonly MirrorPushFact[] } | { unreadable: string } }

/** 只读取数：本项目镜像中（enabled）的 feature 各类失败；dir = 状态目录 */
export function readMirrorPush(db: Database, project: string, dir: string): NonNullable<MirrorPushInputs["mirrorPush"]> {
  let mirrors: ReturnType<typeof readSharedLedgerMirrors>;
  try {
    mirrors = readSharedLedgerMirrors(dir);
  } catch {
    return { unreadable: "共享镜像状态文件读不了或已损坏" };
  }
  const facts: MirrorPushFact[] = [];
  for (const [featureId, e] of Object.entries(mirrors)) {
    if (!e.enabled || e.localProject !== project) continue;
    if (e.lastError !== null && e.failures > 0) {
      facts.push({ featureId, kind: "projection", reason: e.lastError, failures: e.failures, at: e.lastErrorAt ?? 0, mark: e.lastPushSeq ?? "none" });
    }
    const d = e.dagError;
    if (d && d.failures > 0) {
      let version: number | string = "none";
      try { version = getFeature(db, featureId)?.currentVersion ?? "none"; } catch { /* 本机版本读不到：按 none 去重 */ }
      facts.push({ featureId, kind: "dag", reason: d.reason, failures: d.failures, at: d.at, mark: version });
    }
  }
  return { facts };
}

function mirrorMode(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try {
    return policy(project, "auditMirrorPush").mode;
  } catch {
    return "off"; // 策略读不了：保守不评估
  }
}

type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] }) => void;
interface Out { emit: Emit; evaluated: AuditRule[]; skip: (reason: string, ...rules: AuditRule[]) => void }

const KIND_TEXT = { projection: "投影", dag: "DAG" } as const;

export function mirrorPushAudit(s: { project: string } & MirrorPushInputs, policy: RecoveryPolicyPort, out: Out): void {
  const m = s.mirrorPush;
  if (m === undefined) return;
  const mode = mirrorMode(policy, s.project);
  if (mode === "off") return;
  if ("unreadable" in m) return out.skip(m.unreadable, "mirror_push_failing");
  for (const f of m.facts) {
    if (f.failures < MIRROR_PUSH_FAILURES) continue;
    const detail = `${f.featureId} 共享镜像${KIND_TEXT[f.kind]}推送连续失败 ${f.failures} 次：${f.reason}`;
    if (mode === "observe") { out.skip(`观察中：${detail}`, "mirror_push_failing"); continue; }
    out.emit({ rule: "mirror_push_failing", taskId: null, since: f.at, keyParts: [f.featureId, f.kind, f.reason, f.mark], detail,
      suggestion: `ledger shared-mirror status ${f.featureId} 看详情；理由是含不能外发的内容时，查最新 DAG 版本说明和节点文字里的长串、绝对路径，PM 改自己的文字后重写一版，不改外发闸` });
  }
  out.evaluated.push("mirror_push_failing");
}
