/** Pure episode transition rules. Observations and business actions use separate persisted streams. */
import type { LedgerEvent } from "./ledger-stages.js";

export const PRIORITY_STALL_MS = 30 * 60_000;
const PRIORITY_NOTICE_ATTEMPTS = 3;
export type StallAction = "heal" | "pm" | "owner";
export type StallResult = "success" | "failed" | "unknown" | "unavailable";
interface StallStep { at: number; result: StallResult; detail: string; attempts: number }
export interface StallCycle {
  id: string;
  since: number;
  progress: string;
  modeRev: number;
  epoch: number;
  heal?: StallStep;
  pm?: StallStep;
  owner?: StallStep;
  pending?: { action: StallAction; token: string; at: number; attempts: number };
}
/** Structured blocker: later decisions read this, never the `why` text. `on` names the unmet upstream task ids / node keys. */
type StallBlockKind = "ask" | "frozen" | "feature" | "deps" | "files" | "no_globs" | "progress";
export interface StallBlock { kind: StallBlockKind; on: string[] }
export interface StallBasis {
  key: string;
  label: string;
  project: string;
  taskId: string | null;
  featureId: string | null;
  nodeKey: string | null;
  stage: string;
  why: string;
  pm: string | null;
  since: number;
  progress: string;
  nowSince: number;
  eligible: boolean;
  frozen: boolean;
  ask?: { id: string; question: string };
  block: StallBlock;
  /** now objects waiting only on this upstream; listed in the note/owner text, one object however many reference it */
  impact: string[];
  /** Graph configuration problem (missing / cancelled upstream, unselected branch): note only, never an owner ask. */
  config?: string;
}

const RESULT_KINDS = new Set(["deliver", "review", "deploy", "verify", "accept"]);
const EXECUTION_OPS = new Set(["order_taken", "work_order_take", "session_bind", "workflow_resume", "merge_done", "deploy_done"]);

/** An explicit allowlist prevents a note, heartbeat, ask or recovery bookkeeping from keeping work alive. */
export function isPriorityStallProgress(e: Pick<LedgerEvent, "kind" | "data"> & Partial<Pick<LedgerEvent, "actor">>): boolean {
  if (e.kind === "scheduler" && e.data.op === "workflow_resume" && e.actor === "scheduler") return false;
  if (e.kind === "stage") return typeof e.data.to === "string" && e.data.to !== e.data.from;
  if (RESULT_KINDS.has(e.kind)) return true;
  if (e.kind === "dep") return e.data.state === "done" || e.data.op === "rm" || (e.data.patch as { state?: string } | undefined)?.state === "done";
  if (e.kind === "step") return ["deliver", "review", "verify"].includes(String(e.data.op));
  if (e.kind === "scheduler" && e.data.op === "merge_phase") return e.data.to === "merged";
  if (e.kind === "scheduler" && e.data.op === "deploy_phase") return e.data.to === "deployed";
  return e.kind === "scheduler" && EXECUTION_OPS.has(String(e.data.op));
}

export function freshStallCycle(b: StallBasis, modeRev: number): StallCycle {
  return { id: crypto.randomUUID(), since: Math.max(b.since, b.nowSince), progress: b.progress, modeRev, epoch: b.nowSince };
}

/** Each stage has its own window. Unavailable/failed/unknown healing goes directly to the PM step (a note on the card). */
export function nextStallAction(c: StallCycle, now: number, threshold: number, noteOnly = false): StallAction | null {
  if (c.pending) return null;
  if (noteOnly && c.pm) return null;
  if (!c.heal) return now - c.since >= threshold ? "heal" : null;
  if (!c.pm) return c.heal.result !== "success" || now - c.heal.at >= threshold ? "pm" : null;
  if (c.pm.result === "failed" && c.pm.attempts < PRIORITY_NOTICE_ATTEMPTS) return now - c.pm.at >= Math.min(threshold, 60_000) ? "pm" : null;
  if (!c.owner && now - c.pm.at >= threshold) return "owner";
  return null;
}

export function stallNotice(b: StallBasis, c: StallCycle, now: number): string {
  const first = b.ask ? `等 PM 答 ask ${b.ask.id}：${b.ask.question.split(/\r?\n/).find((s) => s.trim()) ?? ""}`
    : b.config ? `now 链图配置问题：${b.config}` : `now 停滞：${b.label}`;
  return [first, `对象：${b.label}；阶段：${b.stage}；卡点：${b.why}；连续停滞 ${Math.floor((now - c.since) / 60_000)} 分钟`,
    ...b.impact.length ? [`影响：${b.impact.join(", ")}`] : [],
    `自愈：${c.heal?.result ?? "未尝试"} ${c.heal?.detail ?? ""}`, `卡上提醒：${c.pm?.result ?? "未记录"} ${c.pm?.detail ?? ""}`].join("\n");
}
