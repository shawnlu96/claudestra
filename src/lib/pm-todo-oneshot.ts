/**
 * 其他 agent 发给当班 PM、没标级别的 oneShot（agents-NOTICETYPE1，docs/architecture/pm-digest.md「通知级别」）：分流不看正文、不立即送，
 * 进摘要队列时带 unleveled；`ledger pm-todo` 把队里这些条目列出来（发送方、卡号、首行），PM 拉取时处理。只读摘要队列，不写台账。
 * 条目随摘要队列出队（拉取模式 24 小时没人拉就出队、推送摘要送到就出队）。
 */
import { PmDigestStore } from "./pm-digest-store.js";
import type { PmTodo } from "./pm-todo.js";

export const ONESHOT_TODO_KIND = "oneshot_unleveled";

export function mergeOneShotTodos(project: string, todos: PmTodo[], store: Pick<PmDigestStore, "read"> = new PmDigestStore()): PmTodo[] {
  const mine = store.read().queue.filter((e) => e.project === project && e.unleveled === true);
  return [...todos, ...mine.map((e): PmTodo => ({ task: e.card ?? "", verifiedAt: e.at, hours: null, due: true, dueAt: e.at,
    what: `${e.source} · ${e.firstLine}`, kind: ONESHOT_TODO_KIND }))];
}
