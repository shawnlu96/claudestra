/**
 * 内置台账的阶段机（docs 10-ledger §3）：阶段、三种任务 kind 的合法跳转、谁能推、推阶段带来的 round / specRev / stageBefore 变化。
 * 纯函数、无 node / bun 依赖：写入层（ledger-write.ts）与指标（ledger-metrics.ts）都从这里取类型和规则，
 * 阶段规则只此一份——改跳转表必须同步 tests/ledger-stages.test.ts 的全表用例。
 */

export const STAGES = ["spec", "restate", "build", "review", "fix", "merge", "live", "verified", "done", "blocked", "cancelled"] as const;
export type Stage = (typeof STAGES)[number];

export const TASK_KINDS = ["code", "investigate", "ops"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const ROLES = ["executor", "pm", "master", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const ITEM_STATUSES = ["todo", "decide", "design", "doing", "done", "dropped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * stage / item / task / meta / dep 由写入函数自动产生；ask / ask_expire / ask_cancel（与作答的 decision）只由 bridge 的 ledger-asks.ts 写；
 * assign_reopen 只由 ledger-human.ts 写（PM 重开指给人的 ask）；其余由调用方显式追加
 */
const EVENT_KINDS = [
  "stage", "item", "task", "meta", "dep", "note", "deliver", "review", "decision", "deploy", "verify", "rollback", "freeze", "unfreeze",
  "ask", "ask_expire", "ask_cancel", "assign_reopen",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * 「待你处理」这一族事件（ledger-asks.ts 写）：开出 / 过期 / 撤销、重开指派，以及作答写下的 decision（data 带 askId）。
 * 它们不算任务的「最近一条」、也不进项目级事件列表——否则一条 ask 就能盖掉「线上验证失败」这类问题态（协作视图靠它）。
 */
export function isAskEvent(e: { kind: string; data: Record<string, unknown> }): boolean {
  if (e.kind === "ask" || e.kind === "ask_expire" || e.kind === "ask_cancel" || e.kind === "assign_reopen") return true;
  return e.kind === "decision" && typeof e.data.askId === "string";
}

export type ReviewVerdict = "pass" | "changes" | "block";

/**
 * 负责人类型：本机 agent（agent 列同值，执行者角色照旧按 agent 认）/ 人（local:<principalId>）/ 别的实例上的 agent（<fp>/<agent>）。
 * 路由必须按 kind 分支，不能只解析 assignee 字符串：本机 agent 名允许 @，`agent-x@peer` 是本机名，不是跨实例地址。
 */
export const ASSIGNEE_KINDS = ["agent", "human", "peer_agent"] as const;
export type AssigneeKind = (typeof ASSIGNEE_KINDS)[number];

export interface LedgerItem {
  project: string;
  id: string;
  title: string;
  ownerWords: string;
  priority: string;
  status: ItemStatus;
  oneLine: string;
  next: string;
  rev: number;
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerTask {
  id: string;
  project: string;
  itemId: string | null;
  title: string;
  kind: TaskKind;
  stage: Stage;
  stageBefore: Stage | null;
  round: number;
  agent: string | null;
  assigneeKind: AssigneeKind | null;
  assignee: string | null;
  pm: string | null;
  branch: string | null;
  pr: string | null;
  headSHA: string | null;
  spec: string | null;
  specRev: number;
  model: string | null;
  rev: number;
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerEvent {
  seq: number;
  ts: number;
  actor: string;
  project: string;
  /** 任务 id / 事项 id / "" = 项目级 */
  target: string;
  kind: EventKind;
  text: string;
  data: Record<string, unknown>;
  dedupKey: string | null;
}

export const TERMINAL_STAGES: readonly Stage[] = ["done", "cancelled"];

const REVIEW_LOOP: Partial<Record<Stage, Stage[]>> = {
  build: ["review"],
  fix: ["review"],
};
const SHIP_TAIL: Partial<Record<Stage, Stage[]>> = {
  review: ["fix", "merge", "spec"],
  merge: ["live", "review", "fix"],
  live: ["verified", "fix"],
  verified: ["done"],
};

/**
 * 主线 + 回退（blocked / cancelled 不在表里，由 canTransition 单独处理）。
 * 回退：restate→spec、review→spec（改规格，specRev+1）；merge→review / fix（rebase 改了实现、CI 红）；live→fix（回滚后）。
 */
const TRANSITIONS: Record<TaskKind, Partial<Record<Stage, Stage[]>>> = {
  code: { spec: ["restate"], restate: ["build", "spec"], ...REVIEW_LOOP, ...SHIP_TAIL },
  investigate: { spec: ["restate"], restate: ["build", "spec"], ...REVIEW_LOOP, review: ["fix", "done", "spec"] },
  ops: { spec: ["build"], ...REVIEW_LOOP, ...SHIP_TAIL },
};

/** 执行者只能推自己任务的这几步：开始复述、交付请求复核；其余一律 PM / master / owner */
const EXECUTOR_MOVES: readonly (readonly [Stage, Stage])[] = [
  ["spec", "restate"],
  ["build", "review"],
  ["fix", "review"],
];

/** 这种 kind 的任务会不会停在这个阶段（跳转表里有出边的阶段 + 终态）；blocked 不算，它缺 stageBefore 就回不去 */
export function isStageOfKind(kind: TaskKind, stage: Stage): boolean {
  // 用 hasOwn 不用 in：in 会把 toString 这类原型键也当成阶段
  return Object.hasOwn(TRANSITIONS[kind] ?? {}, stage) || TERMINAL_STAGES.includes(stage);
}

export type TransitionTask = Pick<LedgerTask, "kind" | "stage" | "stageBefore">;
export type TransitionCheck = { ok: true } | { ok: false; code: "illegal" | "forbidden" | "terminal"; reason: string };

function legality(task: TransitionTask, to: Stage): TransitionCheck {
  const { stage } = task;
  if (TERMINAL_STAGES.includes(stage)) return { ok: false, code: "terminal", reason: `任务已是终态 ${stage}，不能再推` };
  if (!STAGES.includes(to)) return { ok: false, code: "illegal", reason: `未知阶段 ${to}` };
  if (to === stage) return { ok: false, code: "illegal", reason: `任务已在 ${stage}` };
  if (to === "cancelled") return { ok: true };
  if (to === "blocked") return { ok: true };
  if (stage === "blocked") {
    return to === task.stageBefore
      ? { ok: true }
      : { ok: false, code: "illegal", reason: `blocked 只能回原阶段 ${task.stageBefore ?? "(未记录)"}，不能去 ${to}` };
  }
  const next = TRANSITIONS[task.kind]?.[stage] ?? [];
  return next.includes(to) ? { ok: true } : { ok: false, code: "illegal", reason: `${task.kind} 任务不能从 ${stage} 推到 ${to}` };
}

/** 先判合法，再判角色；非法跳转无论谁推都报 illegal */
export function canTransition(task: TransitionTask, to: Stage, role: Role): TransitionCheck {
  const legal = legality(task, to);
  if (!legal.ok) return legal;
  if (role !== "executor") return { ok: true };
  const allowed = EXECUTOR_MOVES.some(([from, dest]) => from === task.stage && dest === to);
  return allowed ? { ok: true } : { ok: false, code: "forbidden", reason: `执行者只能推 spec→restate、build/fix→review，${task.stage}→${to} 要 PM 推` };
}

export type TaskStageState = Pick<LedgerTask, "kind" | "stage" | "stageBefore" | "round" | "specRev">;

/**
 * 推阶段的副作用集中在这里（调用方已用 canTransition 判过合法）：
 * 进 review 时 round+1（从 blocked 回来不加，review→spec 之后不清零）；回退到 spec 时 specRev+1；进 blocked 记 stageBefore，出来清空。
 */
export function nextTaskState(task: TaskStageState, to: Stage): Pick<LedgerTask, "stage" | "stageBefore" | "round" | "specRev"> {
  const fromBlocked = task.stage === "blocked";
  return {
    stage: to,
    stageBefore: to === "blocked" ? task.stage : null,
    round: to === "review" && !fromBlocked ? task.round + 1 : task.round,
    specRev: to === "spec" && !fromBlocked ? task.specRev + 1 : task.specRev,
  };
}

/**
 * actor 在这个任务上的角色。PM 只认项目 PM 名单（只有 owner 能设）——task.pm 是展示字段，算进来就能 setTask 自封 PM。
 * 名单优先于执行者（ops 任务 PM 自做时 agent 是 PM 自己）。"master" / "owner" 按名字认，身份推导（T8b）必须保留这两个名字。
 */
export function roleOf(actor: string, task: Pick<LedgerTask, "agent">, pms: readonly string[]): Role | null {
  if (actor === "master" || actor === "owner") return actor;
  if (pms.includes(actor)) return "pm";
  if (task.agent === actor) return "executor";
  return null;
}

/** 指标终点：按顺序取第一个出现的（code / ops 以 verified 为准，没经过 verified 才看 done）；cancelled 也算结束 */
export function endStages(kind: TaskKind): Stage[] {
  return kind === "investigate" ? ["done", "cancelled"] : ["verified", "done", "cancelled"];
}
