/**
 * 巡检提醒升级（dispatch-recovery-AUDESC1）：推给调度助理、投出去了、60 分钟后还开着的发现，列给同项目当班 PM。
 * 现有回落（ledger-audit-service.ts FALLBACK_AFTER）只管「推不出去」；这里管「推出去了没人处理」。
 * - 取数 / 判定在这里，CLI（ledger audit）把结果作为 escalate 列表输出，bridge（bridge/ledger-audit-escalate.ts）合成通知后 --ack-escalate。
 * - 每次推送（key + notifiedAt）最多升级一次，记在状态文件 audit-escalations.json：{ "<key>@<notifiedAt>": 升级时刻 }。
 *   发现解决后再打开会有新的 notifiedAt，可以再升级一次。不写台账事件、不改 audit_findings。
 * - 开关 = 恢复策略 auditEscalate（缺省 observe）：off 不算、输出没有 escalate 字段；observe 照算、带 mode observe（bridge 只打日志）；on 推送并 ack。
 */
import type { Database } from "bun:sqlite";
import { acquireLock } from "./file-lock.js";
import { auditDispatcherTest, auditRecipient, type AuditRule } from "./ledger-audit.js";
import { openFindings, type StoredFinding } from "./ledger-audit-store.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/** 推给调度助理后多久没处理就升级给 PM */
export const AUDIT_ESCALATE_MS = 60 * 60_000;
const DEFAULT_PATH = statePath("audit-escalations.json");

export interface EscalateItem {
  key: string;
  taskId: string | null;
  rule: AuditRule;
  notifiedAt: number;
  /** 调度助理 */
  from: string;
  /** 当班 PM */
  to: string;
  detail: string;
  mode: Exclude<RecoveryMode, "off">;
}

/** 状态文件：key@notifiedAt → 升级时刻 */
export type EscalateState = Record<string, number>;

interface Ports { policy: RecoveryPolicyPort; path: string }
let ports: Ports = { policy: recoveryPolicy, path: DEFAULT_PATH };
/** 组合接线与单测换 port；不给的字段还原默认 */
export function setAuditEscalatePorts(p: Partial<Ports> = {}): void {
  ports = { policy: p.policy ?? recoveryPolicy, path: p.path ?? DEFAULT_PATH };
}

const escalateId = (key: string, notifiedAt: number) => `${key}@${notifiedAt}`;

/** "<key>@<notifiedAt>"：key 里可能有 @，按最后一个切 */
export function parseEscalateId(id: string): { key: string; notifiedAt: number } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const n = Number(id.slice(at + 1));
  return Number.isSafeInteger(n) && n >= 0 && /^\d+$/.test(id.slice(at + 1)) ? { key: id.slice(0, at), notifiedAt: n } : null;
}

const validState = (d: unknown): boolean =>
  !!d && typeof d === "object" && !Array.isArray(d) && Object.values(d as object).every((v) => typeof v === "number");

/** 读坏按空、打一行诊断，不抛 */
function readEscalateState(path = ports.path): EscalateState {
  const r = readJsonStateSync(path, validState);
  if (r.status === "ok") return r.data as EscalateState;
  if (r.status === "corrupt") console.error(`⚠️ 巡检升级状态文件读不了，按空处理：${path}（${r.error}）`);
  return {};
}

function escalateMode(project: string, policy = ports.policy): RecoveryMode {
  try {
    return policy(project, "auditEscalate").mode;
  } catch {
    return "off"; // 策略读不了：保守不算
  }
}

/** 一条发现该不该升级；该升级就给出 from / to */
export function escalateTarget(f: StoredFinding, pms: readonly string[], teamDispatcher: string | null | undefined, done: EscalateState, now: number):
  { from: string; to: string } | null {
  if (f.resolvedAt !== null || f.notifiedAt === null || !f.notify) return null;
  const isDispatcher = auditDispatcherTest(teamDispatcher);
  if (!isDispatcher(f.notify)) return null;
  const pm = auditRecipient("pm_held", pms, teamDispatcher);
  if (!pm || pm === f.notify || isDispatcher(pm)) return null;
  if (now - f.notifiedAt < AUDIT_ESCALATE_MS) return null;
  if (Object.hasOwn(done, escalateId(f.key, f.notifiedAt))) return null;
  return { from: f.notify, to: pm };
}

/**
 * 这些项目该升级的发现（读 audit_findings 里开着的，dry-run 也一样）。全部项目都是 off → null（输出里不带 escalate 字段，与改前逐字一致）。
 */
export function auditEscalations(db: Database, projects: readonly string[], now: number): EscalateItem[] | null {
  const modes = projects.map((p) => [p, escalateMode(p)] as const).filter(([, m]) => m !== "off") as [string, EscalateItem["mode"]][];
  if (!modes.length) return null;
  const done = readEscalateState();
  const out: EscalateItem[] = [];
  for (const [project, mode] of modes) {
    const meta = getMeta(db, project);
    for (const f of openFindings(db, project)) {
      const t = escalateTarget(f, meta.pms, meta.team?.dispatcher, done, now);
      if (t) out.push({ key: f.key, taskId: f.taskId, rule: f.rule, notifiedAt: f.notifiedAt as number, ...t, detail: f.detail, mode });
    }
  }
  return out;
}

/**
 * --ack-escalate：记下这几次推送已升级；顺手删掉发现已解决（或已重新打开、notifiedAt 变了）的旧条目。
 * 读、清理、合并、整份写回都在专用文件锁 <path>.lock 里做：两个 PM / PM 与 bridge 并发确认不同提醒时不丢更新（tmp+rename 只保证单次写完整）。
 * 拿不到锁报 busy、这次不写（bridge 下一轮重试），不降级成无锁写。
 */
export async function ackEscalations(db: Database, ids: readonly string[], now: number, path = ports.path, lockMs = 10_000): Promise<number> {
  const parsed = ids.map((id) => ({ id, p: parseEscalateId(id) }));
  const bad = parsed.find((x) => !x.p);
  if (bad) throw new LedgerError("invalid", `--ack-escalate 的每一项要是 <key>@<notifiedAt>，收到 ${bad.id}`);
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没写，稍后重试`);
  try {
    return mergeEscalations(db, parsed.map((x) => x.id), now, path);
  } finally {
    lock.release();
  }
}

/** 锁内：重新读状态文件 → 清理 → 合并 → 原子写回 */
function mergeEscalations(db: Database, ids: readonly string[], now: number, path: string): number {
  const cur = readEscalateState(path);
  const row = db.query("SELECT resolvedAt, notifiedAt FROM audit_findings WHERE key = ?");
  const next: EscalateState = {};
  for (const [id, at] of Object.entries(cur)) {
    const p = parseEscalateId(id);
    const r = p ? (row.get(p.key) as { resolvedAt: number | null; notifiedAt: number | null } | null) : null;
    if (p && r && r.resolvedAt === null && r.notifiedAt === p.notifiedAt) next[id] = at;
  }
  let n = 0;
  for (const id of ids) {
    if (!Object.hasOwn(next, id)) n++;
    next[id] ??= now;
  }
  writeJsonAtomicSync(path, next);
  return n;
}
