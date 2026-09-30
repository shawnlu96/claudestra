/** Scheduler-specific doctor row: the daemon may run correctly yet be deliberately inert. */
import { existsSync } from "node:fs";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import type { Check } from "./doctor.js";
import { LedgerReader } from "./ledger-read.js";
import { DEPLOY_LABEL_PREFIX, launchdRows } from "./scheduler-deploy-job.js";
import type { runBounded } from "./run-bounded.js";

export function checkSchedulerConfig(path = SCHEDULER_CONFIG_PATH): Check[] {
  const base = { group: "launchd daemon", name: "调度引擎配置" };
  if (!existsSync(path)) return [{ ...base, status: "warn", detail: "未配置；scheduler 服务空转",
    fix: `在 ${path} 写入 enabled、projects 与部署目标后重跑 doctor` }];
  try {
    const config = readSchedulerConfig(path);
    return config.enabled
      ? [{ ...base, status: "ok", detail: `已启用 ${Object.keys(config.projects).length} 个项目` }]
      : [{ ...base, status: "warn", detail: "配置已读取，但 enabled=false；scheduler 服务空转" }];
  } catch (e) {
    return [{ ...base, status: "fail", detail: `配置无效：${(e as Error).message}`, fix: `修复 ${path} 后重跑 doctor` }];
  }
}

/**
 * `unknown` merge journals never clear themselves (by design) and no longer block updates, so doctor is where they stay visible.
 * Deployment labels are KeepAlive launchd jobs: one that is loaded but not running is a relaunch loop the worker failed to remove.
 */
export async function checkSchedulerJournal(reader = new LedgerReader(), command?: typeof runBounded): Promise<Check[]> {
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
        fix: "PM 核对 GitHub 与部署目标后：ledger scheduler-merge-resolve <intent> --outcome done|failed|cancelled --receipt <证据>，再 ledger unfreeze" }
      : { group: "launchd daemon", name: "合并队列结果不明", status: "ok", detail: "没有待人工结清的合并" });
  } catch (e) {
    out.push({ group: "launchd daemon", name: "合并队列结果不明", status: "warn", detail: `读不了台账：${(e as Error).message}` });
  } finally { reader.close(); }
  if (process.platform !== "darwin") return out;
  const labels = (await launchdRows(command))?.filter((cols) => cols.at(-1)?.startsWith(DEPLOY_LABEL_PREFIX));
  if (!labels) return [...out, { group: "launchd daemon", name: "部署任务残留", status: "warn", detail: "launchctl list 读取失败" }];
  const stale = labels.filter((cols) => cols[0] === "-");
  return [...out, stale.length
    ? { group: "launchd daemon", name: "部署任务残留", status: "warn", detail: `${stale.length} 个已退出但仍被 launchd 反复拉起：${stale.map((c) => c.at(-1)).join(", ")}`,
      fix: "确认对应部署已有 result.json 后逐个 launchctl remove <label>" }
    : { group: "launchd daemon", name: "部署任务残留", status: "ok", detail: labels.length ? `${labels.length} 个部署进行中` : "无" }];
}

export async function checkScheduler(): Promise<Check[]> {
  return [...checkSchedulerConfig(), ...await checkSchedulerJournal()];
}
