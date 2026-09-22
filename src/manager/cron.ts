/**
 * cron 管理命令（cron-add/list/edit/remove/toggle/history）。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { KNOWN_EFFORT_LEVELS, isKnownEffort } from "../lib/claude-launch.js";
import { readProjects } from "../lib/projects.js";
import { loadJobs, saveJobs, parseCronExpression, nextCronTime, CRON_DEFAULT_EFFORT, type CronJob } from "../cron.js";
import { output } from "./core.js";
// ============================================================
// Cron 管理命令
// ============================================================


/** v2.21.4+ cron 的 --project 校验:必须是已有 project id("-" = 清除,给 cron-edit 用)。 */
async function checkCronProject(project: string | undefined): Promise<string | null> {
  if (!project || project === "-") return null;
  const data = await readProjects();
  if (data.projects.some((p) => p.id === project)) return null;
  return `project "${project}" 不存在。已有: ${data.projects.map((p) => p.id).join(", ") || "(无)"}`;
}

export async function cmdCronAdd(name: string, schedule: string, dir: string, prompt: string, reportChannelId?: string, targetAgent?: string, effort?: string, project?: string) {
  // 验证 cron 表达式
  try {
    parseCronExpression(schedule);
  } catch (err) {
    output({ ok: false, error: (err as Error).message });
    return;
  }
  if (effort && !isKnownEffort(effort)) {
    output({ ok: false, error: `未知 effort: "${effort}"(可选 ${KNOWN_EFFORT_LEVELS.join("|")})` });
    return;
  }
  const projErr = await checkCronProject(project);
  if (projErr) {
    output({ ok: false, error: projErr });
    return;
  }

  const jobs = await loadJobs();

  // 检查同名
  if (jobs.some((j) => j.name === name)) {
    output({ ok: false, error: `已存在同名任务: "${name}"` });
    return;
  }

  const job: CronJob = {
    id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    schedule,
    prompt,
    dir: dir.replace(/^~/, process.env.HOME || "~"),
    enabled: true,
    createdAt: new Date().toISOString(),
    ...(reportChannelId ? { reportChannelId } : {}),
    ...(targetAgent ? { targetAgent } : {}),
    ...(effort ? { effort } : {}),
    ...(project && project !== "-" && !targetAgent ? { project } : {}),
  };

  try {
    job.nextRun = nextCronTime(schedule).toISOString();
  } catch { /* non-critical */ }

  jobs.push(job);
  await saveJobs(jobs);

  output({
    ok: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRun: job.nextRun },
    message: `定时任务 "${name}" 已创建 (${schedule})`,
  });
}

export async function cmdCronList() {
  const jobs = await loadJobs();
  output({
    ok: true,
    total: jobs.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      dir: j.dir.replace(process.env.HOME || "", "~"),
      prompt: j.prompt.slice(0, 80),
      enabled: j.enabled,
      lastRun: j.lastRun || null,
      nextRun: j.nextRun || null,
      ...(j.targetAgent ? { targetAgent: j.targetAgent } : {}),
      // 临时 agent 的 effort 档:未设 = 缺省 medium(targetAgent 模式不适用)
      ...(j.targetAgent ? {} : { effort: j.effort || CRON_DEFAULT_EFFORT }),
      // 临时 agent 的归属 project;未设 = 按 dir 自动解析
      ...(j.project ? { project: j.project } : {}),
    })),
  });
}

/** v2.20+ 原地编辑:保 id/lastRun/createdAt(改频率≠换任务,owner 2026-08-26
 *  「改个频率要重建不合理」)。schedule 变更时重算 nextRun。 */
export async function cmdCronEdit(
  nameOrId: string,
  patch: { schedule?: string; prompt?: string; name?: string; dir?: string; effort?: string; project?: string }
) {
  if (patch.schedule) {
    try {
      parseCronExpression(patch.schedule);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      return;
    }
  }
  if (patch.effort && !isKnownEffort(patch.effort)) {
    output({ ok: false, error: `未知 effort: "${patch.effort}"(可选 ${KNOWN_EFFORT_LEVELS.join("|")})` });
    return;
  }
  const projErr = await checkCronProject(patch.project);
  if (projErr) {
    output({ ok: false, error: projErr });
    return;
  }
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
  if (!job) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  if (patch.name && patch.name !== job.name && jobs.some((j) => j.name === patch.name)) {
    output({ ok: false, error: `已存在同名任务: "${patch.name}"` });
    return;
  }
  if (patch.name) job.name = patch.name;
  if (patch.prompt) job.prompt = patch.prompt;
  if (patch.dir) job.dir = patch.dir.replace(/^~/, process.env.HOME || "~");
  if (patch.effort) job.effort = patch.effort;
  // --project <id> 指定归属;"-" = 清除(回到按 dir 自动解析)
  if (patch.project !== undefined) {
    if (patch.project && patch.project !== "-") job.project = patch.project;
    else delete job.project;
  }
  if (patch.schedule) {
    job.schedule = patch.schedule;
    if (job.enabled) {
      try { job.nextRun = nextCronTime(patch.schedule).toISOString(); } catch { /* non-critical */ }
    }
  }
  await saveJobs(jobs);
  output({
    ok: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRun: job.nextRun ?? null, lastRun: job.lastRun ?? null },
    message: `定时任务 "${job.name}" 已更新`,
  });
}

export async function cmdCronRemove(nameOrId: string) {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j.name === nameOrId || j.id === nameOrId);
  if (idx < 0) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  const removed = jobs.splice(idx, 1)[0];
  await saveJobs(jobs);
  output({ ok: true, removed: removed.name, message: `定时任务 "${removed.name}" 已删除` });
}

export async function cmdCronToggle(nameOrId: string) {
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
  if (!job) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  job.enabled = !job.enabled;
  if (job.enabled) {
    try { job.nextRun = nextCronTime(job.schedule).toISOString(); } catch { /* non-critical */ }
  } else {
    job.nextRun = undefined;
  }
  await saveJobs(jobs);
  output({
    ok: true,
    name: job.name,
    enabled: job.enabled,
    message: `定时任务 "${job.name}" 已${job.enabled ? "启用" : "暂停"}`,
  });
}

export async function cmdCronHistory(nameOrId?: string) {
  const historyPath = `${process.env.HOME}/.claude-orchestrator/cron-history.json`;
  let history: any[] = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(await readFile(historyPath, "utf-8"));
    } catch { /* non-critical */ }
  }
  if (nameOrId) {
    history = history.filter((h) => h.jobName === nameOrId || h.jobId === nameOrId);
  }
  output({
    ok: true,
    total: history.length,
    records: history.slice(-20).reverse(),
  });
}
