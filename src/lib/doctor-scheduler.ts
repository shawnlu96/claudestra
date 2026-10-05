/** Scheduler-specific doctor row: the daemon may run correctly yet be deliberately inert. */
import { existsSync } from "node:fs";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import type { Check } from "./doctor.js";
import { LedgerReader } from "./ledger-read.js";
import { poolCounts } from "./scheduler-pool-facts.js";

export function checkSchedulerConfig(path = SCHEDULER_CONFIG_PATH): Check[] {
  const base = { group: "launchd daemon", name: "调度引擎配置" };
  if (!existsSync(path)) return [{ ...base, status: "warn", detail: "未配置；scheduler 服务空转",
    fix: `在 ${path} 写入 enabled 与 projects（requiredChecks、repoDir）后重跑 doctor` }];
  try {
    const config = readSchedulerConfig(path);
    return config.enabled
      ? [{ ...base, status: "ok", detail: `已启用 ${Object.keys(config.projects).length} 个项目` }]
      : [{ ...base, status: "warn", detail: "配置已读取，但 enabled=false；scheduler 服务空转" }];
  } catch (e) {
    return [{ ...base, status: "fail", detail: `配置无效：${(e as Error).message}`, fix: `修复 ${path} 后重跑 doctor` }];
  }
}

/** `unknown` merge journals never clear themselves (by design) and hold off every update, so doctor names each one and its exit. */
export function checkSchedulerJournal(reader = new LedgerReader()): Check[] {
  const out: Check[] = [];
  try {
    const db = reader.get();
    const rows = db?.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()
      ? db.query("SELECT intentId, taskId, project, reason FROM scheduler_merges WHERE phase='unknown' ORDER BY updatedAt").all() as
        { intentId: string; taskId: string; project: string; reason: string | null }[]
      : [];
    // A deploy unknown (T68g) has the same exit; it does not hold off updates, but the queue stays frozen until resolved.
    if (db?.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) {
      rows.push(...db.query("SELECT intentId, taskId, project, '部署：' || COALESCE(reason,'') AS reason FROM scheduler_deploys WHERE phase='unknown'").all() as typeof rows);
    }
    out.push(rows.length
      ? { group: "launchd daemon", name: "合并队列结果不明", status: "warn",
        detail: rows.map((r) => `${r.project}/${r.taskId}（${r.intentId}）：${(r.reason ?? "").slice(0, 120)}`).join("；"),
        fix: "PM 核对 GitHub（部署的看任务目录 scheduler-deploy/ 的 result.json）后：ledger scheduler-merge-resolve <intent> --outcome done|failed|cancelled --receipt <证据>，再 ledger unfreeze" }
      : { group: "launchd daemon", name: "合并队列结果不明", status: "ok", detail: "没有待人工结清的合并" });
  } catch (e) {
    out.push({ group: "launchd daemon", name: "合并队列结果不明", status: "warn", detail: `读不了台账：${(e as Error).message}` });
  } finally { reader.close(); }
  return out;
}

/** 共享池（i28-R9）：调度器挂出去的审查单各停在哪；结果不明的要 PM 核对，所以报 warn */
export function checkSchedulerPool(reader = new LedgerReader()): Check[] {
  const base = { group: "launchd daemon", name: "共享池" };
  try {
    const db = reader.get();
    if (!db) return [{ ...base, status: "ok", detail: "还没有台账" }];
    const n = poolCounts(db);
    const detail = `挂出待领 ${n.pooled}，被领在审 ${n.claimed}，已交结论 ${n.done}，超时撤回 ${n.timedOut}，结果不明 ${n.unknown}`;
    return n.unknown
      ? [{ ...base, status: "warn", detail, fix: "PM 核对对方结果后：ledger lend-reoffer <task> 或 lend-cancel <task>，再处理调度意图" }]
      : [{ ...base, status: "ok", detail }];
  } catch (e) {
    return [{ ...base, status: "warn", detail: `读不了台账：${(e as Error).message}` }];
  } finally { reader.close(); }
}

/** 卡 worker 生命周期（LIFE1）：活 N / 应收 M / swap x%，与调度器每轮算的是同一份计划；应收不为 0 且开关不是 on 时报 warn */
export async function checkWorkerLifecycle(reader = new LedgerReader()): Promise<Check[]> {
  const base = { group: "launchd daemon", name: "worker 生命周期" };
  try {
    const db = reader.get();
    if (!db) return [{ ...base, status: "ok", detail: "还没有台账" }];
    let policy;
    try { policy = readSchedulerConfig().lifecycle; } catch { policy = undefined; /* bad config is reported by 调度引擎配置; plan with defaults */ }
    const { lifecycleSnapshot } = await import("./agent-lifecycle-deps.js");
    const { lifecycleLine } = await import("./agent-lifecycle.js");
    const plan = await lifecycleSnapshot(db, policy);
    const mode = policy?.mode ?? "observe";
    const warn = (plan.actions.length > 0 && mode !== "on") || plan.memory.length > 0 || plan.registerFailed > 0;
    const fix = plan.registerFailed > 0 ? "登记失败的 agent 已保留：PM 按台账 worker_register_failed 事件核对后 manager remove 或补登记"
      : "核对 scheduler 日志里的 [lifecycle] 清单后，在 scheduler.json 设 lifecycle: \"on\"";
    return [{ ...base, status: warn ? "warn" : "ok", detail: lifecycleLine(plan, mode), ...(warn ? { fix } : {}) }];
  } catch (e) {
    return [{ ...base, status: "warn", detail: `算不出：${(e as Error).message}` }];
  } finally { reader.close(); }
}

/** 出借循环也跑在 scheduler 服务里（设计稿 remote-capacity §2.3），出借声明一行跟着这里出 */
export async function checkScheduler(): Promise<Check[]> {
  const { checkLend, checkLendLoop } = await import("./doctor-lend.js");
  return [...checkSchedulerConfig(), ...checkSchedulerJournal(), ...checkSchedulerPool(), ...await checkWorkerLifecycle(), ...await checkLend(), ...await checkLendLoop()];
}
