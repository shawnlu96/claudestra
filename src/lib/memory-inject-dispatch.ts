/**
 * PMEMTUNE1 · 全文直发（delivery = text：tmux Codex、领单工具拿不到单）的项目记忆。wake 投递由收件人 take_order / take_review 领，
 * 那条路已在领单入口注入（local_take），这里不碰。调度器的发送点各用一行包住 driveDispatch：
 *   sendWithMemory(db, task, order, (o) => driveDispatch(..., o))
 * 事务外准备（同本机领单的 HEAD 文件 + 语义路，带总时限，只算不记），同步拼节（fitMemory 现算排名），只有发送结果是 sent 才登记排名、
 * 按现有口径记推出和一条检索尝试（channel = direct）；没发出去（rejected / unknown / 抢输）台账上什么都不多。
 * 开关是恢复键 memoryDirectInjection（本机内部发送，不是高风险类，缺省 on）：off = 原样发、什么都不记；observe = 只记恢复观察样本。
 * 检索失败 / 超时：单子原样发，尝试记 error。tests/memory-inject-dispatch.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { recordMemoryAttempt, withLedgerWriter } from "./memory-inject-attempt.js";
import { LEND_PREP_TIMEOUT_MS } from "./memory-retrieve-lend.js";
import type { MemoryOrderKind } from "./memory-retrieve.js";
import { fitMemory, recordMemoryInjection, retrievalInputs, type EnsureDeps, type MemoryFit, type RetrieveOpts } from "./memory-retrieve-order.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryDecision, type RecoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { WorkOrder } from "./worker-session.js";

const KEY = "memoryDirectInjection";

export interface DirectMemoryDeps {
  policy?: RecoveryPolicyPort;
  /** 事务外准备的依赖（嵌入模型 / 向量库 / 仓库）；测试注入 */
  ensure?: EnsureDeps;
  /** 准备的总时限；缺省同出借（嵌入时限 + 2 秒） */
  timeoutMs?: number;
  /** 测试替换整个准备步骤（模拟抛错 / 卡住） */
  prepare?: (db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null) => Promise<RetrieveOpts>;
}

/** 只算不记：发送之前台账上不能多出任何事件（接管路径认领后会因「计划后有新事件」作废重规划） */
async function prepared(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, deps: DirectMemoryDeps): Promise<RetrieveOpts> {
  const budget = deps.timeoutMs ?? LEND_PREP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`记忆检索超时（${budget} ms）`)), budget); });
  const work = deps.prepare ? deps.prepare(db, task, kind, head) : retrievalInputs(db, task, kind, head, deps.ensure);
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

/**
 * 全文直发的一行包装：只有 text 投递的写 / 修 / 审查单才动；send 的结果原样返回。
 * 发送之前只读（排名现算、不登记）；发送结果是 sent 之后才写：排名、推出、检索尝试、缺省档 / 观察样本。
 */
export async function sendWithMemory<R extends { kind: string }>(db: Database, task: LedgerTask, order: WorkOrder,
  send: (order: WorkOrder) => Promise<R>, deps: DirectMemoryDeps = {}): Promise<R> {
  if (order.delivery?.mode !== "text" || (order.step !== "write" && order.step !== "fix" && order.step !== "review")) return send(order);
  const kind: MemoryOrderKind = order.step === "review" ? "review" : "write", head = order.head, orderId = order.dedupKey;
  let policy: RecoveryPolicy, gate: RecoveryDecision["kind"];
  try { policy = (deps.policy ?? recoveryPolicy)(task.project, KEY); gate = decideRecovery(policy).kind; }
  catch (e) { console.error(`⚠️ ${task.id} 直发记忆开关读不了，按 off：${(e as Error).message}`); return send(order); }
  if (gate === "skip") return send(order);
  const after = (fn: (w: Database) => void) => {
    try { withLedgerWriter(db, (w) => { noteDefaultOn(w, { project: task.project, mechanism: KEY }, policy, Date.now()); fn(w); }); }
    catch (e) { console.error(`⚠️ ${task.id} 直发记忆样本没记上：${(e as Error).message}`); }
  };
  const startedAt = Date.now();
  let fit: MemoryFit<WorkOrder>;
  try {
    const opts = await prepared(db, task, kind, head, deps);
    fit = fitMemory(db, task, kind, head, order, { ...opts, startedAt });
  } catch (e) {
    const reason = (e as Error).message;
    console.error(`⚠️ ${task.id} 直发单记忆没放（单子照发）：${reason}`);
    const r = await send(order);
    if (gate === "act" && r.kind === "sent") {
      after(() => {});
      recordMemoryAttempt(db, task, { orderId, channel: "direct", order: kind, result: "error", count: 0, elapsedMs: Date.now() - startedAt, reason });
    }
    return r;
  }
  const took = Date.now() - startedAt;
  if (gate === "observe") {
    const r = await send(order);
    if (r.kind === "sent" && (fit.section || fit.result !== "empty")) {
      after((w) => recordObserved(w, { project: task.project, mechanism: KEY, target: task.id, actionKey: orderId,
        action: `把 ${fit.ids.length} 条项目记忆写进全文直发单（${kind}）`,
        data: { orderId, order: kind, result: fit.result, count: fit.ids.length, bytes: Buffer.byteLength(fit.section), elapsedMs: took } }, Date.now()));
    }
    return r;
  }
  const r = await send(fit.wire);
  if (r.kind === "sent") {
    after(() => {});
    recordMemoryInjection(db, task, kind, head, fit, fit.wire, "direct");
    recordMemoryAttempt(db, task, { orderId, channel: "direct", order: kind, result: fit.result, count: fit.ids.length, elapsedMs: took });
  }
  return r;
}
