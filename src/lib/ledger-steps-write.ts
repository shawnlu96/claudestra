/**
 * 步骤化台账的写入（T47）：PM 给某一步派人（assignStep）、接方 owner 同意后记一笔接受（recordAccept），
 * 以及挂在已有写入里的两个钩子：交付推进 review 时给那一步记 head 区间（noteStepDelivered），记审查结论前按步骤查硬规则 1、
 * 写结论和本机校验结果（checkReviewStep / noteStepReview）。老卡（没有步骤行）钩子一律不动，行为和以前一样。
 * 事务由调用方（ledger-write.ts 的导出函数）开；本文件的导出函数自己开事务。tests/ledger-steps.test.ts。
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import { STEPS, type LedgerTask, type ReviewVerdict, type Stage, type StepName } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { activeOf, authorOf, currentStep, EXECUTOR_KINDS, listSteps, reviewerCheck, stepAtStage, stepPeer, stepsOf, type ExecutorKind, type TaskStep } from "./ledger-steps.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

/** 硬规则 3：合并、部署、核对只由仓库所在实例的 PM 做——这几步不能派给别的实例 */
const LOCAL_ONLY: readonly StepName[] = ["merge", "verify"];
const EXECUTOR_RE = /^[\p{L}\p{N}_.:@/-]{1,200}$/u;
const MODEL_RE = /^[\w .:/-]{1,64}$/;

export interface AssignStepInput { taskId: string; step: StepName; executor: string; executorKind: ExecutorKind; round?: number; model?: string }

