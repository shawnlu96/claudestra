/**
 * 交回自动时卡还在 spec（i28-RSM1）：开卡（start_node / 自动开卡）放到 peer 时会记放置 decision、以「远端卡复述跳过」推到 restate，
 * 交回自动（ledger-scheduler-resume.ts）没有这一步，于是 spec 阶段的计划只会给本机派复述单——本机没名额、出借池又不收复述单，卡就一直等，也不报。
 * 这一步在调度服务每轮的 auto tick 之前跑（scheduler-pass.ts，紧跟自动交回），所以刚交回的卡与存量卡（spec、auto、没有放置记录）都由它接住：
 * - 用自动开卡同一套放置计算（scheduler-placement-start.ts startPlacement，finishFirst）；放到 peer → `ledger scheduler-spec-place --peer`
 *   照开卡的规矩推到 restate，同一轮的 tick 就按放置派开工单；
 * - 放在本机 → 什么都不写，planner 照旧派本机复述单；
 * - 算不出来 → `--wait` 记一条带原因的等待事件，台账说是新原因（recorded）才报 PM，同一原因连续多轮只报一次，原因变了再报。
 * 挑卡与台账写的资格是同一个 specPlaceBlock（scheduler-spec-resume-write.ts）；卡推过 spec 就不再被挑中，重复跑不重复记。
 * tests/scheduler-spec-resume.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import type { StartPlacement } from "./scheduler-placement-start.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { specPlaceBlock } from "./scheduler-spec-resume-write.js";
import type { TickPace } from "./scheduler-yield.js";

type Failed = { taskId: string; error: string }[];

export interface SpecResumeEnv {
  db: Database;
  /** scheduler.json 里开了自动派单的项目 */
  projects: readonly string[];
  /** 调度身份的 ledger CLI（已套租约守卫） */
  ledger(...args: string[]): Promise<Record<string, unknown>>;
  /** 自动开卡同一套放置（生产接线见 scheduler-spec-resume-deps.ts） */
  place(db: Database, q: { project: string; repoDir: string; fileGlobs: readonly string[]; want: "auto" }): Promise<StartPlacement>;
  /** 项目的 git 仓库目录；没有为 null（不放置，维持现状） */
  repoDir(project: string): Promise<string | null>;
  notifyPm(project: string, text: string): Promise<void>;
}

/** 卡推不动的台账回执（卡被改过、不再合格）：下一轮重算，不算失败 */
const QUIET = new Set(["conflict", "busy"]);

function candidates(db: Database, project: string): string[] {
  return (db.query(`SELECT t.id FROM tasks AS t JOIN task_workflows AS w ON w.taskId = t.id
    WHERE t.project = ? AND t.stage = 'spec' AND w.mode = 'auto' AND w.specRev = t.specRev ORDER BY t.id`).all(project) as { id: string }[]).map((r) => r.id);
}

export async function specResumeTick(env: SpecResumeEnv, pace?: TickPace): Promise<Failed> {
  const failed: Failed = [];
  for (const project of env.projects) {
    for (const id of candidates(env.db, project)) {
      if (pace?.yieldNow()) return failed;
      const err = await placeOne(env, project, id).catch((e: Error) => { if (e instanceof SchedulerStopped) throw e; return e.message; });
      if (err) failed.push({ taskId: id, error: `spec 放置：${err}` });
    }
  }
  return failed;
}

async function placeOne(env: SpecResumeEnv, project: string, id: string): Promise<string | null> {
  const task = getTask(env.db, id), wf = getWorkflow(env.db, id);
  const globs = Array.isArray(task?.extra.fileGlobs) ? (task.extra.fileGlobs as unknown[]).filter((g): g is string => typeof g === "string") : [];
  if (!task || !wf || specPlaceBlock(env.db, task, wf) || !globs.length) return null; // 没有文件范围的卡由 planner 报 file_scope
  const repoDir = await env.repoDir(project);
  if (!repoDir) return null;
  const placed = await env.place(env.db, { project, repoDir, fileGlobs: globs, want: "auto" });
  if (placed.where === "local") return null;
  const cas = ["--rev", String(task.rev), "--workflow-rev", String(wf.rev)];
  const r = placed.where === "peer"
    ? await env.ledger("ledger", "scheduler-spec-place", id, ...cas, "--peer", placed.peer, "--repo", placed.repo, "--reason", placed.reason)
    : await env.ledger("ledger", "scheduler-spec-place", id, ...cas, "--wait", `等写代码的空位：${placed.reason}`);
  if (r.ok !== true) return QUIET.has(String(r.code)) ? null : String(r.error ?? r.code);
  if (placed.where === "refused" && r.recorded === true) {
    await env.notifyPm(project, `[自动调度 ${id}] 卡在 spec 等放置：等写代码的空位：${placed.reason}。` +
      "有空位后调度器下一轮自己接上（放到 peer 就跳过复述），同一原因不再重复报。");
  }
  return null;
}
