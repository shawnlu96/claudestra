/**
 * 自动开卡（i28-A1）的 step：runStart（dag-tools-steps.ts）发出的每条台账写，由调度服务改写成 `ledger scheduler-autostart step <claim> <子命令> …`
 * 到这里执行。每步一个事务：先核 claim 还活着、目标（卡号 / feature / 节点）和 claim 一致，再调现成的 lib 写函数。
 * 卡的字段（kind、branch、pm、project、spec、fileGlobs、模板、作者家族、执行者）一律取 claim 与节点，不信适配器传来的值；
 * 建卡之后的写（开 auto、绑节点、回滚取消）还要求卡就是本 claim 建的（ledger-autostart-grant.ts claimOwnsCard）。
 * 授权经 ctx.autostart 交给 lib 的两处钩子（setWorkflow / bindNode），回滚取消卡按 pm 角色走 applyMove。tests/ledger-autostart-claim.test.ts。
 */
import type { Database } from "bun:sqlite";
import { claimOwnsCard, type AutostartClaim } from "./ledger-autostart-grant.js";
import { liveClaim } from "./ledger-autostart.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { bindNode } from "./ledger-dag-write.js";
import { currentViews } from "./scheduler-autostart.js";
import { getFeature } from "./ledger-feature.js";
import { setWorkflow } from "./ledger-scheduler-write.js";
import { LedgerError } from "./ledger-store.js";
import { STAGES, type Stage } from "./ledger-stages.js";
import { replay, tx } from "./ledger-tx.js";
import { applyMove, createTask } from "./ledger-write.js";

const AUTOSTART_FALLBACK = "PM 接管，按手动流程推进（派审 + 合并队列）";

export interface StepInput {
  claim: number;
  sub: string;
  /** 子命令的位置参数：target 与其后（dag-bind 的 key、taskId） */
  pos: string[];
  flags: Record<string, string | undefined>;
}

function deny(why: string): never {
  throw new LedgerError("forbidden", `自动开卡 step 拒绝：${why}`);
}

function owned(db: Database, c: AutostartClaim, taskId: string | undefined) {
  if (taskId !== c.taskId) deny(`目标 ${taskId ?? "（空）"} 不是 claim ${c.seq} 的卡 ${c.taskId}`);
  if (!claimOwnsCard(db, c, c.taskId)) deny(`${c.taskId} 不是 claim ${c.seq} 建的卡`);
  return mustTask(db, c.taskId);
}

const grant = (ctx: WriteCtx, c: AutostartClaim): WriteCtx => ({ ...ctx, autostart: { claim: c.seq, featureId: c.featureId, key: c.key, taskId: c.taskId } });

const int = (v: string | undefined, what: string): number => {
  if (v === undefined || !/^\d+$/.test(v)) throw new LedgerError("invalid", `--${what} 要是非负整数`);
  return Number(v);
};

function taskNew(db: Database, ctx: WriteCtx, c: AutostartClaim, input: StepInput) {
  if (input.pos[0] !== c.taskId) deny(`建的卡号 ${input.pos[0] ?? "（空）"} 不是 claim 的 ${c.taskId}`);
  const node = currentViews(db, getFeature(db, c.featureId) as NonNullable<ReturnType<typeof getFeature>>).find((n) => n.key === c.key);
  if (!node?.fileGlobs?.length) deny(`节点 ${c.key} 不在当前版本或没有文件范围`);
  const r = createTask(db, ctx, {
    id: c.taskId, project: c.project, title: c.title, kind: "code", itemId: c.item ?? undefined, branch: c.branch, spec: `docs/tasks/${c.taskId}.md`, pm: c.pm,
    agent: c.agent, extra: { fileGlobs: node?.fileGlobs ?? [] },
  } as never);
  return { ok: true, task: r.row, duplicate: r.duplicate };
}

/** 执行者在建卡时已按 claim 写进去，这一步只核对、不写 */
function taskSet(db: Database, c: AutostartClaim, input: StepInput) {
  const task = owned(db, c, input.pos[0]);
  if (input.flags.agent !== undefined && input.flags.agent !== c.agent) deny(`执行者只能是 claim 的 ${c.agent}`);
  if (task.agent !== c.agent) deny(`卡上的执行者 ${task.agent ?? "（空）"} 不是 claim 的 ${c.agent}`);
  return { ok: true, task, duplicate: true };
}

function workflow(db: Database, ctx: WriteCtx, c: AutostartClaim, input: StepInput) {
  const task = owned(db, c, input.pos[0]);
  const mode = input.flags.mode;
  if (mode !== "auto" && mode !== "manual") return deny("只能开 auto 或回滚成 manual");
  if (mode === "auto" && (!c.template || !c.version)) deny("规格卡的模板声明不合法，claim 不授予开 auto");
  const cur = db.query("SELECT template, templateVersion FROM task_workflows WHERE taskId = ?").get(task.id) as { template: string; templateVersion: number } | null;
  const r = setWorkflow(db, grant(ctx, c), {
    taskId: task.id, taskRev: int(input.flags.rev, "rev"), workflowRev: int(input.flags["workflow-rev"], "workflow-rev"),
    template: (c.template ?? cur?.template ?? "code") as never, templateVersion: c.version ?? cur?.templateVersion ?? 3,
    mode, authorFamily: "claude", fallback: AUTOSTART_FALLBACK, reason: mode === "manual" ? (input.flags.reason ?? "自动开卡中途失败，回滚") : undefined,
  });
  return { ok: true, ...r };
}

/** 回滚：只取消本 claim 建的卡，按 pm 角色推到 cancelled（runStart 的 task-new undo） */
function cancel(db: Database, ctx: WriteCtx, c: AutostartClaim, input: StepInput) {
  const task = owned(db, c, input.pos[0]);
  if (input.flags.to !== "cancelled") deny("stage 只能推到 cancelled（回滚）");
  const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "stage" }, () => task);
  if (dup) return { ok: true, task: dup.row, duplicate: true };
  const from = input.flags.from as Stage;
  if (!STAGES.includes(from)) throw new LedgerError("invalid", "--from 不是阶段");
  const r = applyMove(db, ctx, task, { from, to: "cancelled" }, true, (input.flags.text ?? "自动开卡中途失败，回滚").slice(0, 600), "pm");
  return { ok: true, task: r.task, duplicate: false };
}

function bind(db: Database, ctx: WriteCtx, c: AutostartClaim, input: StepInput) {
  const [featureId, key, taskId] = input.pos;
  if (featureId !== c.featureId || key !== c.key) deny(`绑的是 ${featureId}/${key}，claim 是 ${c.featureId}/${c.key}`);
  owned(db, c, taskId);
  const r = bindNode(db, grant(ctx, c), { id: c.featureId, rev: int(input.flags.rev, "rev"), key: c.key, taskId: c.taskId });
  return { ok: true, node: r.row, duplicate: r.duplicate };
}

export function autostartStep(db: Database, ctx: WriteCtx, input: StepInput): Record<string, unknown> {
  return tx(db, () => {
    if (ctx.actor !== "scheduler") deny("只有调度服务能跑");
    const c = liveClaim(db, input.claim);
    if (input.sub === "task-new") return taskNew(db, ctx, c, input);
    if (input.sub === "task-set") return taskSet(db, c, input);
    if (input.sub === "workflow-set") return workflow(db, ctx, c, input);
    if (input.sub === "stage") return cancel(db, ctx, c, input);
    if (input.sub === "dag-bind") return bind(db, ctx, c, input);
    return deny(`不代跑 ledger ${input.sub}`);
  });
}
