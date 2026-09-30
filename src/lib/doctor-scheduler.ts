/** Scheduler-specific doctor row: the daemon may run correctly yet be deliberately inert. */
import { existsSync } from "node:fs";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import type { Check } from "./doctor.js";
import { LedgerReader } from "./ledger-read.js";

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
    out.push(rows.length
      ? { group: "launchd daemon", name: "合并队列结果不明", status: "warn",
        detail: rows.map((r) => `${r.project}/${r.taskId}（${r.intentId}）：${(r.reason ?? "").slice(0, 120)}`).join("；"),
        fix: "PM 核对 GitHub 后：ledger scheduler-merge-resolve <intent> --outcome done|failed|cancelled --receipt <证据>，再 ledger unfreeze" }
      : { group: "launchd daemon", name: "合并队列结果不明", status: "ok", detail: "没有待人工结清的合并" });
  } catch (e) {
    out.push({ group: "launchd daemon", name: "合并队列结果不明", status: "warn", detail: `读不了台账：${(e as Error).message}` });
  } finally { reader.close(); }
  return out;
}

/** 出借循环也跑在 scheduler 服务里（设计稿 remote-capacity §2.3），出借声明一行跟着这里出 */
export async function checkScheduler(): Promise<Check[]> {
  const { checkLend, checkLendLoop } = await import("./doctor-lend.js");
  return [...checkSchedulerConfig(), ...checkSchedulerJournal(), ...await checkLend(), ...await checkLendLoop()];
}
