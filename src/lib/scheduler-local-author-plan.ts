/** Reconstruct local resources of an existing auto card, using start_node's paths and prompt renderer. */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderExecPrompt } from "./dag-tools-prompt.js";
import type { StartPlan } from "./dag-tools-start.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { projectPm } from "./scheduler-autostart.js";
import { currentLocalProjectDirs } from "./scheduler-local-runtime-projects.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";
import { specPathFor } from "./task-spec.js";

// LC1's queue only uses the feature id/key for identity and notices. A standalone card needs no invented DAG row.
export type LocalAuthorPlan = Omit<StartPlan, "feature"> & { feature: { id: string } };

export async function localAuthorPlan(db: Database, task: LedgerTask, worktreeRoot: string, opts: LocalStartOptions, name?: string): Promise<LocalAuthorPlan | string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(task.id)) return "卡号不能安全映射到 start_node 的本机目录";
  const binding = db.query("SELECT featureId, nodeKey FROM dag_bindings WHERE taskId = ? LIMIT 1").get(task.id) as { featureId: string; nodeKey: string } | null;
  const workflow = getWorkflow(db, task.id);
  if (!workflow) return "卡上没有自动流程";
  const config = readSchedulerConfig(opts.configPath), policy = config.projects[task.project];
  if (!config.enabled || !config.autoDispatch || !policy) return "项目没有开启自动派单";
  const dirs = await currentLocalProjectDirs(task.project, opts.projectsPath);
  const repo = dirs.find((d) => d === policy.repoDir && existsSync(join(d, ".git"))) ?? dirs.find((d) => existsSync(join(d, ".git")));
  if (!repo) return "当前项目没有可用 git 仓库";
  const located = specPathFor(task, getMeta(db, task.project).docsDir);
  if (!task.branch || !located) return "卡上缺分支或可读规格卡";
  const specPath = resolve(located);
  const agentName = name?.slice("agent-".length) ?? `task-${task.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48); // name: AREB1 rebuildAgentName
  const worktree = join(worktreeRoot, task.id.toLowerCase()), ledgerDir = statePath("ledger");
  const promptPath = join(ledgerDir, "reviews", `${task.id}-exec-prompt.md`), templatePath = statePath("ledger", "prompts", "exec-template.md");
  const base = task.headSHA ?? "origin/main", pm = task.pm ?? projectPm(db, task.project) ?? "scheduler";
  const promptText = renderExecPrompt({ task: task.id, title: task.title, pm, branch: task.branch,
    base, worktree, spec: specPath, ledgerDir, template: workflow.template }, existsSync(templatePath) ? readFileSync(templatePath, "utf8") : undefined);
  return { feature: { id: binding?.featureId ?? `task:${task.id}` }, key: binding?.nodeKey ?? task.id,
    taskId: task.id, title: task.title, project: task.project, item: task.itemId,
    pm, base, branch: task.branch, repo, worktree, agentName, agent: `agent-${agentName}`,
    fileGlobs: Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs as string[] : [], specRel: `docs/tasks/${task.id}.md`,
    specPath, specText: null, promptPath, promptText, purpose: `${task.id} 执行者（自动卡）：${task.title}。先读 ${promptPath}`,
    workflow: { template: workflow.template, version: workflow.templateVersion }, peer: null };
}
