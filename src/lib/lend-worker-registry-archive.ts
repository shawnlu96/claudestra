/** Exact B-side retirement evidence. Names alone never authorize registry removal. */
import { createHash } from "node:crypto";
import type { LendRow } from "./lend-journal.js";
import { workerName } from "./lend-worker-name.js";
import { isMasterName } from "./registry.js";
import { workerArchiveExitProblem, type WorkerExitEvidence } from "./lend-worker-registry-archive-facts.js";

export interface WorkerArchiveIdentity { orderId: string; agent: string; sessionId: string; leaseGen: number }
export interface WorkerArchiveRecord {
  sessionId?: string; cwd?: string; runtime?: string; kind?: string; status?: string; pending?: unknown; role?: string;
}
/** Supplied by the canonical authority/lifecycle reader; absence or unknown facts always retain the worker. */
export interface WorkerArchiveFacts {
  identity: WorkerArchiveIdentity;
  journalAuthenticated: boolean | null;
  workerExited: boolean | null;
  preservationComplete: boolean | null;
  protected: boolean | null;
  pendingResult: boolean | null;
  /** Independently assembled by the trusted reader, never parsed from the public identity argument. */
  exitEvidence?: WorkerExitEvidence;
}
export const isWorkerArchiveTerminal = (state: string): boolean => ["acked", "cancelled", "released"].includes(state);
export const archiveHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const workerArchiveKey = (id: WorkerArchiveIdentity): string => archiveHash(JSON.stringify([id.orderId, id.agent, id.sessionId, id.leaseGen]));

export function workerArchiveIdentity(row: Partial<LendRow>): WorkerArchiveIdentity | null {
  if (!row.orderId || row.agent !== workerName(row.orderId) || !row.sessionId || !/^[\w-]+$/.test(row.sessionId)
    || !Number.isSafeInteger(row.leaseGen) || row.leaseGen! < 1) return null;
  return { orderId: row.orderId, agent: row.agent, sessionId: row.sessionId, leaseGen: row.leaseGen! };
}

/** Returns a reason to retain the record. A stopped/unknown order is never inferred to be done. */
export function workerArchiveProblem(id: WorkerArchiveIdentity, row: LendRow | null, info: WorkerArchiveRecord): string | null {
  const identity = row && workerArchiveIdentity(row);
  if (!row || !identity || workerArchiveKey(identity) !== workerArchiveKey(id)) return "订单 / agent / session / gen 不匹配";
  if (!isWorkerArchiveTerminal(row.state)) return "不是可归档的 B 终态";
  if (isMasterName(id.agent) || info.kind !== "worker" || ["pm", "master", "owner", "dispatcher"].includes(info.role ?? "")) return "不是可退役 worker";
  if (info.status !== "stopped" || info.pending) return "worker 未完成退役";
  if (info.sessionId !== id.sessionId || !row.dir || info.cwd !== row.dir) return "registry 会话 / 工作目录已变";
  if (!((row.family === "codex" && info.runtime === "codex") || (row.family === "claude" && (info.runtime ?? "claude-code") === "claude-code"))) {
    return "运行时关联不匹配";
  }
  if (row.settle?.notify || row.settle?.removeDir || row.notices?.end?.sentAt === null) return "收尾 / 通知尚未完成";
  if (row.state === "acked") {
    if (!row.payload || !row.payloadSha || archiveHash(JSON.stringify(row.payload)) !== row.payloadSha
      || row.payload.gen !== id.leaseGen || row.payload.orderId !== id.orderId
      || (row.payload.session as { id?: unknown } | undefined)?.id !== id.sessionId
      || row.receipt?.orderId !== id.orderId || row.receipt.sha256 !== row.payloadSha) return "结果 / 回执关联不完整";
    if (row.work) {
      const delivered = row.payload.deliver as Record<string, unknown> | undefined;
      if (!delivered || delivered.head !== row.work.head || delivered.summary !== row.work.summary
        || delivered.selfCheck !== row.work.selfCheck) return "仍有未确认写单产物";
    }
  } else if (row.payload || row.work || row.payloadSha) return "仍有未确认结果 / 产物，保留原记录";
  return null;
}

/** Exact final facts are a prerequisite for the future LIFE1 port, never an instruction to execute retirement. */
export function workerArchiveFactsProblem(id: WorkerArchiveIdentity, row: LendRow | null, info: WorkerArchiveRecord,
  facts: WorkerArchiveFacts): string | null {
  const problem = workerArchiveProblem(id, row, info);
  if (problem) return problem;
  if (workerArchiveKey(facts.identity) !== workerArchiveKey(id)) return "退休事实 order / session / gen 不匹配";
  if (facts.journalAuthenticated !== true) return "B journal 认证未知 / 未通过";
  if (facts.workerExited !== true) return "worker 退出事实未知 / 未确认";
  if (facts.exitEvidence) {
    const exitProblem = workerArchiveExitProblem(row!, facts.exitEvidence);
    if (exitProblem) return exitProblem;
  }
  if (facts.preservationComplete !== true) return "保全未确认完成";
  if (facts.protected !== false) return "PM / 冻结卡 / 他人任务保护未解除";
  if (facts.pendingResult !== false) return "待转结果未知 / 尚未完成";
  return null;
}