/** 派人（或换人）：同一步同一轮换人 = 覆盖那一行、状态回到 assigned；只有 PM / master / owner 能派 */
export function assignStep(db: Database, ctx: WriteCtx, input: AssignStepInput): WriteResult<TaskStep[]> {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "step" }, () => listSteps(db, task.id));
    if (dup) return dup;
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `派步骤要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (!STEPS.includes(input.step)) throw new LedgerError("invalid", `步骤只能是 ${STEPS.join(" / ")}`);
    if (!EXECUTOR_KINDS.includes(input.executorKind)) throw new LedgerError("invalid", `执行者类型只能是 ${EXECUTOR_KINDS.join(" / ")}`);
    if (!EXECUTOR_RE.test(input.executor)) throw new LedgerError("invalid", "执行者名字不合法");
    if (input.executorKind === "peer" && !stepPeer(input)) throw new LedgerError("invalid", "别的实例上的执行者写成 <agent>@<peer>");
    if (input.executorKind === "human" && !input.executor.startsWith("local:")) throw new LedgerError("invalid", "人写成 local:<principal>");
    if (input.executorKind === "peer" && LOCAL_ONLY.includes(input.step)) throw new LedgerError("forbidden", "合并部署、核对只由仓库所在实例的 PM 做，不能派给别的实例");
    if (input.model !== undefined && !MODEL_RE.test(input.model)) throw new LedgerError("invalid", "model 不合法");
    const round = input.round ?? task.round;
    if (!Number.isInteger(round) || round < 0 || round > 999) throw new LedgerError("invalid", "round 要是 0–999 的整数");
    const now = ctx.now ?? Date.now();
    const claims = JSON.stringify(input.model ? { model: input.model } : {});
    db.prepare(
      `INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, claims, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?)
       ON CONFLICT (taskId, step, round) DO UPDATE SET executor = excluded.executor, executorKind = excluded.executorKind, state = 'assigned',
       headFrom = NULL, headTo = NULL, verdict = NULL, verified = '{}', claims = excluded.claims, rev = rev + 1, updatedAt = excluded.updatedAt`,
    ).run(task.id, input.step, round, input.executor, input.executorKind, claims, now, now);
    const data = { op: "assign", step: input.step, round, executor: input.executor, executorKind: input.executorKind, ...(input.model ? { model: input.model } : {}) };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "step", data }, true);
    return { row: listSteps(db, task.id), event, duplicate: false };
  });
}

/**
 * 接方 owner 同意接这张卡（peer 经 peer-ledger accept 写）：之后同一张卡派给同一个 peer 的步骤单不再先问接方 owner——
 * 那一侧靠接方本机的「已接受」记录判（lib/peer-accepted.ts）；这里只留痕（带时间），同一个 peer 重复接受算同一笔
 */
export function recordAccept(db: Database, ctx: WriteCtx, input: { taskId: string; peer: string }): WriteResult<LedgerTask> {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const c = { ...ctx, dedupKey: ctx.dedupKey ?? `peer:${input.peer}:accept:${task.id}` };
    const dup = replay(db, c, { project: task.project, target: task.id, kind: "accept" }, () => task);
    if (dup) return dup;
    const event = insertEvent(db, c, { project: task.project, target: task.id, kind: "accept", data: { peer: input.peer, at: c.now ?? Date.now() } }, true);
    return { row: task, event, duplicate: false };
  });
}

/** 交付推进 review（build / fix → review）时：那一步记下交付的 head 区间（上一次交付的 head → 这次的）。库里没有那一步的行就不动 */
export function noteStepDelivered(db: Database, ctx: WriteCtx, task: LedgerTask, to: Stage): void {
  if (to !== "review" || (task.stage !== "build" && task.stage !== "fix")) return;
  const steps = stepsOf(db, task);
  const s = stepAtStage(steps, task);
  if (!s || s.derived) return;
  const prev = steps.filter((x) => !x.derived && x !== s && (x.step === "write" || x.step === "fix") && x.headTo).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const now = ctx.now ?? Date.now();
  db.prepare("UPDATE task_steps SET state = 'delivered', headFrom = ?, headTo = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ? AND step = ? AND round = ?")
    .run(prev?.headTo ?? null, task.headSHA, now, task.id, s.step, s.round);
  const data = { op: "deliver", step: s.step, round: s.round, headFrom: prev?.headTo ?? null, headTo: task.headSHA };
  insertEvent(db, ctx, { project: task.project, target: task.id, kind: "step", data }, false);
}

/** 对方自报的（模型…）并进当前在干活的那一步（库里有那一行时）：跨实例只能凭声明，和本机校验分开放 */
export function setStepClaims(db: Database, task: LedgerTask, claims: { model: string }): void {
  const s = stepAtStage(stepsOf(db, task), task);
  if (!s || s.derived || !MODEL_RE.test(claims.model)) return;
  db.prepare("UPDATE task_steps SET claims = ? WHERE taskId = ? AND step = ? AND round = ?").run(JSON.stringify({ ...s.claims, ...claims }), task.id, s.step, s.round);
}

/** 审查人是现在哪一步审查（final_review 优先）：本机 agent 按名字，peer（peer:<名>）按实例 */
function reviewStepOf(steps: TaskStep[], reviewer: string): TaskStep | null {
  const peer = reviewer.startsWith("peer:") ? reviewer.slice(5) : null;
  for (const name of ["final_review", "review"] as const) {
    const s = currentStep(steps, name);
    if (s && (peer ? stepPeer(s) === peer : s.executorKind !== "peer" && s.executor === reviewer)) return s;
  }
  return null;
}

/** explicit = 这张卡派过步骤（库里有行）：只有这种卡才在审查结论里带作者判定，老卡的结论和以前一样 */
export interface ReviewStepCheck { explicit: boolean; step: TaskStep | null; author: string | null; authorCheck: boolean | null; why?: string }

/**
 * 记审查结论之前：按步骤查硬规则 1（审的人不能是写的人），查得出且相同就拒；查不出放行、结论里标出来。
 * reviewer = 结论上写的审查人（本机多由 PM 代写，不是 actor）；peer 写的是 peer:<名>
 */
export function checkReviewStep(db: Database, task: LedgerTask, reviewer: string): ReviewStepCheck {
  const steps = stepsOf(db, task);
  const step = reviewStepOf(steps, reviewer);
  const who = step ?? { executor: reviewer, executorKind: (reviewer.startsWith("peer:") ? "peer" : "agent") as ExecutorKind };
  const r = reviewerCheck(authorOf(steps, task.headSHA), who);
  if (r.ok === false) throw new LedgerError("forbidden", `审的人不能是写的人：${r.author} 交付了 ${task.headSHA}，不能审它`);
  return { explicit: steps.some((s) => !s.derived), step, author: r.author, authorCheck: r.ok, ...(r.why ? { why: r.why } : {}) };
}

/** 结论写进那一步（库里有那一行时）：verdict、本机校验（verified），对方自报的模型进 claims */
export function noteStepReview(db: Database, ctx: WriteCtx, c: ReviewStepCheck, verdict: ReviewVerdict, model?: string): void {
  const s = c.step;
  if (!s || s.derived) return;
  const verified = { author: c.author, reviewerNotAuthor: c.authorCheck, ...(c.why ? { why: c.why } : {}) };
  const claims = model && MODEL_RE.test(model) ? { ...s.claims, model } : s.claims;
  db.prepare("UPDATE task_steps SET state = 'done', verdict = ?, verified = ?, claims = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ? AND step = ? AND round = ?")
    .run(verdict, JSON.stringify(verified), JSON.stringify(claims), ctx.now ?? Date.now(), s.taskId, s.step, s.round);
}

/**
 * roleOf 用的当前那一步（applyMove）：老卡按 extra.delegate / 负责人推出来，和以前按整卡判一致。
 * review 阶段能动卡（进出 blocked）的还是交付的那一方：审查方只写结论、不推阶段
 */
export function activeStepFor(db: Database, task: LedgerTask) {
  const stage = task.stage === "blocked" ? task.stageBefore : task.stage;
  return activeOf(stepAtStage(stepsOf(db, task), stage === "review" ? { stage: "fix", stageBefore: null } : task));
}
