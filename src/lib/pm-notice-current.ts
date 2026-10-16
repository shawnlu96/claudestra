/**
 * PMQUIET1 · 统一 PM 提醒复核：一条推给 PM 的提醒在实际投出之前（notifyProjectPm 发送前、bridge 投给当班 PM 前、pm-hold 整包
 * 与摘要释放前）都过这里的 pmNoticeGate，重读当前卡与合并请求 / 意图，提醒绑定的实例已不是现状就不投，只记一条去重台账事件。
 * 提醒怎么认：只认它带着的结构化引用，不按正文字样猜阶段——
 *   ① 发送方显式带的引用（notifyProjectPm opts.current），开着时以尾行 PM_NOTICE_TAG 随正文走，暂存 / 摘要读回也认得；
 *   ② 审查已回提醒（scheduler-review-pm-wait.ts）与合并待处置提醒（scheduler-merge-pm-wait.ts）正文末尾的实例键 / 阻塞键，
 *      且台账里有本卡那条发送意图（op review_pm_wait / merge_pm_wait，kind try，data.key 相同）。
 * 现状判定复用各自原候选函数（reviewPmCandidate / mergePmCandidate 的实例键还等不等于提醒的键）：阶段已前进（如进了 merge_deploy）、
 * 已有有效合并请求或未结意图、head / 规格 / 轮次 / 审查变了，候选就不再是这个键。补截图 PM 待办（ui_evidence_repair）按
 * scheduler-ui-evidence-repair.ts 的 uiRepairTodoCurrent。认不出的提醒、读台账出错：照旧投（宁可叫醒，不吞）。
 * 开关恢复键 pmQuiet（缺省 on）：off = 什么都不读不加，正文与投递逐字照旧；observe = 照常投，只记一条「本会跳过」样本；
 * on = 跳过并记 pm_quiet_skip（dedup = 卡 + 类型 + 键，重复 tick / 重启 / 重投只一条）。
 * 回退：`ledger scheduler-recovery claude-orchestrator off --key pmQuiet --reason ...`。tests/pm-notice-current.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup, getTask, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { mergePmCandidate } from "./scheduler-merge-pm-wait.js";
import { reviewPmCandidate } from "./scheduler-review-pm-wait.js";
import { uiRepairTodoCurrent } from "./scheduler-ui-evidence-repair.js";

export const PM_QUIET_KEY = "pmQuiet";
/** 补截图超限后的 PM 待办类型（scheduler-ui-evidence-repair.ts 发） */
export const UI_REPAIR_TODO = "ui_evidence_repair";
/** 本模块认得的待办类型；别的类型照旧投 */
export type PmNoticeKind = "review_pm_wait" | "merge_pm_wait" | typeof UI_REPAIR_TODO;
/** 可复核的提醒引用：卡号 + 待办类型 + 绑定窗口（实例键，或补图窗口键） */
export interface PmNoticeRef { kind: PmNoticeKind; taskId: string; key: string }

export const PM_QUIET_SKIP_OP = "pm_quiet_skip";
const KINDS: readonly PmNoticeKind[] = ["review_pm_wait", "merge_pm_wait", UI_REPAIR_TODO];
const PART = /^[\w.:@/-]{1,120}$/;
const TAG_RE = /\s〔提醒复核 ([a-z_]+) (\S+) (\S+)〕$/; // 退人工原因会被压成一行：换行变空格也认
/** 显式引用随正文走的尾行（只在 pmQuiet 不是 off 时加） */
export const pmNoticeTag = (ref: PmNoticeRef): string => `\n〔提醒复核 ${ref.kind} ${ref.taskId} ${ref.key}〕`;

