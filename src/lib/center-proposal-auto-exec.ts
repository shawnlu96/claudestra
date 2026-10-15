/** PROPAUTO1 执行占位与结果事件（台账 kind=note，项目级 target ""）：人工答复和自动批准对同一提案版本只 decide 一次。
 * 占位的 dedup 键 center-proposal-exec:<中心项目>:<proposalId>:<rev>:<完整摘要>，谁先写进去谁执行（UNIQUE 键 + 立即事务）。
 * 自动路径的第 2 / 3 次重发占 <键>#a2 / #a3；自动交还人工（3 次不明 / 中心明确拒绝）后，人工答复占 <键>#owner。
 * 结果事件 center_proposal_auto_approve_result 占 <键>#result，同一键只写一次。凭据从不进这里。
 */
import type { Database } from "bun:sqlite";
import type { AutoReason } from "./center-proposal-auto.js";
import type { InboxParams } from "./center-proposal-inbox.js";
import { getEventByDedup } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

const AUTO_APPROVE_KEY = "centerProposalAutoApprove";
const EXEC_OP = "center_proposal_exec";
export const RESULT_OP = "center_proposal_auto_approve_result";
/** 自动路径同一 rev 最多发几次；结果不明后隔多久才许再发 */
export const MAX_AUTO_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 10 * 60_000;
const ACTOR = "scheduler";

export type ExecLane = "auto" | "owner";
/** approved：中心接受了批准；settled：结果不明后中心已不是待批（补记）；conflict：409，下一轮按新快照重判；handover：交回人工出卡 */
type ResultOutcome = "approved" | "settled" | "conflict" | "handover";
interface ExecClaim { lane: ExecLane; attempt: number; at: number }
export interface ExecResult { outcome: ResultOutcome; centerState?: string; code?: string; reasons: AutoReason[] }
export interface ExecState { claims: ExecClaim[]; result: ExecResult | null }

/** 身份键：中心项目 + 提案号 + rev + 完整摘要 */
export const execKey = (centerProject: string, p: InboxParams) =>
  `center-proposal-exec:${centerProject}:${p.proposalId}:${p.proposalRev}:${p.proposalDigest}`;
const attemptKey = (key: string, n: number) => (n === 1 ? key : `${key}#a${n}`);
const ownerKey = (key: string) => `${key}#owner`;
const resultKey = (key: string) => `${key}#result`;

/** 写事件用的身份（不含凭据） */
export interface ExecIdentity { localProjectId: string; centerProject: string; params: InboxParams }
const identityData = (id: ExecIdentity, key: string) => ({ key, centerProject: id.centerProject, ...id.params });

function claimOf(db: Database, k: string): ExecClaim | null {
  const e = getEventByDedup(db, k);
  if (!e || e.kind !== "note" || e.data.op !== EXEC_OP) return null;
  return { lane: e.data.lane === "owner" ? "owner" : "auto", attempt: Number(e.data.attempt) || 1, at: e.ts };
}

export function execState(db: Database, key: string): ExecState {
  const claims = [attemptKey(key, 1), ...Array.from({ length: MAX_AUTO_ATTEMPTS - 1 }, (_, i) => attemptKey(key, i + 2)), ownerKey(key)]
    .map(k => claimOf(db, k)).filter((c): c is ExecClaim => !!c);
  const r = getEventByDedup(db, resultKey(key));
  const result = r && r.kind === "note" && r.data.op === RESULT_OP
    ? { outcome: r.data.outcome as ResultOutcome, centerState: r.data.centerState as string | undefined, code: r.data.code as string | undefined,
      reasons: (Array.isArray(r.data.reasons) ? r.data.reasons : []) as AutoReason[] }
    : null;
  return { claims, result };
}

function put(db: Database, id: ExecIdentity, dedupKey: string, now: number, text: string, data: Record<string, unknown>): boolean {
  return !appendEvent(db, { actor: ACTOR, now, dedupKey }, { project: id.localProjectId, target: "", kind: "note", text, data }).duplicate;
}

/**
 * 抢占位，抢到才许 decide。一个立即事务里先看再写，并发的另一方（同进程另一条路径 / 另一个进程）只会看到已写的那条。
 * auto：第 attempt 次（1..3）；已有人工占位、已有结果都不抢。owner：首占位空着就占；已被自动占了，只有自动已交还人工（handover）才占 #owner。
 */
export function claimExec(db: Database, id: ExecIdentity, lane: ExecLane, now: number, attempt = 1): boolean {
  const key = execKey(id.centerProject, id.params);
  return tx(db, () => {
    const s = execState(db, key), first = claimOf(db, key);
    const text = (n: string) => `中心提案执行占位（${n}）：${id.params.proposalId} rev ${id.params.proposalRev}`;
    if (lane === "auto") {
      if (s.result || s.claims.some(c => c.lane === "owner") || attempt < 1 || attempt > MAX_AUTO_ATTEMPTS) return false;
      return put(db, id, attemptKey(key, attempt), now, text(`自动第 ${attempt} 次`), { op: EXEC_OP, lane, attempt, ...identityData(id, key) });
    }
    if (!first) return put(db, id, key, now, text("人工答复"), { op: EXEC_OP, lane, attempt: 1, ...identityData(id, key) });
    if (first.lane === "owner" || s.result?.outcome !== "handover") return false;
    return put(db, id, ownerKey(key), now, text("自动交还后的人工答复"), { op: EXEC_OP, lane, attempt: 1, ...identityData(id, key) });
  });
}

/** 结果事件：同一键只写一次（返回这次是否写了） */
export function recordExecResult(db: Database, id: ExecIdentity, r: ExecResult, now: number): boolean {
  const key = execKey(id.centerProject, id.params);
  const text = `中心提案自动批准结果：${id.params.proposalId} rev ${id.params.proposalRev} ${r.outcome}${r.centerState ? `（中心 ${r.centerState}）` : ""}`;
  return put(db, id, resultKey(key), now, text, {
    op: RESULT_OP, outcome: r.outcome, reasons: [...r.reasons], ...(r.centerState ? { centerState: r.centerState } : {}), ...(r.code ? { code: r.code } : {}),
    ...identityData(id, key),
  });
}

/** 开关档位；读不了（恢复配置坏了）按 off，逐字回到旧路径 */
export function autoApproveMode(project: string): RecoveryMode {
  try { const p = recoveryPolicy(project, AUTO_APPROVE_KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}

/** observe 档的样本：「本会自动批」，按 proposalId + rev 去重 */
export function observeAutoApprove(db: Database, id: ExecIdentity, now: number): boolean {
  return recordObserved(db, { project: id.localProjectId, mechanism: "centerProposalAutoApprove", target: "",
    actionKey: `${id.params.proposalId}:${id.params.proposalRev}`, action: `自动批准中心提案 ${id.params.proposalId} rev ${id.params.proposalRev}`,
    data: identityData(id, execKey(id.centerProject, id.params)) }, now).recorded;
}
