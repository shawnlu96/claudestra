/**
 * `ledger step / steps`：步骤化台账（T47，lib/ledger-steps.ts）。派人与权限在 lib/ledger-steps-write.ts（PM / master / owner）；
 * 交付的 head 区间、审查结论与作者判定由 deliver / review 顺手记，不用单独写。
 */
import { EXECUTOR_KINDS, stepsOf, type ExecutorKind } from "../lib/ledger-steps.js";
import { assignStep } from "../lib/ledger-steps-write.js";
import { STEPS, type StepName } from "../lib/ledger-stages.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/**
 * 没给 --kind：local: 开头是人，其余当本机 agent。带 @ 的必须写明——本机 agent 名也可以带 @，猜成本机就绕过了
 * 「合并部署、核对不能派给别的实例」（T47 复核）
 */
function kindOf(c: LedgerCli, executor: string): ExecutorKind {
  const v = c.p.flags.kind;
  if (v === undefined && executor.includes("@")) throw new LedgerError("invalid", "执行者带 @：别的实例写 --kind peer，本机 agent 写 --kind agent");
  if (v === undefined) return executor.startsWith("local:") ? "human" : "agent";
  if (!EXECUTOR_KINDS.includes(v as ExecutorKind)) throw new LedgerError("invalid", `--kind 只能是 ${EXECUTOR_KINDS.join(" / ")}`);
  return v as ExecutorKind;
}

function step(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const name = c.p.pos[2] as StepName;
  const executor = c.p.pos[3] ?? "";
  if (!STEPS.includes(name)) throw new LedgerError("invalid", `步骤只能是 ${STEPS.join(" / ")}`);
  c.requireManager(task.project, "派步骤");
  const r = assignStep(c.db, c.ctx(), { taskId: task.id, step: name, executor, executorKind: kindOf(c, executor), round: intFlag(c.p, "round"), model: c.p.flags.model });
  return { ok: true, steps: r.row, event: r.event, duplicate: r.duplicate };
}

function steps(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  return { ok: true, task: task.id, steps: stepsOf(c.db, task) };
}

export const STEP_CMDS: Record<string, CommandSpec> = {
  step: {
    valued: ["kind", "round", "model", "project"],
    usage: "step <task> <restate|write|review|fix|final_review|ui_check|merge|verify> <执行者> [--kind agent|human|peer] [--round N] [--model M]（派人 / 换人）",
    run: step,
  },
  steps: { valued: ["project"], usage: "steps <task>（每一步谁在做、交付的 head 区间、结论；老卡按 assignee / extra 推）", run: steps },
};
