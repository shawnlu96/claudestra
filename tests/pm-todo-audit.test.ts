/**
 * agents-PULLTODO1：巡检发现进 pm-todo 的条目（lib/pm-todo-audit.ts）——合成台账。
 * 开关缺省 on；条目按 key@firstSeen 去重；`ledger pm-todo` 只列发现还开着的；observe 记一条观察；PM 用 pm-todo-done 关。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { reconcileFindings, openFindings } from "../src/lib/ledger-audit-store.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { AUDIT_TODO_KIND, auditTodoKey, observeAuditTodos, pmTodoPullMode, recordAuditTodos } from "../src/lib/pm-todo-audit.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import type { RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let db: Database, path: string;
const finding = (taskId: string | null, detail = "PM 押着没放") =>
  ({ key: `p|pm_held|${taskId ?? "-"}`, project: "p", taskId, rule: "pm_held" as const, since: 1, detail, suggestion: "放行或说明", notify: "agent-pm" });
beforeEach(() => {
  path = tempLedgerPath("pm-todo-audit-"); db = openLedger(path);
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "t", kind: "code", agent: "agent-w" });
});
afterEach(() => { closeLedger(path); rmSync(dirname(path), { recursive: true, force: true }); });
const policy = (p: Partial<RecoveryPolicy>) => () => ({ mode: "observe", manualAfterMs: null, source: "config", ...p }) as RecoveryPolicy;

test("pmTodoPull 是登记过的恢复键；没配 = on，配了照配置，读不了 = off", () => {
  expect(RECOVERY_KEYS).toContain("pmTodoPull");
  expect(pmTodoPullMode("p")).toBe("on");
  expect(pmTodoPullMode("p", policy({ source: "default" }))).toBe("on");
  for (const mode of ["on", "observe", "off"] as const) expect(pmTodoPullMode("p", policy({ mode }))).toBe(mode);
  expect(pmTodoPullMode("p", policy({ mode: "off", source: "error" }))).toBe("off");
});

test("[验收线 1] on：发现记成 pm-todo（卡号、类别、一句话），重复记不重复；发现解决后不再列出", () => {
  reconcileFindings(db, "p", [finding("T1"), finding(null, "项目级")], ["pm_held"], 10);
  const open = openFindings(db, "p");
  recordAuditTodos(db, open, 20); recordAuditTodos(db, open, 30);
  const notes = listEvents(db, { project: "p" }).filter((e) => e.data.op === "pm_todo");
  expect(notes.map((e) => [e.target, e.data.kind, e.dedupKey])).toEqual(open.map((f) => [f.taskId ?? "", AUDIT_TODO_KIND, auditTodoKey(f)]));
  const todos = pmTodos(db, "p", () => "", 40);
  expect(todos.map((t) => t.what).sort()).toEqual(["巡检 pm_held：T1 · PM 押着没放", "巡检 pm_held：（无卡号） · 项目级"].sort());
  expect(todos.every((t) => t.kind === AUDIT_TODO_KIND && t.due)).toBe(true);
  reconcileFindings(db, "p", [finding(null, "项目级")], ["pm_held"], 50); // T1 那条解决了
  expect(pmTodos(db, "p", () => "", 60).map((t) => t.task)).toEqual([""]);
});

test("PM 用 pm-todo-done:<dedupKey> 关掉条目", () => {
  reconcileFindings(db, "p", [finding("T1")], ["pm_held"], 10);
  const [f] = openFindings(db, "p");
  recordAuditTodos(db, [f!], 20);
  appendEvent(db, { actor: "agent-pm", dedupKey: `pm-todo-done:${auditTodoKey(f!)}` }, { project: "p", target: "T1", kind: "note", text: "已处理" });
  expect(pmTodos(db, "p", () => "", 30)).toEqual([]);
});

test("[验收线 4] observe：每条发现记一条恢复观察，同一发现只记一次，不记 pm-todo", () => {
  reconcileFindings(db, "p", [finding("T1")], ["pm_held"], 10);
  const open = openFindings(db, "p");
  observeAuditTodos(db, open, 20); observeAuditTodos(db, open, 30);
  const events = listEvents(db, { project: "p" });
  expect(events.filter((e) => e.data.op === "recovery_observe").map((e) => [e.target, e.data.mechanism])).toEqual([["T1", "pmTodoPull"]]);
  expect(events.some((e) => e.data.op === "pm_todo")).toBe(false);
});

test("超长 key 用摘要做去重键，仍在 300 字以内且稳定", () => {
  const long = { key: "k".repeat(400), firstSeen: 5 };
  expect(auditTodoKey(long)).toBe(auditTodoKey(long));
  expect(auditTodoKey(long).length).toBeLessThanOrEqual(300);
});