export type PmQuietModePort = (project: string) => RecoveryMode;
/** 读不了 / 未知键 = off（旧路） */
const policyMode: PmQuietModePort = (project) => {
  try { const p = recoveryPolicy(project, PM_QUIET_KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
};
let modePort: PmQuietModePort = policyMode;
/** Tests only: swap the mode reader; returns the restore. */
export function configurePmQuietMode(port: PmQuietModePort | null): () => void {
  const was = modePort;
  modePort = port ?? policyMode;
  return () => { modePort = was; };
}
export const pmQuietMode = (project: string): RecoveryMode => modePort(project);

/** 正文末尾的实例键 / 阻塞键，且台账有本卡这条发送意图 */
function keyedRef(db: Database, project: string, text: string): PmNoticeRef | null {
  const m = text.match(/实例 ([0-9a-f]{16})$/) ?? text.match(/阻塞键 ([0-9a-f]{16})$/);
  if (!m) return null;
  const kind: PmNoticeKind = m[0].startsWith("实例") ? "review_pm_wait" : "merge_pm_wait";
  const taskId = text.match(/^\[(?:审查已回|合并待处置)\] (\S+) /)?.[1];
  if (!taskId) return null;
  const tried = listEvents(db, { project, target: taskId }).some((e) => e.kind === "note" && e.actor === "scheduler" &&
    e.data.op === kind && e.data.kind === "try" && e.data.key === m[1]);
  return tried ? { kind, taskId, key: m[1] } : null;
}

/** 这条提醒带着的引用；认不出 = null（照旧投） */
export function pmNoticeRefOf(db: Database, project: string, text: string): PmNoticeRef | null {
  const t = text.match(TAG_RE);
  if (t) return KINDS.includes(t[1] as PmNoticeKind) && PART.test(t[2]) && PART.test(t[3]) ? { kind: t[1] as PmNoticeKind, taskId: t[2], key: t[3] } : null;
  return keyedRef(db, project, text);
}

/** 引用的实例已不是现状的原因；仍是现状 = null */
export function pmNoticeStale(db: Database, ref: PmNoticeRef, now: number): string | null {
  const task = getTask(db, ref.taskId);
  if (!task) return `卡 ${ref.taskId} 已不在台账`;
  if (ref.kind === "review_pm_wait") return reviewPmCandidate(db, task.id, now)?.key === ref.key ? null : `审查已回提醒的实例已过期（卡现在 ${task.stage}）`;
  if (ref.kind === "merge_pm_wait") return mergePmCandidate(db, task.id, now)?.key === ref.key ? null : `合并待处置提醒的实例已过期（卡现在 ${task.stage}）`;
  return uiRepairTodoCurrent(db, task, ref.key) ? null : `补截图待办的绑定窗口已过期（卡现在 ${task.stage}）`;
}

export type PmNoticeVerdict = { send: true } | { send: false; reason: string; ref: PmNoticeRef };

/** 记跳过：on 写 pm_quiet_skip（去重），observe 记恢复观察样本；写不进只打日志，不改变是否投递的结论 */
function recordSkip(db: Database, project: string, ref: PmNoticeRef, reason: string, mode: RecoveryMode, now: number): void {
  try {
    if (mode === "observe") {
      recordObserved(db, { project, mechanism: PM_QUIET_KEY, target: ref.taskId, actionKey: `skip:${ref.kind}:${ref.key}`,
        action: `跳过过期 PM 提醒（${ref.kind}：${reason}）`, data: { kind: ref.kind, key: ref.key } }, now);
      return;
    }
    const dedupKey = `pm-quiet-skip:${ref.taskId}:${ref.kind}:${ref.key}`;
    if (getEventByDedup(db, dedupKey)) return;
    appendEvent(db, { actor: "scheduler", now, dedupKey }, { project, target: ref.taskId, kind: "note",
      text: `过期 PM 提醒未投递（${ref.kind}）：${reason}`, data: { op: PM_QUIET_SKIP_OP, kind: ref.kind, key: ref.key } });
  } catch (e) {
    console.error(`[pm-quiet] ${ref.taskId} 跳过事件没记上：${(e as Error).message}`);
  }
}

/**
 * 投给 PM 之前的统一复核。read = 读当前卡的库，write = 记跳过事件的库（缺省同 read）。off / 认不出 / 仍是现状 / 读出错 → 投；
 * observe 投且记样本；on 不投。
 */
export function pmNoticeGate(read: Database, project: string, text: string, now: number, write: () => Database = () => read): PmNoticeVerdict {
  const mode = pmQuietMode(project);
  if (mode === "off") return { send: true };
  let ref: PmNoticeRef | null, reason: string | null;
  try {
    ref = pmNoticeRefOf(read, project, text);
    reason = ref && pmNoticeStale(read, ref, now);
  } catch (e) {
    console.error(`[pm-quiet] 提醒复核读不出，照常投：${(e as Error).message}`);
    return { send: true };
  }
  if (!ref || !reason) return { send: true };
  let db: Database;
  try { db = write(); } catch (e) { console.error(`[pm-quiet] 台账开不了：${(e as Error).message}`); db = read; }
  recordSkip(db, project, ref, reason, mode, now);
  return mode === "on" ? { send: false, reason, ref } : { send: true };
}

/** 一批待释放的条目逐条复核：live 照常打包，stale 的 id 由调用方出队（全过期就不发空包） */
export function pmNoticeFilter<T extends { id: string; project: string }>(read: Database, entries: readonly T[], body: (e: T) => string, now: number,
  write?: () => Database): { live: T[]; stale: Set<string> } {
  const live: T[] = [], stale = new Set<string>();
  for (const e of entries) (pmNoticeGate(read, e.project, body(e), now, write).send ? live.push(e) : stale.add(e.id));
  return { live, stale };
}
