import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { listAsks } from "../src/lib/ledger-asks.js";
import { priorityStallBases } from "../src/lib/ledger-priority-stall-read.js";
import { claimPriorityStalls, finishPriorityStall, priorityStallOwner } from "../src/lib/ledger-priority-stall-store.js";
import { PRIORITY_STALL_MS as W } from "../src/lib/ledger-priority-stall.js";
import { isAskForAudience } from "../src/lib/ask-audience.js";

let db: Database;
const project = "prio", pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "现在做", ownerAt: t0, sourceRef: "test:owner" };
const ctx = (now = t0) => ({ actor: "scheduler", now });
const claim = (now: number) => claimPriorityStalls(db, ctx(now), project)[0];

beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner", now: t0 }, { project, key: "pms", value: [pm] });
  createTask(db, { actor: pm, now: t0 }, { project, id: "T", kind: "code", title: "task", pm });
  setPriority(db, { actor: pm, project, now: t0, dedupKey: "band" }, { target: { kind: "task", id: "T" }, band: "now", rev: 0, evidence });
  setPriorityMode(db, { actor: pm, project, now: t0, dedupKey: "mode" }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
});
afterEach(() => closeLedger(":memory:"));

/** heal → 卡上记 → owner 步，返回 owner 步建 / 关联的 ask id */
function escalate(at: number): string | null {
  for (const step of ["heal", "pm"] as const) {
    const c = claim(at);
    expect(c.action).toBe(step);
    finishPriorityStall(db, ctx(at), project, c.basis.key, c.token, "success", "test");
    at += W;
  }
  const owner = claim(at);
  expect(owner.action).toBe("owner");
  return priorityStallOwner(db, ctx(at), project, owner.basis.key, owner.token);
}

test("now 停滞提醒指派给 PM，不进 owner 收件；重复 tick 只建一条", () => {
  const id = escalate(t0 + W);
  expect(id).toMatch(/^ask_/);
  expect(claim(t0 + 10 * W)).toBeUndefined();
  const asks = listAsks(db, { project });
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ id, kind: "owner_action", assignee: pm, extra: { mechanism: "priorityStall", pm } });
  expect(isAskForAudience(asks[0])).toBe(false);
  expect(isAskForAudience(asks[0], [pm])).toBe(true);
});

test("开着的停滞提醒不被当成「等 PM 答 ask」，下一周期照常自愈", () => {
  const id = escalate(t0 + W)!;
  const b = priorityStallBases(db, project, undefined, t0 + 4 * W).find((x) => x.taskId === "T")!;
  expect(b.ask).toBeUndefined();
  expect(b.block.kind).not.toBe("ask");
  expect(b.why).not.toContain(id);
});
