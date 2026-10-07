/** The existing scheduler-autostart CLI transaction owns author assignment; a claimed ensure intent is its authority. */
import type { Database } from "bun:sqlite";
import { updateTask } from "./fix-strategy-task-write.js";
import type { StepInput } from "./ledger-autostart-step.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { readRegistryAgentsSync } from "./registry.js";
import { requireSessionIdentity } from "./scheduler-session-identity.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { rebuildAgentName, rebuildAllowed } from "./scheduler-author-rebuild-proof.js";

export function writeLocalAuthor(db: Database, ctx: WriteCtx, input: StepInput, opts: { registryPath?: string; configPath?: string } = {}) {
  const task = mustTask(db, input.pos[0]), intent = getIntent(db, input.pos[1]);
  const workflow = getWorkflow(db, task.id), config = readSchedulerConfig(opts.configPath);
  const agent = input.flags.agent, row = readRegistryAgentsSync(opts.registryPath).find((r) => r.name === agent);
  const family = input.flags["author-family"];
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "只有调度服务能补建本机执行者");
  if (!intent || intent.eventSeq !== input.claim || intent.taskId !== task.id || intent.action !== "ensure_session"
    || intent.node === "adversarial_review" || intent.status !== "submitted" || intent.recipient !== null
    || intent.taskRev !== task.rev || intent.specRev !== task.specRev || intent.head !== task.headSHA) {
    throw new LedgerError("conflict", "缺本卡当前已认领的作者 ensure_session 意图");
  }
  if (input.sub === "local-author-note") return { ok: true, ...appendEvent(db, ctx, {
    project: task.project, target: task.id, kind: "note", text: input.flags.text,
  }) };
  if (!config.enabled || !config.autoDispatch || !config.projects[task.project] || getMeta(db, task.project).queueFrozen.frozen
    || !workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || (task.agent || undefined) !== input.flags.replaces
    || (input.flags.replaces !== undefined && rebuildAllowed(db, task, input.flags.replaces, String(family)) !== null) // AREB1: formal retire, same family
    || (task.assigneeKind && task.assigneeKind !== "agent") || !["spec", "build", "fix"].includes(task.stage)
    || task.rev !== Number(input.flags.rev) || String(task.extra.placement ?? "").startsWith("peer:")) {
    throw new LedgerError("conflict", "卡或自动调度配置已改变，不再补建本机执行者");
  }
  const expectedName = rebuildAgentName(task.id, input.flags.replaces);
  if ((family !== "claude" && family !== "codex") || !row?.sessionId || row.name !== expectedName || row.projectId !== task.project
    || (row.runtime === "codex" ? "codex" : "claude") !== family) {
    throw new LedgerError("invalid", "执行者会话、项目或本机运行时不符");
  }
  requireSessionIdentity(db, task, { taskId: task.id, role: "author", intentId: intent.id, agent: row.name,
    sessionId: row.sessionId, family, transport: row.transport === "acp" ? "acp" : "tmux", registryPath: opts.registryPath }, row.name);
  const rev = updateTask(db, ctx, task, { agent: row.name, assigneeKind: "agent", assignee: row.name });
  db.query("UPDATE task_workflows SET authorFamily = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ?")
    .run(family, ctx.now ?? Date.now(), task.id);
  appendEvent(db, ctx, { project: task.project, target: task.id, kind: "note", text: `本机执行者 ${row.name}（${family}）已就绪`,
    data: { op: "local_author", intentId: intent.id, agent: row.name, family, previousFamily: workflow.authorFamily, rev } });
  return { ok: true, task: mustTask(db, task.id) };
}
