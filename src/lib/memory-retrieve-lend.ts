/**
 * 出借 write / fix / review 复用 fitMemory，只排、只画 team；记忆节单独过外发闸，失败整节丢弃。
 * 事务外语义准备只返回本次调用的输入；排名、推出、尝试样本仅由成功挂单的事务提交。
 * memoryLendInjection 仍决定外发档位，memoryLendPrepare 的隔离及回退由 lend-memory-prepare-wiring 控制。
 */
import type { Database } from "bun:sqlite";
import { EMBED_TIMEOUT_MS } from "./memory-embed.js";
import { memoryState } from "./ledger-memory.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { LendStep } from "./lend-git.js";
import { recordMemoryAttempt, type MemoryAttemptResult } from "./memory-inject-attempt.js";
import type { MemoryOrderKind } from "./memory-retrieve.js";
import { retrievalInputs, fitMemory, recordMemoryInjection, type EnsureDeps, type MemoryFit, type RetrieveOpts } from "./memory-retrieve-order.js";
import type { OrderWire } from "./order-wire.js";
import { redactOrderForPeer } from "./order-wire-render.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";

const KEY = "memoryLendInjection";
/** 事务外准备的总时限：嵌入批次自己的时限再留 2 秒 */
export const LEND_PREP_TIMEOUT_MS = EMBED_TIMEOUT_MS + 2_000;

const kindOf = (step: LendStep): MemoryOrderKind => (step === "review" ? "review" : "write");
export interface LendPreparation { inputs: RetrieveOpts; error?: string; startedAt: number }

function lendMode(db: Database, project: string, now: number, policy: RecoveryPolicyPort) {
  return decideRecovery(noteDefaultOn(db, { project, mechanism: KEY }, policy(project, KEY), now)).kind;
}

/** 只返回本次调用的输入，不登记排名；超时后的回包没有发布点，不能被下一张单消费。 */
export async function prepareLendMemory(db: Database, task: LedgerTask, step: LendStep, head: string | null,
  deps: EnsureDeps = {}): Promise<LendPreparation> {
  if (db.inTransaction) throw new Error("出借记忆准备不能持有台账事务");
  const startedAt = Date.now(), budget = deps.timeoutMs ?? LEND_PREP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`记忆检索超时（${budget} ms）`)), budget); });
    const inputs = await Promise.race([retrievalInputs(db, task, kindOf(step), head, { ...deps, visibility: "team", isolated: true, throwOnError: true }), timeout]);
    return { inputs: { ...inputs, visibility: "team", isolated: true }, startedAt };
  } catch (e) {
    return { inputs: {}, error: (e as Error).message, startedAt }; // 挂单仍可成功，错误仅由成功事务的 commit 登记。
  } finally { clearTimeout(timer); }
}

/** 挂单拿到的记忆：wire / whole 是要发的单子（off / 出错时原样），commit 在挂单行写进之后调。 */
export interface LendMemory { wire: OrderWire; whole: OrderWire; commit(sent: OrderWire): void; sample?: { ids: string[]; result: MemoryAttemptResult; bytes: number } }

const visibilities = (db: Database, ids: readonly string[]) => ids.map((id) => memoryState(db, id)?.memory.visibility ?? "unknown");

/**
 * renderLendOffer 在过外发闸之前调（只在有 notes 的本机挂单路径）。返回 null = off 档，调用方逐字照旧。
 * 同步：只读排名缓存或现算图 + 文件两路（on 档把排名记成 team 专用的 fallback 一份，和本机领单同一套）。
 */
export function lendMemory(db: Database, task: LedgerTask, step: LendStep, orderId: string, made: { wire: OrderWire; whole: OrderWire },
  opts: { now?: number; policy?: RecoveryPolicyPort; preparation?: LendPreparation } = {}): LendMemory | null {
  const now = opts.now ?? Date.now();
  let mode: ReturnType<typeof lendMode>;
  try { mode = lendMode(db, task.project, now, opts.policy ?? recoveryPolicy); }
  catch (e) { console.error(`⚠️ ${task.id} 出借记忆开关读不了，按 off：${(e as Error).message}`); return null; }
  if (mode === "skip") return null;
  const kind = kindOf(step), head = made.wire.head, startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const unchanged = { wire: made.wire, whole: made.whole };
  const observe = (result: MemoryAttemptResult, ids: string[], section: string, reason?: string) => {
    try {
      recordObserved(db, { project: task.project, mechanism: KEY, target: task.id, actionKey: orderId,
        action: `把 ${ids.length} 条项目记忆写进出借单 ${orderId}（${kind}）`,
        data: { orderId, order: kind, result, count: ids.length, visibilities: visibilities(db, ids),
          bytes: Buffer.byteLength(section), elapsedMs: elapsed(), ...(reason ? { reason } : {}) } }, now);
    } catch (e) { console.error(`⚠️ ${task.id} 出借记忆观察样本没记上：${(e as Error).message}`); }
  };
  let fit: MemoryFit<OrderWire>, reason: string | undefined;
  try {
    if (opts.preparation?.error) throw new Error(opts.preparation.error);
    fit = fitMemory(db, task, kind, head, made.wire, { ...opts.preparation?.inputs, visibility: "team",
      persist: !opts.preparation && mode === "act", now, startedAt: opts.preparation?.startedAt ?? startedAt });
    if (fit.section) {
      try { redactOrderForPeer({ ...made.wire, inputs: [fit.section] }, head); } // 这一节单独过 peer 外发闸：拒了就整节不放，单子照发
      catch (e) { reason = `外发闸拒绝：${(e as Error).message}`; fit = { ...fit, wire: made.wire, ids: [], result: "error", section: "" }; }
    }
  } catch (e) {
    const why = (e as Error).message;
    console.error(`⚠️ ${task.id} 出借单记忆没放（单子照发）：${why}`);
    return { ...unchanged, sample: { ids: [], result: "error", bytes: 0 }, commit: () => {
      if (mode === "observe") observe("error", [], "", why);
      else recordMemoryAttempt(db, task, { orderId, channel: "lend", order: kind, result: "error", count: 0, elapsedMs: elapsed(), reason: why }, now);
    } };
  }
  const took = elapsed();
  const attempt = (result: MemoryAttemptResult, count: number) =>
    recordMemoryAttempt(db, task, { orderId, channel: "lend", order: kind, result, count, elapsedMs: took, ...(reason ? { reason } : {}) }, now);
  const sample = { ids: fit.ids, result: fit.result, bytes: Buffer.byteLength(fit.section) };
  if (mode === "observe") {
    const would = fit;
    return { ...unchanged, sample, commit: () => {
      observe(would.result, would.ids, would.section, reason);
    } };
  }
  const added = fit.section ? { ...made.whole, inputs: [...made.whole.inputs, fit.section] } : made.whole;
  return { wire: fit.wire, whole: added, sample, commit: (sent) => {
    recordMemoryInjection(db, task, kind, head, fit, sent, "lend", now, "team", opts.preparation ? `lend:${orderId}` : "fallback");
    attempt(fit.result, fit.ids.length);
  } };
}
