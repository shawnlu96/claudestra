/**
 * team-project-N8B7：共享镜像推送连续失败报给 PM（规则 mirror_push_failing）。
 * 事实只从镜像状态文件（shared-ledger-mirror.ts readSharedLedgerMirrors）读本项目镜像中的 feature：投影失败看 lastError / failures，
 * DAG 版本推送失败看 dagError；两类分开，各自 failures ≥ 3 报一条。理由只用状态文件里的固定理由（shared-ledger-source-dag-push.ts
 * SOURCE_DAG_REASONS、shared-ledger-projector.ts mirrorErrorSummary），不读、不回显被拦的原文。镜像循环、推送、外发闸都不动。
 * 去重 key = featureId + 类别 + 固定理由 + 随成功而变的值（DAG：本机当前 DAG 版本号；投影：lastPushSeq）。
 * 开关 = 恢复策略 auditMirrorPush（缺省 observe；策略读不了 = off）：
 * - off：不评估（不进 evaluated，旧发现原样留着）。
 * - observe：照常评估、进 evaluated（建基线、结清已不再失败的旧发现），条目不进 findings、不推；每条写进 skipped，reason 以「观察中：」开头，
 *   `ledger audit --dry-run` 的 skipped 里可见。仍满足条件的 key 同时 keep 住：on 时已推过的旧发现保持打开、不被当成恢复结清，
 *   切回 on 不重推同一段失败；on 时落库没送达的也不在 observe 下发。切 on 时基线已在，首轮照推、不被首轮静默吞掉。
 * - on：照常推送。
 * 状态文件读不了 / 坏了（含本规则消费的 lastError / lastErrorAt / lastPushSeq / dagError 字段类型不对）：本规则 skipped，其他规则不受影响；
 * 旧 reader 只校验基础字段，这里自己校验消费的字段，不信它的类型断言。tests/ledger-audit-mirror*.test.ts。
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

const UNREADABLE = "共享镜像状态文件读不了或已损坏";
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const optCount = (n: unknown) => n === null || n === undefined || count(n);
type DagError = { reason: string; at: number; failures: number };
/** dagError 缺省 / null = 没有 DAG 失败（旧状态没这个字段）；有就得是 { reason 非空串, at 计数, failures 计数 } */
const dagErrorOk = (d: unknown): d is DagError | null | undefined => d === null || d === undefined
  || (typeof d === "object" && !Array.isArray(d) && typeof (d as DagError).reason === "string" && !!(d as DagError).reason
    && count((d as DagError).at) && count((d as DagError).failures));
/** 本规则消费的字段：lastError 为 null 或非空串，lastErrorAt / lastPushSeq 为 null 或计数，dagError 见上 */
function entryOk(e: Record<string, unknown>): boolean {
  return (e.lastError === null || (typeof e.lastError === "string" && !!e.lastError)) && optCount(e.lastErrorAt) && optCount(e.lastPushSeq)
    && dagErrorOk(e.dagError);
}

/** 只读取数：本项目镜像中（enabled）的 feature 各类失败；dir = 状态目录。消费字段坏了 = unreadable（不半截评估、不误结清） */
export function readMirrorPush(db: Database, project: string, dir: string): NonNullable<MirrorPushInputs["mirrorPush"]> {
  let mirrors: ReturnType<typeof readSharedLedgerMirrors>;
  try {
    mirrors = readSharedLedgerMirrors(dir);
  } catch {
    return { unreadable: UNREADABLE };
  }
  const facts: MirrorPushFact[] = [];
  for (const [featureId, e] of Object.entries(mirrors)) {
    if (!e.enabled || e.localProject !== project) continue;
    if (!entryOk(e as unknown as Record<string, unknown>)) return { unreadable: UNREADABLE };
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
interface Out {
  emit: Emit; evaluated: AuditRule[]; skip: (reason: string, ...rules: AuditRule[]) => void; keep: (rule: AuditRule, keyParts: (string | number)[]) => void;
}

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
    const keyParts = [f.featureId, f.kind, f.reason, f.mark];
    // observe：不推，但同一段失败的 key 保持打开（不当成恢复结清、不清 notifiedAt），切回 on 不重推
    if (mode === "observe") { out.skip(`观察中：${detail}`, "mirror_push_failing"); out.keep("mirror_push_failing", keyParts); continue; }
    out.emit({ rule: "mirror_push_failing", taskId: null, since: f.at, keyParts, detail,
      suggestion: `ledger shared-mirror status ${f.featureId} 看详情；理由是含不能外发的内容时，查最新 DAG 版本说明和节点文字里的长串、绝对路径，PM 改自己的文字后重写一版，不改外发闸` });
  }
  out.evaluated.push("mirror_push_failing");
}
