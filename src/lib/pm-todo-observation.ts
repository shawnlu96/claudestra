/** Observation conclusions share the generic pm_todo writer; reads never need the plan state file. */
import type { Database } from "bun:sqlite";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import type { ObservationPlan } from "./observation-plan.js";
import type { PmTodo } from "./pm-todo.js";
import { recordPmTodo } from "./pm-todo-note.js";

export function closeObservationTodos(db: Database, ctx: WriteCtx, plan: ObservationPlan, except?: string): void {
  for (const e of listEvents(db, { project: plan.project, target: plan.taskId })) {
    if (e.dedupKey === except || e.data.op !== "pm_todo" || !["observation_judged", "observation_extended"].includes(String(e.data.kind))
      || !String(e.dedupKey).startsWith(`observation-todo:${plan.id}:`)) continue;
    appendEvent(db, { ...ctx, dedupKey: `pm-todo-done:${e.dedupKey}` }, { project: plan.project, target: plan.taskId, kind: "note", text: "观察期状态已更新", data: {} });
  }
}

export function recordObservationTodo(db: Database, ctx: WriteCtx, plan: ObservationPlan, kind: "observation_judged" | "observation_extended", text: string): void {
  const dedupKey = `observation-todo:${plan.id}:${kind}:${plan.attempt ?? 0}:${plan.extensions ?? 0}`;
  closeObservationTodos(db, ctx, plan, dedupKey);
  recordPmTodo(db, ctx, { project: plan.project, target: plan.taskId, kind, text,
    dedupKey });
}

/** Existing task rows retain their fields; structured notes add kind / dedupKey to the same output shape. */
export function mergeObservationTodos(db: Database, project: string, todos: PmTodo[], now: number): PmTodo[] {
  const events = listEvents(db, { project });
  const visible: PmTodo[] = [];
  for (const todo of todos) {
    const promoted = events.some((e) => e.target === todo.task && e.ts >= todo.verifiedAt && e.data.op === "observation_promote");
    const registered = events.some((e) => e.target === todo.task && e.ts >= todo.verifiedAt && e.data.op === "observation_plan"
      && ((e.data.authorization as { source?: string } | undefined)?.source === "spec" || e.data.source === "spec")
      && !events.some((later) => later.data.op === "observation_plan" && later.data.plan === e.data.plan && later.data.action === "cancel"));
    visible.push(todo);
    if (promoted || registered) todo.what = `${promoted ? "开关已自动转正" : "开关已交系统观察"}；${todo.what}`;
  }
  for (const e of events) {
    if (e.kind !== "note" || e.data.op !== "pm_todo" || !e.dedupKey || getEventByDedup(db, `pm-todo-done:${e.dedupKey}`)) continue;
    const kind = String(e.data.kind), waiting = kind === "observation_extended";
    visible.push({ task: e.target, verifiedAt: e.ts, hours: null, due: !waiting, dueAt: waiting ? Number.MAX_SAFE_INTEGER : Math.min(now, e.ts),
      what: e.text, kind, dedupKey: e.dedupKey });
  }
  return visible.sort((a, b) => Number(b.due) - Number(a.due) || a.dueAt - b.dueAt);
}
