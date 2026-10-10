/** Pure exit evidence checks. Only the trusted B reader may bind these observations; worker parameters are not evidence. */
import type { ActivityRecord } from "./agent-supervisor-activity.js";
import { getOrder, type LendRow } from "./lend-journal.js";
import type { Database } from "bun:sqlite";
import { isWorkerArchiveTerminal, workerArchiveIdentity, workerArchiveKey, type WorkerArchiveIdentity } from "./lend-worker-registry-archive.js";

export interface WorkerExitEvidence {
  source: "canonical-acp-activity" | null;
  activity: ActivityRecord | null;
  /** The trusted service observed this exact host while it was alive, with a known process start time. */
  observed: {
    identity: WorkerArchiveIdentity;
    hostPid: number;
    processStartedAt: number | null;
    at: number;
  } | null;
  /** A strict process query: only ESRCH proves absence; EPERM and every other error are unknown. */
  process: { outcome: "running" | "ESRCH" | "unknown"; startedAt: number | null; reused: boolean | null };
  checkedAt: number;
}

/** Constructed by B service wiring only. It is never accepted from CLI JSON or worker-provided flags. */
export interface CanonicalExitReaders {
  activity(agent: string): ActivityRecord | null;
  observed(row: LendRow): WorkerExitEvidence["observed"];
  /** Return the start of a living process; absence must throw the real ESRCH, never return an empty ps output. */
  processStartedAt(pid: number): number | null;
  now(): number;
}
type ExitRead = { ok: true; evidence: WorkerExitEvidence } | { ok: false; code: "blocked-capability" | "protected"; reason: string };

/** Reread the exact journal row before consuming trusted IO. Missing reader/observation leaves the capability closed. */
export function readCanonicalWorkerExit(id: WorkerArchiveIdentity, journal: Database, readers?: CanonicalExitReaders): ExitRead {
  try {
    const row = getOrder(journal, id.orderId), current = row && workerArchiveIdentity(row);
    if (!row || !current || workerArchiveKey(current) !== workerArchiveKey(id) || !isWorkerArchiveTerminal(row.state)) {
      return { ok: false, code: "protected", reason: "B 订单 / gen / session / 规范终态已变" };
    }
    if (row.family !== "codex" || !readers) return { ok: false, code: "blocked-capability", reason: "正式宿主退出 reader 不可用" };
    const rowRaw = JSON.stringify(row);
    const activity = readers.activity(id.agent), observed = readers.observed(row);
    if (!activity || !observed) return { ok: false, code: "blocked-capability", reason: "可信活动 / 已核进程启动观测缺失" };
    const activityRaw = JSON.stringify(activity), observedRaw = JSON.stringify(observed);
    const evidence: WorkerExitEvidence = { source: "canonical-acp-activity", activity, observed,
      process: { outcome: "unknown", startedAt: null, reused: null }, checkedAt: readers.now() };
    const sourceProblem = exitSourceProblem(row, evidence);
    if (sourceProblem) return { ok: false, code: "protected", reason: sourceProblem };
    let process: WorkerExitEvidence["process"];
    try {
      const startedAt = readers.processStartedAt(activity.hostPid);
      process = { outcome: "running", startedAt, reused: startedAt === null || observed.processStartedAt === null
        ? null : startedAt !== observed.processStartedAt };
    } catch (e) {
      // Only an OS ESRCH from the trusted probe is absence; all other failures remain unknown and keep the record.
      const absent = (e as NodeJS.ErrnoException)?.code === "ESRCH";
      process = { outcome: absent ? "ESRCH" : "unknown", startedAt: null, reused: absent ? false : null };
    }
    if (JSON.stringify(getOrder(journal, id.orderId)) !== rowRaw || JSON.stringify(readers.activity(id.agent)) !== activityRaw
      || JSON.stringify(readers.observed(getOrder(journal, id.orderId)!)) !== observedRaw) {
      return { ok: false, code: "protected", reason: "读取过程中 B 订单 / 活动 / 进程来源观测已漂移" };
    }
    evidence.process = process;
    evidence.checkedAt = readers.now();
    const problem = workerArchiveExitProblem(row, evidence);
    return problem ? { ok: false, code: "protected", reason: problem } : { ok: true, evidence };
  } catch (e) {
    return { ok: false, code: "protected", reason: `退出事实失读：${(e as Error).message}` };
  }
}

function exitSourceProblem(row: LendRow, evidence: WorkerExitEvidence): string | null {
  if (row.family !== "codex") return "blocked-capability：Claude 缺少正式宿主退出证明端口";
  const { activity: a, observed: seen } = evidence;
  if (evidence.source !== "canonical-acp-activity" || !a || !seen) return "可信 B 宿主来源 / 既存进程观测缺失";
  const id = seen.identity;
  if (id.orderId !== row.orderId || id.agent !== row.agent || id.sessionId !== row.sessionId || id.leaseGen !== row.leaseGen
    || a.agent !== id.agent || a.sessionId !== id.sessionId || a.hostPid !== seen.hostPid) return "宿主 order / gen / session / PID 来源不匹配";
  if (!Number.isSafeInteger(a.hostPid) || a.hostPid <= 0 || a.busy !== false) return "宿主 PID / 待完成回合未知";
  const started = row.startedAt, birth = seen.processStartedAt;
  const times = [started, birth, seen.at, a.turnAt, a.updateAt, a.writtenAt, evidence.checkedAt];
  if (times.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)
    || birth! > started! || a.turnAt < started! || a.updateAt < a.turnAt || a.writtenAt < a.updateAt
    || seen.at < a.writtenAt || seen.at > evidence.checkedAt || a.writtenAt > row.updatedAt) {
    return "宿主 process-start / startedAt / 活动来源时间关系未知";
  }
  return null;
}

export function workerArchiveExitProblem(row: LendRow, evidence: WorkerExitEvidence): string | null {
  const sourceProblem = exitSourceProblem(row, evidence);
  if (sourceProblem) return sourceProblem;
  const proc = evidence.process;
  if (proc.reused !== false || (proc.startedAt !== null && proc.startedAt !== evidence.observed!.processStartedAt)) return "PID 已复用 / 复用状态未知";
  if (proc.outcome !== "ESRCH") return "宿主退出未由严格 ESRCH 证实";
  return null;
}
