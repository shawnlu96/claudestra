/**
 * 台账的依赖边（docs 10-ledger §3「依赖边」）：边的状态推导、可执行判定、找环、审查分叉。纯函数、无 node / bun 依赖。
 * 状态「手动优先、否则推导」：PM 用 dep-set --state 定死的值存在 task_deps.state，NULL 才按前置任务的阶段推。
 * 审查分叉（通过 → 合并 / 有 P0P1 → 返工）不存成边：它就是阶段机的 review → merge | fix，由 reviewBranches 现算。
 * 口径改动要同步 tests/ledger-deps.test.ts 与 10-ledger.md。
 */
import { TERMINAL_STAGES, type LedgerTask, type ReviewVerdict, type Stage, type TaskKind } from "./ledger-stages.js";

export const DEP_KINDS = ["blocks", "branch"] as const;
export type DepKind = (typeof DEP_KINDS)[number];
export const DEP_STATES = ["waiting", "active", "done"] as const;
export type DepState = (typeof DEP_STATES)[number];
/** 条件是一句人话，按码点数 */
export const DEP_WHEN_MAX = 60;

export interface LedgerDep {
  project: string;
  /** 前置任务 */
  from: string;
  /** 后续任务 */
  to: string;
  kind: DepKind;
  when: string;
  /** PM 手动定的状态；null = 按前置任务阶段推导 */
  state: DepState | null;
  rev: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface DepView extends LedgerDep {
  derived: DepState;
  /** state ?? derived：可执行判定只看它 */
  effective: DepState;
  /** 前置已取消：推导值永远到不了 done，提醒 PM 删边或改指向 */
  fromCancelled: boolean;
}

type DepTask = Pick<LedgerTask, "id" | "kind" | "stage">;

/** code / ops 进了 merge 就算满足（依赖要的是进 main，不是上线）；investigate 不经合并，只认 done */
const SATISFIED: Record<TaskKind, readonly Stage[]> = {
  code: ["merge", "live", "verified", "done"],
  ops: ["merge", "live", "verified", "done"],
  investigate: ["done"],
};

export function isSatisfied(task: Pick<LedgerTask, "kind" | "stage">): boolean {
  return SATISFIED[task.kind]?.includes(task.stage) ?? false;
}

/**
 * blocks：前置满足 → done；前置在 review（条件正在判定）→ active；其余 → waiting。
 * branch：前置满足 → active（到了分叉口，等人判定走哪条）；否则 waiting。branch 的 done 只能由 PM 手动选中。
 */
export function derivedState(kind: DepKind, from: Pick<LedgerTask, "kind" | "stage"> | undefined): DepState {
  if (!from) return "waiting";
  if (kind === "branch") return isSatisfied(from) ? "active" : "waiting";
  if (isSatisfied(from)) return "done";
  return from.stage === "review" ? "active" : "waiting";
}

export function depViews(deps: readonly LedgerDep[], tasks: readonly DepTask[]): DepView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return deps.map((d) => {
    const from = byId.get(d.from);
    const derived = derivedState(d.kind, from);
    return { ...d, derived, effective: d.state ?? derived, fromCancelled: from?.stage === "cancelled" };
  });
}

/**
 * 挡着 taskId 的进边：没到 done 的 blocks 边全算；有 branch 进边而一条都没选中（done）时，那些 branch 边也算。
 * 空数组 = 依赖上不挡（任务本身是否终态由 runnableTasks 判）。
 */
export function blockedBy(taskId: string, views: readonly DepView[]): DepView[] {
  const incoming = views.filter((v) => v.to === taskId);
  const blocks = incoming.filter((v) => v.kind === "blocks" && v.effective !== "done");
  const branches = incoming.filter((v) => v.kind === "branch");
  const branchOpen = branches.length > 0 && !branches.some((v) => v.effective === "done");
  return branchOpen ? [...blocks, ...branches] : blocks;
}

/**
 * 可执行 = 不是终态、依赖上不挡。不按阶段筛：看板折叠要的是「能不能往前走」；
 * 自动派活只派没开工的，调用方再筛 stage === "spec"。
 */
export function runnableTasks<T extends DepTask>(tasks: readonly T[], views: readonly DepView[]): T[] {
  return tasks.filter((t) => !TERMINAL_STAGES.includes(t.stage) && blockedBy(t.id, views).length === 0);
}

/** 沿出边从 start 走到 goal 的一条路径（含两端），走不到为 null。加边 from→to 前查 findPath(to, from)：有路就成环 */
export function findPath(deps: readonly Pick<LedgerDep, "from" | "to">[], start: string, goal: string): string[] | null {
  const out = new Map<string, string[]>();
  for (const d of deps) out.set(d.from, [...(out.get(d.from) ?? []), d.to]);
  const prev = new Map<string, string>([[start, start]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === goal) {
      const path = [cur];
      for (let at = cur; at !== start; at = prev.get(at) as string) path.unshift(prev.get(at) as string);
      return path;
    }
    for (const next of out.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

export interface ReviewBranches {
  /** 通过去哪：investigate 直接 done，其余进 merge */
  pass: Stage;
  /** 有 P0 / P1 去哪 */
  changes: Stage;
  /** 本轮审查已经下了结论就是走的那条；还没审 / 没进过审查为 null */
  taken: "pass" | "changes" | null;
}

/** 审查分叉：由阶段机与本轮 review 事件现算，不存成边（存了会和真实阶段对不上） */
export function reviewBranches(
  task: Pick<LedgerTask, "kind" | "round">,
  lastReview: { round: number | null; verdict: ReviewVerdict | string | null } | null,
): ReviewBranches {
  const pass: Stage = task.kind === "investigate" ? "done" : "merge";
  const current = lastReview && task.round > 0 && lastReview.round === task.round ? lastReview.verdict : null;
  const taken = current === "pass" ? "pass" : current === "changes" || current === "block" ? "changes" : null;
  return { pass, changes: "fix", taken };
}
