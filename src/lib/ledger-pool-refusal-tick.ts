/**
 * dispatch-recovery-MODELXP2 · 调度 tick 这一侧：挂池意图每轮镜像出借单之前（scheduler-pool 会把结果不明的单镜像成 unknown 意图，
 * 调度身份结算不了 unknown），先在只读句柄上看这张单是不是「出借方声明 provider_policy 的停单」：是就按 MODELXP1 的识别预判，
 * 预判确认才走 `ledger scheduler-pool-refusal` 写口（写口事务里再核一遍）。没有类别 / 别的类别 / 只有原因文本 → 只记 suspect 一行，
 * 照旧走老路（单停给 PM）。modelOutcome off 不动；observe 由写口只记计划。tests/ledger-pool-refusal-prod.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getLendOrder } from "./ledger-lend.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { lenderRelease, poolOrderFacts } from "./ledger-pool-refusal.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { SchedulerLeaseLost } from "./scheduler-lease-env.js";
import { modelOutcomeMode } from "./scheduler-model-wiring.js";
import { poolOrderId } from "./scheduler-pool-facts.js";
import { isPoolPolicyRefusal, recognizePoolRefusal } from "./scheduler-refusal-pool.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface PoolRefusalTickDeps { db: Database; manager: Manager; localFamilies?: readonly AuthorFamily[]; log?(line: string): void }

const diag = (d: PoolRefusalTickDeps, line: string): void => (d.log ?? ((m: string) => console.error(m)))(`[pool-refusal] ${line}`.slice(0, 400));

/** 一个挂池意图这一轮的池单拒审处置；null = 不归这里（调用方照旧 scheduler-pool），否则是这一步的结果 */
export async function poolRefusalStep(d: PoolRefusalTickDeps, task: LedgerTask, intent: SchedulerIntent): Promise<{ step: string; detail: string } | null> {
  if (intent.status !== "pending" && intent.status !== "submitted") return null;
  const orderId = poolOrderId(d.db, intent.id), o = orderId ? getLendOrder(d.db, orderId) : null;
  if (!o || o.status !== "unknown") return null;
  const released = lenderRelease(d.db, o);
  if (!released) return null;
  const detail = String((released.event.data.lend as { detail?: unknown }).detail ?? "");
  if (released.failure?.class !== "provider_policy") {
    // 借入方只信结构化类别：文本像拒审也只记疑似，不撤单
    if (isPoolPolicyRefusal(detail) || detail.includes("内容策略拦截")) {
      diag(d, `${task.id} 疑似池单拒审，未能确认：${released.failure ? `出借方报的类别是 ${released.failure.class}` : "出借方没带结构化类别"}（${o.orderId}），照旧交 PM`);
    }
    return null;
  }
  const r = recognizePoolRefusal(poolOrderFacts(d.db, o), { stage: task.stage, headSHA: task.headSHA, specRev: task.specRev, round: task.round },
    { source: "lender_declared", category: "provider_policy", sessionId: released.failure.sessionId, failedAt: released.failure.failedAt, doubt: null, message: detail });
  if (r.kind !== "confirmed") return (diag(d, `${task.id} ${r.kind === "suspected" ? r.note : "不是池单拒审"}（${o.orderId}），照旧交 PM`), null);
  if ((await modelOutcomeMode(task.project)) === "off") return null;
  let res: Record<string, unknown>;
  try {
    res = await d.manager("ledger", "scheduler-pool-refusal", task.id, "--order", o.orderId, "--data",
      JSON.stringify(d.localFamilies ? { localFamilies: d.localFamilies } : {}));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof SchedulerLeaseLost) throw new SchedulerStopped(`ledger scheduler-pool-refusal: ${e.message}`);
    return (diag(d, `${task.id} 池单拒审写口没走通，照旧交 PM：${e instanceof Error ? e.message : String(e)}`), null);
  }
  if (res.code === "lease-lost") throw new SchedulerStopped(`ledger scheduler-pool-refusal: ${String(res.error)}`);
  if (res.ok !== true) return (diag(d, `${task.id} 池单拒审写口拒绝（${String(res.code)}），照旧交 PM：${String(res.error)}`), null);
  const plan = res.plan as { kind?: string } | undefined;
  // observe 只记了计划；manual 不撤单：这两种都让老路接着走（意图镜像成 unknown，停给 PM）
  if (res.mode !== "on" || plan?.kind !== "replace" || res.cancelled !== true) return null;
  return { step: "pool_refusal", detail: String(res.text ?? "") };
}
