/**
 * rename.installConfig：off 什么都不读不写；observe 只出逐项计划；on 用迁移事务执行两个写步骤（steps.ts）。
 * 回滚只对本迁移的日志生效：已提交的按日志逆序补偿，补偿重读当前文件、只撤本迁移加的条目，之后日志记为已回滚。
 * 日志放在维护根下（不在 ~/.claude、仓库或状态 / 运行目录里）。日志每步旧值带目标指纹（plan.ts installTarget），
 * 续跑、重放和回滚前都先核：日志属于别的仓库 / HOME 时一律拒绝，不把已提交当成这次的结果，也不拿旧值去补偿别的文件。
 * tests/floka-install-config.test.ts。
 */
import { dirname, join } from "node:path";
import { rollbackTransaction, runTransaction } from "../floka-migration/transaction/executor.js";
import { errorText, loadJournal, lockPath, saveJournal } from "../floka-migration/transaction/journal.js";
import { acquireLock } from "../file-lock.js";
import type { TxReport } from "../floka-migration/transaction/types.js";
import { journalOutside } from "../floka-config/transaction.js";
import type { RenameMode } from "../floka-config/values.js";
import { object } from "../floka-config/values.js";
import { envPathOf, installConfigMode, installTarget, planInstallConfig, settingsPathOf, type InstallHome, type PlanEntry } from "./plan.js";
import { INSTALL_CONFIG_ITEM, STEP_IDS, installConfigSteps } from "./steps.js";

export interface InstallConfigOptions extends InstallHome { config: unknown; txId: string; journalDir: string; crashAt?: (p: string) => void }
export interface InstallConfigReport { mode: RenameMode; status: TxReport["status"]; plan: PlanEntry[]; tx?: TxReport; error?: string }

const managed = (h: InstallHome): string[] => [dirname(settingsPathOf(h)), dirname(envPathOf(h))];

const txOptions = (o: Omit<InstallConfigOptions, "config">) => ({
  txId: o.txId, mode: "on" as const, items: { [INSTALL_CONFIG_ITEM]: "on" as const }, steps: installConfigSteps(o),
  adapter: null, stateDir: o.journalDir, crashAt: o.crashAt,
});

/** 日志里任一步记的目标与当前不同（或没记目标）就返回拒绝原因；没有日志 / 日志坏了交给执行器按原路处理 */
async function foreignJournal(o: Omit<InstallConfigOptions, "config">): Promise<string | null> {
  const load = await loadJournal(o.journalDir, o.txId, [...STEP_IDS]);
  if (load.kind !== "ok") return null;
  const target = installTarget(o);
  return load.journal.steps.some(r => object(r.before).target !== target)
    ? `事务 ${o.txId} 的日志属于另一个仓库 / HOME，拒绝在当前目标上重放或回滚` : null;
}

const refusedReport = (txId: string, error: string): TxReport => ({ txId, mode: "on", status: "refused", steps: [], error });

export async function runInstallConfig(o: InstallConfigOptions): Promise<InstallConfigReport> {
  const mode = installConfigMode(o.config);
  if (mode === "off") return { mode, status: "off", plan: [] };
  const plan = await planInstallConfig(o);
  if (mode === "observe") return { mode, status: "observed", plan };
  journalOutside(o.journalDir, managed(o));
  const foreign = await foreignJournal(o);
  if (foreign) return { mode, status: "refused", plan, tx: refusedReport(o.txId, foreign), error: foreign };
  const tx = await runTransaction(txOptions(o));
  return { mode, status: tx.status, plan, tx, ...(tx.error ? { error: tx.error } : {}) };
}

/** 显式回滚；未完成的事务交给执行器续补偿，已提交的在这里逆序补偿后把日志记成已回滚（同一 txId 不会再执行） */
export async function rollbackInstallConfig(o: Omit<InstallConfigOptions, "config">): Promise<TxReport> {
  journalOutside(o.journalDir, managed(o));
  const foreign = await foreignJournal(o);
  if (foreign) return refusedReport(o.txId, foreign);
  const steps = installConfigSteps(o);
  const load = await loadJournal(o.journalDir, o.txId, [...STEP_IDS]);
  if (load.kind !== "ok" || load.journal.status !== "committed") return rollbackTransaction(txOptions(o));
  const lock = await acquireLock(lockPath(o.journalDir, o.txId), 2_000);
  if (!lock) return refusedReport(o.txId, "事务锁被占用,稍后重试");
  let j = load.journal;
  try {
    const fresh = await loadJournal(o.journalDir, o.txId, [...STEP_IDS]); // 拿锁前读到的可能已被并发回滚改过
    if (fresh.kind !== "ok" || fresh.journal.status !== "committed") return refusedReport(o.txId, "事务状态刚变过,重试回滚");
    j = fresh.journal;
    for (const rec of [...j.steps].reverse()) {
      if (rec.state === "compensated") continue;
      try { await steps.find(s => s.id === rec.id)!.compensate(null, rec.before); } catch (e) {
        // 停在失败的那步：执行器的 rollbackTransaction 能从 rollback_failed 续补偿
        Object.assign(rec, { state: "compensate_failed", error: errorText(e) });
        j.status = "rollback_failed";
        j.failure = { step: rec.id, error: errorText(e) };
        await saveJournal(o.journalDir, j);
        return { txId: o.txId, mode: "on", status: "rollback_failed", steps: [], failedStep: rec.id, error: errorText(e) };
      }
      rec.state = "compensated";
    }
    j.status = "rolled_back";
    await saveJournal(o.journalDir, j);
  } finally { lock.release(); }
  return { txId: o.txId, mode: "on", status: "rolled_back", steps: j.steps.map(r => ({ id: r.id, item: r.item, mode: "on" as const, state: r.state })) };
}

export const defaultJournalDir = (maintRoot: string): string => join(maintRoot, "install-config");
