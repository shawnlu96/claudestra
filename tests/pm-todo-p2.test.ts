/**
 * agents-PULLTODO1：「审查通过留 P2」只进 pm-todo（lib/pm-todo-p2.ts 经 p2-backlog-notice.ts p2DiffNotice）。合成台账 + 临时目录；
 * p2-backlog-record 走真实命令，scheduler-pm-todo / scheduler-recovery-observe 走真实 ledger 入口（带租约的调度身份）。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { p2BacklogMode } from "../src/lib/p2-backlog-mode.js";
import { p2DiffNotice } from "../src/lib/p2-backlog-notice.js";
import { P2_TODO_KIND } from "../src/lib/pm-todo-p2.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import type { RecoveryMode, RecoveryPolicy } from "../src/lib/recovery-policy.js";
import type { Registry } from "../src/manager/core.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { p2BacklogCmds } from "../src/manager/ledger-p2-backlog-cmds.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PM = "agent-pm", HEAD = "a".repeat(40), REPORT = "/reports/T1-r2.md";
const ORIGINAL = `[调度引擎] T1 审查通过但留有 P2，已进合并队列，请看 diff：head ${HEAD}，报告 ${REPORT}`;
let db: Database, drafts: string, calls: string[], sent: string[];
const p2 = (findingId: string, family = "naming") => ({ findingId, family, severity: "P2", probe: `src/x.ts:${findingId} 命名不一致` });

function review(findings: ReturnType<typeof p2>[]): number {
  return (db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (500, 'scheduler', 'p', 'T1', 'review', '', ?) RETURNING seq")
    .get(JSON.stringify({ round: 2, head: HEAD, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "s", reviewerFamily: "codex", path: REPORT,
      p0: 0, p1: 0, p2: findings.length, findings })) as { seq: number }).seq;
}
async function manager(_ledger: string, sub: string, ...args: string[]): Promise<Record<string, any>> {
  calls.push(sub);
  if (sub !== "p2-backlog-record") {
    return runLedger([sub, ...args], { db, actor: "scheduler", now: () => 9_000, projectIds: ["p"], assertLease: () => {}, autoDispatch: () => true,
      autoProjects: () => ["p"], loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} } as LedgerDeps) as Promise<Record<string, any>>;
  }
  const spec = p2BacklogCmds(drafts)[sub]!;
  const p = parseLedgerArgs([sub, ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, error: p.error };
  const deps: LedgerDeps = { db, actor: "scheduler", projectIds: ["p"], now: () => 9_000, loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} };
  try { return await spec.run(new LedgerCli(deps, p)); } catch (e) { if (e instanceof LedgerError) return { ok: false, error: e.message }; throw e; }
}
const pull = (mode: RecoveryMode | "default") => () => ({ mode: mode === "default" ? "observe" : mode, manualAfterMs: null, source: mode === "default" ? "default" : "config" }) as RecoveryPolicy;
const notice = (mode: RecoveryMode | "default") =>
  p2DiffNotice(db, getTask(db, "T1")!, ORIGINAL, { manager, notifyPm: async (_t, s) => void sent.push(s), recoveryPolicy: pull(mode) });
const p2Mode = (m: string) => setAutostartSwitch(db, { actor: "owner", now: 10 }, { project: "p", on: true, reason: "测", p2BacklogMode: m });
const todoNotes = () => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_todo");

beforeEach(() => {
  drafts = join(mkdtempSync(join(tmpdir(), "pm-todo-p2-")), "tasks", "drafts");
  calls = []; sent = [];
  db = openLedger(tempLedgerPath("pm-todo-p2-db-"));
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "T1", title: "卡", kind: "code", agent: "agent-exec", pm: PM });
  db.prepare("UPDATE tasks SET stage = 'merge', round = 2, headSHA = ? WHERE id = 'T1'").run(HEAD);
});

describe("[验收线 2] pmTodoPull on：审查通过留 P2 不调 notifyPm，改记 pm-todo", () => {
  test("p2BacklogMode 未配置按 on；pm-todo 有一条含卡号、head、报告、需 PM 判断的 P2", async () => {
    expect(p2BacklogMode(db, "p")).toBe("on");
    const seq = review([p2("F1"), p2("S1", "scope")]);
    await notice("default");
    expect(sent).toEqual([]);
    expect(calls).toEqual(["p2-backlog-record", "scheduler-pm-todo"]);
    const [note] = todoNotes();
    expect([note?.data.kind, note?.dedupKey]).toEqual([P2_TODO_KIND, `p2-todo:T1:${seq}`]);
    const [todo] = pmTodos(db, "p", () => "", 10_000);
    expect(todo).toMatchObject({ task: "T1", kind: P2_TODO_KIND, due: true });
    expect(todo!.what).toContain("需 PM 判断的 P2：S1（");
    expect(todo!.what).toContain(`head ${HEAD}`);
    expect(todo!.what).toContain(`报告 ${REPORT}`);
    await notice("on"); // 同一审查再来一次：不重复
    expect([sent, todoNotes().length]).toEqual([[], 1]);
  });

  test("只有普通 P2 也记一条（需 PM 判断的：无），不推摘要", async () => {
    review([p2("F1")]);
    await notice("on");
    expect(sent).toEqual([]);
    expect(String(todoNotes()[0]?.text)).toContain("需 PM 判断的 P2：无；其余已入积压");
  });

  test("pm-todo 写不进去（没有租约）：照旧推送", async () => {
    review([p2("F1"), p2("S1", "scope")]);
    await p2DiffNotice(db, getTask(db, "T1")!, ORIGINAL, { recoveryPolicy: pull("on"), notifyPm: async (_t, s) => void sent.push(s),
      manager: async (l, sub, ...a) => (sub === "scheduler-pm-todo" ? { ok: false, error: "没租约" } : manager(l, sub, ...a)) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("需 PM 判断的 P2：S1");
  });

  test("p2BacklogMode 显式 off：照旧推原文，不记 pm-todo", async () => {
    p2Mode("off");
    review([p2("F1"), p2("S1", "scope")]);
    await notice("on");
    expect([sent, calls, todoNotes()]).toEqual([[ORIGINAL], [], []]);
  });
});

test("pmTodoPull off：与改前逐字一致", async () => {
  review([p2("F1"), p2("S1", "scope")]);
  await notice("off");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toStartWith(`${ORIGINAL}；需 PM 判断的 P2：S1`);
  expect(calls).toEqual(["p2-backlog-record"]);
  expect(todoNotes()).toEqual([]);
});

test("[验收线 4] pmTodoPull observe：照旧推送并记一条观察", async () => {
  const seq = review([p2("F1"), p2("S1", "scope")]);
  await notice("observe"); await notice("observe");
  expect(sent).toHaveLength(2);
  expect(sent[0]).toStartWith(`${ORIGINAL}；需 PM 判断的 P2：S1`);
  const obs = listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe");
  expect(obs.map((e) => [e.data.mechanism, e.data.actionKey])).toEqual([["pmTodoPull", `p2:${seq}`]]);
  expect(todoNotes()).toEqual([]);
});
