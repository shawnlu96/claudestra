/**
 * 团队任务的步骤线（team-parity P1-B）：执行镜像的 steps[]（sourceStepId = `${step}:${round}`，state 原样）→ 本机 stepLine 的形状
 * {steps, active}，任务详情（collab-step-line-model.ts）和子 DAG 节点（dag/dag-steps.ts）都吃这一份。纯函数，不碰网络。
 * active 和主场 stepAtStage（src/lib/ledger-steps.ts）同一口径：review 阶段取初审 / 终审里轮次大的（同一轮终审优先），
 * 其余按阶段对应的步骤顺序取第一个有行的；blocked 不知道 stageBefore，没有当前步。
 * 中心不出境每一步的执行者 / head 区间 / 结论 / 模型：executor 一律 UNKNOWN_EXECUTOR（不知道是谁，不是没派），其余不填，
 * 视图就不会画出交付区间、审查结论。认不出的 sourceStepId 丢掉；一行都没有 = null（视图不画步骤线）。
 */
import type { TaskProjection } from "@/lib/api/shared-ledger";
import type { Stage } from "./collab-model";

const STEP_NAMES: ReadonlySet<string> = new Set(["restate", "write", "review", "fix", "final_review", "ui_check", "merge", "verify"]);
/** src/lib/ledger-stages.ts 的 STAGE_STEPS（web 不 import src，照抄同一张表） */
const STAGE_STEPS: Partial<Record<Stage, readonly string[]>> = {
  spec: ["restate", "write"], restate: ["restate", "write"], build: ["write"], fix: ["fix", "write"],
  review: ["final_review", "review"], merge: ["merge"], live: ["verify"],
};
/** 这一步是谁：中心没有，显示成「—」 */
export const UNKNOWN_EXECUTOR = "—";

export interface TeamStepRow { step: string; round: number; state: string; executor: string; executorKind: "agent" }
export interface TeamStepLine { steps: TeamStepRow[]; active: { step: string; round: number } | null }

/** `write:2` → { step: "write", round: 2 }；不是「已知步骤名:非负整数」的 null */
export function parseStepId(id: string): { step: string; round: number } | null {
  const m = /^([a-z_]+):(\d{1,6})$/.exec(id);
  return m && STEP_NAMES.has(m[1]!) ? { step: m[1]!, round: Number(m[2]) } : null;
}

const latest = (rows: readonly TeamStepRow[], step: string) =>
  rows.filter((r) => r.step === step).reduce<TeamStepRow | null>((a, r) => (!a || r.round > a.round ? r : a), null);

function activeOf(rows: readonly TeamStepRow[], stage: Stage): TeamStepRow | null {
  if (stage === "review") {
    const fin = latest(rows, "final_review"), rev = latest(rows, "review");
    return fin && (!rev || fin.round >= rev.round) ? fin : rev;
  }
  for (const name of STAGE_STEPS[stage] ?? []) {
    const r = latest(rows, name);
    if (r) return r;
  }
  return null;
}

export function teamStepLine(steps: TaskProjection["steps"], stage: Stage): TeamStepLine | null {
  const rows: TeamStepRow[] = [];
  for (const s of steps) {
    const at = parseStepId(s.sourceStepId);
    if (at) rows.push({ ...at, state: s.state, executor: UNKNOWN_EXECUTOR, executorKind: "agent" });
  }
  if (!rows.length) return null;
  const a = activeOf(rows, stage);
  return { steps: rows, active: a ? { step: a.step, round: a.round } : null };
}
