/**
 * 步骤化台账（T47，docs/team/collab-model.md §1 §3）：一张卡按步骤记执行者和结果——谁接了哪一步、交付的 head 区间、审查结论、
 * 本机真校验过的（verified）与对方自报的（claims）。表 task_steps 由 PM 派步骤时写（ledger-steps-write.ts），交付 / 审查时顺手更新。
 * 老卡没有步骤行：按 assignee / extra.delegate / extra.reviewer 推出只读视图（derived），权限判定与以前逐条一致；
 * 某一步显式派过人就以派的为准。作者 = 写 / 修那一步的执行者 + 它交付的 head；硬规则 1 只在作者查得出时强制。
 * tests/ledger-steps.test.ts。
 */
import type { Database } from "bun:sqlite";
import { delegatePeerOf, STAGE_STEPS, type ActiveStep, type LedgerTask, type ReviewVerdict, type Stage, type StepName } from "./ledger-stages.js";

export const EXECUTOR_KINDS = ["agent", "human", "peer"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
const STEP_STATES = ["assigned", "delivered", "done"] as const;
type StepState = (typeof STEP_STATES)[number];

export interface TaskStep {
  taskId: string;
  step: StepName;
  /** 同一步第几次派人（修 / 审会一轮轮来）；最大的那一行是现在这一步 */
  round: number;
  /** 本机 agent 名 / local:<principal> / <agent>@<peer> */
  executor: string;
  executorKind: ExecutorKind;
  state: StepState;
  headFrom: string | null;
  headTo: string | null;
  verdict: ReviewVerdict | null;
  /** 本机算出来的（作者是谁、审查人不是作者） */
  verified: Record<string, unknown>;
  /** 对方自报的（用的什么模型…）：跨实例只认证到实例这一层，这些只能凭声明 */
  claims: Record<string, unknown>;
  /** 老卡按 assignee / extra 推出来的，库里没有这一行 */
  derived?: true;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** 迁移（ledger-store.ts LEDGER_MIGRATIONS 末尾）：可重跑 */
export const STEPS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS task_steps (
  taskId TEXT NOT NULL REFERENCES tasks(id),
  step TEXT NOT NULL CHECK (step IN ('restate','write','review','fix','final_review','ui_check','merge','verify')),
  round INTEGER NOT NULL DEFAULT 0,
  executor TEXT NOT NULL, executorKind TEXT NOT NULL CHECK (executorKind IN ('agent','human','peer')),
  state TEXT NOT NULL CHECK (state IN ('assigned','delivered','done')),
  headFrom TEXT, headTo TEXT, verdict TEXT CHECK (verdict IN ('pass','changes','block')),
  verified TEXT NOT NULL DEFAULT '{}', claims TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY (taskId, step, round))`,
  "CREATE INDEX IF NOT EXISTS task_steps_executor ON task_steps(executor)",
];

const json = (v: unknown): Record<string, unknown> => {
  try {
    const o = JSON.parse(String(v ?? "{}"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {}; // 库里的 JSON 列只由本模块写；坏了按空对象读，不让一行坏数据挡住整张卡
  }
};

function toStep(r: Record<string, unknown>): TaskStep {
  return {
    taskId: String(r.taskId), step: r.step as StepName, round: Number(r.round), executor: String(r.executor), executorKind: r.executorKind as ExecutorKind,
    state: r.state as StepState, headFrom: (r.headFrom as string | null) ?? null, headTo: (r.headTo as string | null) ?? null,
    verdict: (r.verdict as ReviewVerdict | null) ?? null, verified: json(r.verified), claims: json(r.claims),
    rev: Number(r.rev), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
  };
}

/**
 * 表在不在：bridge 的只读 Reader 不跑迁移，线上库还是 v5 时没有 task_steps——当成「没有步骤行」，老卡照推出来的读。
 * 不能报错：任务存在报 500、不存在报 404，peer 就能拿它探测任务号（T47 复核 P1-4）
 */
const hasStepsTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_steps'").get();

/** 库里的步骤行（按步骤、轮次排） */
export function listSteps(db: Database, taskId: string): TaskStep[] {
  if (!hasStepsTable(db)) return [];
  return (db.query("SELECT * FROM task_steps WHERE taskId = ? ORDER BY step, round").all(taskId) as Record<string, unknown>[]).map(toStep);
}

/** 全部任务的步骤行（peer 列自己的卡用，一次读完） */
export function stepsByTask(db: Database): Map<string, TaskStep[]> {
  const out = new Map<string, TaskStep[]>();
  if (!hasStepsTable(db)) return out;
  for (const r of db.query("SELECT * FROM task_steps ORDER BY taskId, step, round").all() as Record<string, unknown>[]) {
    const s = toStep(r);
    out.set(s.taskId, [...(out.get(s.taskId) ?? []), s]);
  }
  return out;
}

/** <agent>@<peer> 的 peer 名（最后一个 @ 之后）；本机 agent 名可以带 @，所以只看 executorKind */
export const stepPeer = (s: Pick<TaskStep, "executor" | "executorKind">): string | null => {
  if (s.executorKind !== "peer") return null;
  const at = s.executor.lastIndexOf("@");
  return at > 0 ? s.executor.slice(at + 1).trim() || null : null;
};

type TaskFields = Pick<LedgerTask, "id" | "agent" | "assignee" | "assigneeKind" | "round" | "createdAt" | "updatedAt"> & { extra?: Record<string, unknown> };

/** 老卡的只读视图：写 / 复述 / 修 = extra.delegate（跨实例）或负责人；审 = extra.reviewer。和以前按整卡判权限逐条一致 */
export function derivedSteps(task: TaskFields): TaskStep[] {
  const base = { taskId: task.id, round: 0, state: "assigned" as const, headFrom: null, headTo: null, verdict: null, verified: {}, claims: {}, derived: true as const };
  const at = { rev: 0, createdAt: task.createdAt, updatedAt: task.updatedAt };
  const del = typeof task.extra?.delegate === "string" && delegatePeerOf(task, "delegate") ? task.extra.delegate : null;
  const doer = del ? { executor: del, executorKind: "peer" as const }
    : task.agent ? { executor: task.agent, executorKind: "agent" as const }
    : task.assignee ? { executor: task.assignee, executorKind: task.assigneeKind === "human" ? ("human" as const) : ("agent" as const) } : null;
  const rv = typeof task.extra?.reviewer === "string" && task.extra.reviewer ? task.extra.reviewer : null;
  const reviewer = rv ? { executor: rv, executorKind: delegatePeerOf(task, "reviewer") ? ("peer" as const) : ("agent" as const) } : null;
  return [
    ...(doer ? (["restate", "write", "fix"] as const).map((step) => ({ ...base, ...at, ...doer, step })) : []),
    ...(reviewer ? [{ ...base, ...at, ...reviewer, step: "review" as const }] : []),
  ];
}

/**
 * 推出来的步骤只补「显式派的那条退路上也没人」的：复述 / 修没派人时本来就退到写的那一步（STAGE_STEPS），显式派了写，
 * 就不能再用推出来的复述 / 修把它盖掉；审查同理，显式派了初审或终审就不补（T47 复核）
 */
const COVERED_BY: Partial<Record<StepName, readonly StepName[]>> = { restate: ["write"], fix: ["write"], review: ["final_review"] };

/** 库里有的步骤以库里为准；没派过人的步骤用推出来的补上（混合卡：只显式派了审查，写的人还是整卡负责人） */
export function withDerived(task: TaskFields, rows: TaskStep[]): TaskStep[] {
  const have = new Set(rows.map((s) => s.step));
  return [...rows, ...derivedSteps(task).filter((s) => !have.has(s.step) && !(COVERED_BY[s.step] ?? []).some((c) => have.has(c)))];
}

export const stepsOf = (db: Database, task: TaskFields): TaskStep[] => withDerived(task, listSteps(db, task.id));

/** 某一步现在是谁：同一步取轮次最大的那一行 */
function currentStep(steps: TaskStep[], step: StepName): TaskStep | null {
  return steps.filter((s) => s.step === step).reduce<TaskStep | null>((a, s) => (!a || s.round > a.round ? s : a), null);
}

/** 这一轮的审查那一步：初审、终审里轮次大的那一行（同一轮终审优先）——派过终审之后又派了新一轮初审，就是新一轮的初审 */
export function currentReview(steps: TaskStep[]): TaskStep | null {
  const fin = currentStep(steps, "final_review"), rev = currentStep(steps, "review");
  return fin && (!rev || fin.round >= rev.round) ? fin : rev;
}

/** 这个阶段在干活的那一步（STAGE_STEPS 按顺序取第一个有人的；review 阶段按轮次取，见 currentReview）；blocked 看 stageBefore */
export function stepAtStage(steps: TaskStep[], task: Pick<LedgerTask, "stage" | "stageBefore">): TaskStep | null {
  const stage: Stage | null = task.stage === "blocked" ? task.stageBefore : task.stage;
  if (stage === "review") return currentReview(steps);
  for (const name of (stage && STAGE_STEPS[stage]) || []) {
    const s = currentStep(steps, name);
    if (s) return s;
  }
  return null;
}

/** roleOf 用：当前阶段那一步派给了哪个实例 / 哪个本机 agent */
export function activeOf(s: TaskStep | null): ActiveStep {
  return { peer: s ? stepPeer(s) : null, agent: s?.executorKind === "agent" ? s.executor : null };
}

/**
 * 作者：真正改出这个 head 的写 / 修那一步（交付区间 headFrom → headTo 且两者不同；只认库里的行，推出来的没有 head）。
 * 「修」没交新提交（区间是空的）不算改过——不然换个人空交一次，原来写代码的人就能审自己的改动（T47 复核 P1-3）。查不出 null
 */
export function authorOf(steps: TaskStep[], head: string | null): TaskStep | null {
  if (!head) return null;
  const hit = steps.filter((s) => !s.derived && (s.step === "write" || s.step === "fix") && s.headTo === head && s.headFrom !== head);
  return hit.reduce<TaskStep | null>((a, s) => (!a || s.updatedAt > a.updatedAt ? s : a), null);
}

/**
 * 硬规则 1：审的人不能是写的人。ok=false 拒写；ok=null 查不出（作者未知，或两边是同一个 peer 实例——跨实例只认证到实例，凭声明）
 */
export function reviewerCheck(author: TaskStep | null, reviewer: Pick<TaskStep, "executor" | "executorKind">): { author: string | null; ok: boolean | null; why?: string } {
  if (!author) return { author: null, ok: null, why: "作者未知" };
  if (author.executor === reviewer.executor) return { author: author.executor, ok: false, why: "审的人就是写的人" };
  const ap = stepPeer(author), rp = stepPeer(reviewer);
  if (ap && rp && ap === rp) return { author: author.executor, ok: null, why: "同一个实例，只能凭对方声明" };
  return { author: author.executor, ok: true };
}
