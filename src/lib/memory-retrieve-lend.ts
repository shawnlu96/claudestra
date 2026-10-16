/**
 * PMEMTUNE1 · 出借单（write / fix / review）的项目记忆：复用本机领单的检索、选择、渲染（memory-retrieve-order.ts fitMemory），
 * 只多两条约束——只排、只画 visibility = team 的记忆（home 一条都不出本机），那一节先单独过一遍 peer 外发闸，过不了就不放。
 * 预算同本机：write / fix 4 条 / 1600 字节；review 只放坑 3 条 / 1000 字节（MEMORY_CAPS）。
 *
 * 开关是恢复键 memoryLendInjection（高风险 safety 类，缺省 observe）：
 * - off：什么都不做，单子与事件和改动前逐字相同。
 * - observe：照算「本会注入」的条目，不写进单子，挂单成功后按单号记一条恢复观察样本（条数、各条 visibility、字节数）。
 * - on：写进单子；挂单行写进 lend_orders 之后（同一事务）才按现有口径记推出，并记一条检索尝试（memory-inject-attempt.ts）。
 * 检索失败 / 事务外准备超时：单子照发、不带记忆，尝试记 error。tests/memory-lend-inject.test.ts。
 */
import type { Database } from "bun:sqlite";
import { EMBED_TIMEOUT_MS } from "./memory-embed.js";
import { memoryState } from "./ledger-memory.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { LendStep } from "./lend-git.js";
import { recordMemoryAttempt, type MemoryAttemptResult } from "./memory-inject-attempt.js";
import type { MemoryOrderKind } from "./memory-retrieve.js";
import { ensureMemoryRetrieval, fitMemory, recordMemoryInjection, type EnsureDeps, type MemoryFit } from "./memory-retrieve-order.js";
import type { OrderWire } from "./order-wire.js";
import { redactOrderForPeer } from "./order-wire-render.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";

const KEY = "memoryLendInjection";
/** 事务外准备的总时限：嵌入批次自己的时限再留 2 秒 */
export const LEND_PREP_TIMEOUT_MS = EMBED_TIMEOUT_MS + 2_000;

const kindOf = (step: LendStep): MemoryOrderKind => (step === "review" ? "review" : "write");
const prepKey = (task: Pick<LedgerTask, "id" | "specRev">, head: string | null, kind: MemoryOrderKind) => `${task.id}:${task.specRev}:${head ?? "-"}:${kind}`;
/** 本连接上事务外准备失败的单子（下一次挂单读走一次）：按无记忆照发，尝试记 error */
const failedPrep = new WeakMap<Database, Map<string, string>>();

function lendMode(db: Database, project: string, now: number, policy: RecoveryPolicyPort) {
  return decideRecovery(noteDefaultOn(db, { project, mechanism: KEY }, policy(project, KEY), now)).kind;
}

/**
 * 挂单前（事务外）调：补嵌入、走语义路，排名记成 team 专用的 prepared 一份。永不抛；超时 / 出错只记在本连接上，
 * 下一次挂单这张卡时按无记忆照发。off 档不做任何事。
 */
export async function prepareLendMemory(db: Database, task: LedgerTask, step: LendStep, head: string | null,
  deps: EnsureDeps & { policy?: RecoveryPolicyPort } = {}): Promise<void> {
  const kind = kindOf(step);
  try {
    if (lendMode(db, task.project, deps.now ?? Date.now(), deps.policy ?? recoveryPolicy) === "skip") return;
    const budget = deps.timeoutMs ?? LEND_PREP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`记忆检索超时（${budget} ms）`)), budget); });
    try { await Promise.race([ensureMemoryRetrieval(db, task, kind, head, { ...deps, visibility: "team", throwOnError: true }), timeout]); }
    finally { clearTimeout(timer); }
  } catch (e) {
    let m = failedPrep.get(db);
    if (!m) failedPrep.set(db, m = new Map());
    m.set(prepKey(task, head, kind), (e as Error).message);
  }
}

/** 挂单拿到的记忆：wire / whole 是要发的单子（off / 出错时原样），commit 在挂单行写进之后调。 */
export interface LendMemory { wire: OrderWire; whole: OrderWire; commit(sent: OrderWire): void }

const visibilities = (db: Database, ids: readonly string[]) => ids.map((id) => memoryState(db, id)?.memory.visibility ?? "unknown");

/**
 * renderLendOffer 在过外发闸之前调（只在有 notes 的本机挂单路径）。返回 null = off 档，调用方逐字照旧。
 * 同步：只读排名缓存或现算图 + 文件两路（on 档把排名记成 team 专用的 fallback 一份，和本机领单同一套）。
 */
export function lendMemory(db: Database, task: LedgerTask, step: LendStep, orderId: string, made: { wire: OrderWire; whole: OrderWire },
  opts: { now?: number; policy?: RecoveryPolicyPort } = {}): LendMemory | null {
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
    const prep = failedPrep.get(db)?.get(prepKey(task, head, kind));
    if (prep !== undefined) {
      failedPrep.get(db)!.delete(prepKey(task, head, kind));
      throw new Error(prep);
    }
    fit = fitMemory(db, task, kind, head, made.wire, { visibility: "team", persist: mode === "act", now, startedAt });
    if (fit.section) {
      try { redactOrderForPeer({ ...made.wire, inputs: [fit.section] }, head); } // 这一节单独过 peer 外发闸：拒了就整节不放，单子照发
      catch (e) { reason = `外发闸拒绝：${(e as Error).message}`; fit = { ...fit, wire: made.wire, ids: [], result: "error", section: "" }; }
    }
  } catch (e) {
    const why = (e as Error).message;
    console.error(`⚠️ ${task.id} 出借单记忆没放（单子照发）：${why}`);
    return { ...unchanged, commit: () => {
      if (mode === "observe") observe("error", [], "", why);
      else recordMemoryAttempt(db, task, { orderId, channel: "lend", order: kind, result: "error", count: 0, elapsedMs: elapsed(), reason: why }, now);
    } };
  }
  const took = elapsed();
  const attempt = (result: MemoryAttemptResult, count: number) =>
    recordMemoryAttempt(db, task, { orderId, channel: "lend", order: kind, result, count, elapsedMs: took, ...(reason ? { reason } : {}) }, now);
  if (mode === "observe") {
    const would = fit;
    return { ...unchanged, commit: () => {
      observe(would.result, would.ids, would.section, reason);
    } };
  }
  const added = fit.section ? { ...made.whole, inputs: [...made.whole.inputs, fit.section] } : made.whole;
  return { wire: fit.wire, whole: added, commit: (sent) => {
    recordMemoryInjection(db, task, kind, head, fit, sent, "lend", now);
    attempt(fit.result, fit.ids.length);
  } };
}
