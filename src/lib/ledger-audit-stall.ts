/** 停滞巡检只产出发现；快照取数与文件占用判定在 ledger-audit-stall-read.ts。 */
import type { AuditFinding, AuditRule, AuditSnapshot } from "./ledger-audit.js";
import type { IdleFactInputs } from "./ledger-audit-idle.js";
import { isAskEvent, type LedgerEvent } from "./ledger-stages.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";

export const STALL_RULES = ["manual_stalled", "lock_blocker_stalled"] as const;
export const MANUAL_STALL_AUDIT_MS = 12 * 3_600_000;
export const LOCK_BLOCKER_STALL_MS = 4 * 3_600_000;
export const STALL_IGNORED_SCHEDULER_OPS = ["memory_rank", "memory_retrieve", "worker_retire", "session_retire", "observe"] as const;
const MANUAL_EXCLUDED_STAGES: readonly string[] = ["spec", "verified", "done", "cancelled"];

/** 服务提醒和记忆活动不代表卡有推进，否则提醒自己会不断推迟停滞门槛。 */
export function isStallProgress(e: Pick<LedgerEvent, "kind" | "actor" | "data">): boolean {
  if (isAskEvent(e)) return false;
  if (e.actor !== "scheduler") return true;
  if (e.kind === "note") return false;
  return e.kind !== "scheduler" || !STALL_IGNORED_SCHEDULER_OPS.some((op) => op === e.data.op);
}

export interface LockBlockerFact {
  taskId: string;
  feature: string;
  node: string;
  files: readonly string[];
}
export interface StallInputs {
  stall?: {
    blockers: { facts: readonly LockBlockerFact[] } | { unreadable: string };
    /** 去掉项目和规则前缀；off 与取数失败时保留旧发现并抑制待推送。 */
    open: Partial<Record<(typeof STALL_RULES)[number], readonly string[]>>;
  };
}
type Snapshot = AuditSnapshot & IdleFactInputs & StallInputs;
type Progress = { at: number; seq: number | null; mark: string; kind: string; actor: string };
function lastProgress(s: Snapshot, t: AuditSnapshot["tasks"][number]): Progress | null {
  const e = t.events.findLast((e) => e.target === t.task.id && isStallProgress(e));
  const transit = s.lendTransit?.[t.task.id], heartbeat = transit?.lastActivityAt;
  if (heartbeat != null && heartbeat > (e?.ts ?? -Infinity)) {
    return { at: heartbeat, seq: e?.seq ?? null, mark: `hb${heartbeat}`, kind: "出借心跳", actor: `出借心跳 ${transit!.peer}` };
  }
  return e ? { at: e.ts, seq: e.seq, mark: `e${e.seq}`, kind: `${e.kind}${typeof e.data.op === "string" ? `/${e.data.op}` : ""}`, actor: e.actor } : null;
}
function stallMode(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try {
    const p = policy(project, "auditStall");
    if (p.source === "error") return "off";
    const mode = p.mode;
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch {
    return "off"; // 策略读失败时保守停手，不评估或发送旧发现。
  }
}
type Finding = Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] };
interface Out {
  emit: (f: Finding) => void;
  evaluated: AuditRule[];
  skip: (reason: string, ...rules: AuditRule[]) => void;
  keep: (rule: AuditRule, parts: (string | number)[]) => void;
}
const progressText = (p: Progress) => `${new Date(p.at).toISOString().slice(0, 16)}Z ${p.kind} actor=${p.actor} seq=${p.seq ?? "无"} 指纹=${p.mark}`;
function report(mode: RecoveryMode, out: Out, f: Finding, stable: string): void {
  if (mode === "observe") {
    out.skip(`观察中:${stable}`, f.rule);
    out.keep(f.rule, f.keyParts);
  } else out.emit(f);
}
function manualAudit(s: Snapshot, now: number, mode: RecoveryMode, out: Out): void {
  for (const t of s.tasks) {
    if (t.workflowMode !== "manual" || MANUAL_EXCLUDED_STAGES.includes(t.task.stage)) continue;
    if (s.queueFrozen && t.task.stage === "merge") {
      for (const key of s.stall?.open.manual_stalled ?? []) if (key.startsWith(`${t.task.id}|`)) out.keep("manual_stalled", [key]);
      continue;
    }
    if (t.blockedBy?.length) continue;
    const p = lastProgress(s, t);
    if (!p || now - p.at < MANUAL_STALL_AUDIT_MS) continue;
    const stable = `${t.task.id} ${t.task.stage} seq=${p.seq ?? "无"} ${p.kind} 指纹=${p.mark}`;
    report(mode, out, { rule: "manual_stalled", taskId: t.task.id, since: p.at, keyParts: [t.task.id, p.mark],
      detail: `${t.task.id} ${t.task.stage} 最后动静 ${progressText(p)}，已停 ${((now - p.at) / 3_600_000).toFixed(1)} 小时`,
      suggestion: "核对卡停在哪:该推就推(派审查、推阶段、workflow-resume),确实在等就在卡上记 note 写清在等什么" }, stable);
  }
  out.evaluated.push("manual_stalled");
}
function blockerAudit(s: Snapshot, facts: readonly LockBlockerFact[], now: number, mode: RecoveryMode, out: Out): void {
  const byCard = new Map<string, LockBlockerFact[]>();
  for (const f of facts) byCard.set(f.taskId, [...(byCard.get(f.taskId) ?? []), f]);
  for (const [id, blocked] of byCard) {
    const t = s.tasks.find((t) => t.task.id === id), p = t && lastProgress(s, t);
    if (!t || !p || now - p.at < LOCK_BLOCKER_STALL_MS) continue;
    const nodes = [...new Set(blocked.map((f) => `${f.feature}/${f.node}`))].sort().join("、");
    const files = [...new Set(blocked.flatMap((f) => [...f.files]))].sort().join("、").slice(0, 300);
    report(mode, out, { rule: "lock_blocker_stalled", taskId: id, since: p.at, keyParts: [id, p.mark],
      detail: `${id} ${t.task.stage} 挡路卡停了；最后动静 ${progressText(p)}；被挡节点 ${nodes}；重叠文件 ${files}`,
      suggestion: "核对挡路卡还做不做:不做就让锁、收窄范围或取消,做就推进;被挡节点能绕开就改范围" },
    `${id} ${t.task.stage} seq=${p.seq ?? "无"} ${p.kind} 指纹=${p.mark} 被挡节点 ${nodes}`);
  }
  out.evaluated.push("lock_blocker_stalled");
}
export function stallAudit(s: Snapshot, now: number, policy: RecoveryPolicyPort, out: Out): void {
  if (s.stall === undefined) return;
  const mode = stallMode(policy, s.project);
  const hold = (rule: (typeof STALL_RULES)[number]) => (s.stall?.open[rule] ?? []).forEach((k) => out.keep(rule, [k]));
  if (mode === "off") {
    for (const rule of STALL_RULES) { hold(rule); out.skip("停滞巡检 auditStall 为 off", rule); }
    return;
  }
  manualAudit(s, now, mode, out);
  const blockers = s.stall?.blockers;
  if (!blockers || "unreadable" in blockers) {
    hold("lock_blocker_stalled");
    out.skip(blockers?.unreadable ?? "未取挡路卡事实", "lock_blocker_stalled");
  } else blockerAudit(s, blockers.facts, now, mode, out);
}
