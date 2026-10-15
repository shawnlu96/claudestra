/**
 * 巡检发现只进 pm-todo（agents-PULLTODO1，恢复键 pmTodoPull，普通键、缺省 on）：bridge/ledger-audit-service.ts 把发给当班 PM 的巡检发现
 * 经 recordPmTodo 记成条目（按发现 key@firstSeen 去重），不再 deliver；PM 用 `ledger pm-todo` 拉，用 pm-todo-done:<dedupKey> 关。
 * - off：与改前一致；observe：照旧推送，另记一条「本会只进 pm-todo」的恢复观察；on：只记条目。
 * - 升级（ledgerAuditEscalator）与巡检自身失败不经这里，照旧推送。
 * - 展示：发现已解决（不在 openFindings 里）的条目不再列出；这里只读 src/lib 的巡检存储，不 import bridge。tests/pm-todo-audit.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openFindings, type StoredFinding } from "./ledger-audit-store.js";
import type { PmTodo } from "./pm-todo.js";
import { recordPmTodo } from "./pm-todo-note.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

export const AUDIT_TODO_KIND = "audit_finding";
const TEXT_MAX = 300;
const DEDUP_MAX = 300;
const PART = /^[\w.:@/-]{1,120}$/;

/** pmTodoPull 的有效模式：项目没配过恢复策略 = on（普通键缺省 on）；配过就照恢复策略（键 → 项目 mode → observe），读不了 = off */
export function pmTodoPullMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  const p = policy(project, "pmTodoPull");
  return p.source === "default" ? "on" : p.mode;
}

const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim();
const clip = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max).join("")}…` : s);
const digest = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

type AuditRef = Pick<StoredFinding, "key" | "firstSeen">;
/** 每次打开（key + firstSeen）一条；解决后再打开是新一条。太长的 key 用摘要 */
export function auditTodoKey(f: AuditRef): string {
  const k = `audit-todo:${oneLine(f.key)}@${f.firstSeen}`;
  return k.length <= DEDUP_MAX ? k : `audit-todo:${digest(`${f.key}@${f.firstSeen}`)}`;
}

/** 卡号、类别、一句话 */
function auditTodoText(f: Pick<StoredFinding, "taskId" | "rule" | "detail">): string {
  return clip(oneLine(`巡检 ${f.rule}：${f.taskId ?? "（无卡号）"} · ${f.detail}`), TEXT_MAX);
}

/** bridge 的巡检推送用：on 时记条目，observe 时记观察 */
export interface AuditTodoPort {
  mode(project: string): RecoveryMode;
  record(list: readonly StoredFinding[]): void;
  observe(list: readonly StoredFinding[]): void;
}

export function recordAuditTodos(db: Database, list: readonly StoredFinding[], now: number): void {
  for (const f of list) {
    recordPmTodo(db, { actor: "scheduler", now }, { project: f.project, target: f.taskId ?? "", kind: AUDIT_TODO_KIND, text: auditTodoText(f), dedupKey: auditTodoKey(f) });
  }
}

export function observeAuditTodos(db: Database, list: readonly StoredFinding[], now: number): void {
  for (const f of list) {
    recordObserved(db, { project: f.project, mechanism: "pmTodoPull", target: f.taskId && PART.test(f.taskId) ? f.taskId : "",
      actionKey: `audit:${digest(`${f.key}@${f.firstSeen}`)}`, action: `巡检发现 ${clip(oneLine(f.rule), 60)} 只进 pm-todo、不推送` }, now);
  }
}

export function auditTodoPort(db: () => Database, now: () => number = Date.now, policy?: RecoveryPolicyPort): AuditTodoPort {
  return {
    mode: (project) => pmTodoPullMode(project, policy),
    record: (list) => recordAuditTodos(db(), list, now()),
    observe: (list) => observeAuditTodos(db(), list, now()),
  };
}

/** pm-todo 的合并一行：巡检条目只在发现还开着时列出（PM ack / 发现解决后自然消失，不必手动关） */
export function mergeAuditTodos(db: Database, project: string, todos: PmTodo[]): PmTodo[] {
  if (!todos.some((t) => t.kind === AUDIT_TODO_KIND)) return todos;
  const open = new Set(openFindings(db, project).map(auditTodoKey));
  return todos.filter((t) => t.kind !== AUDIT_TODO_KIND || (t.dedupKey !== undefined && open.has(t.dedupKey)));
}
