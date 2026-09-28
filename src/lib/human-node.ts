/**
 * human 节点（台账任务分给本机的人）的纯规则：什么时候给这个人开一条 assigned ask、幂等键、第几次 attempt、
 * 谁的作答能按 v3.2 例外写交付、给 PM 的固定模板。事务写入在 lib/ledger-human.ts，bridge 的监听在 bridge/human-node.ts。
 * 人写的说明从不进任何 agent 的上下文：PM 收到的只有任务号和结果（docs 10-ledger「附：v3.2 例外」）。
 */

/** 这里只用得到的几列；和台账的任务行结构兼容 */
export interface HumanTaskView {
  id: string;
  project: string;
  title: string;
  stage: string;
  round: number;
  assigneeKind: string | null;
  assignee: string | null;
  pm: string | null;
  extra: Record<string, unknown>;
}

export type HumanResult = "done" | "cant";
const WORK_STAGES = new Set(["build", "fix"]);

export const assignDedupKey = (taskId: string, round: number, attempt: number): string => `assign:${taskId}:${round}:${attempt}`;

/** 本轮第几次开 ask：1 + 本轮 PM 跑过几次 `ledger ask-reopen`（assign_reopen 事件，data.round 记着是哪一轮） */
export function attemptOf(events: readonly { kind: string; target: string; data: Record<string, unknown> }[], taskId: string, round: number): number {
  return 1 + events.filter((e) => e.kind === "assign_reopen" && e.target === taskId && e.data.round === round).length;
}

export interface AskPlan {
  dedupKey: string;
  assignee: string;
  title: string;
  body: string;
}

/**
 * 任务在 build / fix、负责人是人 → 该有一条指给他的 assigned ask（dedupKey 撞上 = 这一轮这次已经开过，调用方拿回原来那条）。
 * 正文只放任务号、标题和 PM 写的背景（extra.brief）；规格卡原文不截取。
 */
export function askPlanFor(task: HumanTaskView, attempt: number): AskPlan | null {
  if (task.assigneeKind !== "human" || !task.assignee || !WORK_STAGES.has(task.stage)) return null;
  const brief = typeof task.extra.brief === "string" && task.extra.brief.trim() ? task.extra.brief.trim() : "";
  const lines = [`${task.id} ${task.title}`, ...(task.stage === "fix" ? [`第 ${task.round} 轮返工`] : []), ...(brief ? ["", brief] : [])];
  return { dedupKey: assignDedupKey(task.id, task.round, attempt), assignee: task.assignee, title: `${task.id} ${task.title}`, body: lines.join("\n") };
}

export type DeliverGate = { ok: true; move: boolean } | { ok: false; reason: string };

/**
 * v3.2 例外的门：只有 human 节点、任务还在 build / fix、作答的是这一轮这次的 assigned ask、作答人是 assignee 本人（合并后同一个人名下的
 * 设备也算）或 owner。点「完成」写交付并推到 review；点「做不了」只结案，不写交付、不推阶段。
 */
export function checkHumanDeliver(
  task: HumanTaskView,
  ask: { dedupKey: string | null; kind: string },
  answerer: { persons: readonly string[]; isOwner: boolean },
  result: HumanResult,
  attempt: number,
): DeliverGate {
  if (task.assigneeKind !== "human" || !task.assignee) return { ok: false, reason: `${task.id} 不是指给人的任务` };
  if (!WORK_STAGES.has(task.stage)) return { ok: false, reason: `${task.id} 当前阶段是 ${task.stage}，人只能从 build / fix 交付` };
  if (ask.kind !== "assigned" || ask.dedupKey !== assignDedupKey(task.id, task.round, attempt)) return { ok: false, reason: "这条 ask 不是本轮本次的指派，已过时" };
  if (!answerer.isOwner && !answerer.persons.includes(task.assignee)) return { ok: false, reason: "只有被指派的人或 owner 能作答" };
  return { ok: true, move: result === "done" };
}

/** deliver 事件的 text：固定模板（人写的说明放 data.note，标外部文本） */
export const humanDeliverText = (taskId: string, result: HumanResult): string => `${taskId} 人工交付：${result === "done" ? "完成" : "做不了"}`;

/** 没开班子时给 task.pm 的一条通知：只有任务号、指派对象和结果，不带人写的任何字 */
export function pmNotice(task: Pick<HumanTaskView, "id" | "assignee">, result: HumanResult | "expired"): string {
  const what = result === "done" ? "已完成，已推到 review" : result === "cant" ? "做不了，原因记在台账里" : "已过期";
  return `[台账] ${task.id} 指派给 ${task.assignee ?? "?"} 的事项${what}。`;
}
