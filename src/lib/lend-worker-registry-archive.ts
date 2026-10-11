/** Exact B-side retirement evidence. Names alone never authorize registry removal. */
import { createHash } from "node:crypto";
import type { LendRow } from "./lend-journal.js";
import { workerName } from "./lend-worker-name.js";
import { isMasterName } from "./registry.js";

export interface WorkerArchiveIdentity { orderId: string; agent: string; sessionId: string; leaseGen: number }
export interface WorkerArchiveRecord {
  sessionId?: string; cwd?: string; runtime?: string; kind?: string; status?: string; pending?: unknown; role?: string;
}
export const archiveHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const workerArchiveKey = (id: WorkerArchiveIdentity): string => archiveHash(JSON.stringify([id.orderId, id.agent, id.sessionId, id.leaseGen]));

export function workerArchiveIdentity(row: Partial<LendRow>): WorkerArchiveIdentity | null {
  if (!row.orderId || row.agent !== workerName(row.orderId) || !row.sessionId || !/^[\w-]+$/.test(row.sessionId)
    || !Number.isSafeInteger(row.leaseGen) || row.leaseGen! < 1) return null;
  return { orderId: row.orderId, agent: row.agent, sessionId: row.sessionId, leaseGen: row.leaseGen! };
}

/** Returns a reason to retain the record. A stopped/unknown order is never inferred to be done. */
export function workerArchiveProblem(id: WorkerArchiveIdentity, row: LendRow | null, info: WorkerArchiveRecord): string | null {
  if (!row || JSON.stringify(workerArchiveIdentity(row)) !== JSON.stringify(id)) return "订单 / agent / session / gen 不匹配";
  if (!["acked", "cancelled", "released"].includes(row.state)) return "不是可归档的 B 终态";
  if (isMasterName(id.agent) || info.kind !== "worker" || info.role === "pm" || info.role === "master") return "不是可退役 worker";
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
