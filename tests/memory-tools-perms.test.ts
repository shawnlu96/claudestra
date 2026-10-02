/**
 * pmem-M2 验收线 2：设计稿 §4.2 权限表每一格都有用例。行 = 8 种 mark，列 = 5 种角色（executor / reviewer / pm / owner / system），
 * 外加「没有角色」一列和两条特例（审查员 confirm 只对坑；作者 24 小时内可撤自己写的）。
 * 每格既查纯函数 canMark，也在真库上走 markAs（角色从身份 + 单号重算），允许的格子真写进 mark、拒绝的格子一行不写。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMarks, recordMemory } from "../src/lib/ledger-memory.js";
import type { MemoryMarkKind } from "../src/lib/ledger-memory-schema.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, setMeta, setTask } from "../src/lib/ledger-write.js";
import { AUTHOR_RETRACT_MS, canMark, MARK_PERMISSIONS, markAs, type MemoryCaller, type MemoryRole } from "../src/lib/memory-tools.js";

const P = "demo";
const H1 = "c".repeat(40);
const OWNER = { actor: "owner", now: 1_000 };
let db: Database, dir: string;

/** §4.2 原表（期望值单独写一遍，不从实现里抄） */
const TABLE: Record<MemoryMarkKind, Record<MemoryRole, boolean>> = {
  dispute: { executor: true, reviewer: true, pm: true, owner: true, system: true },
  confirm: { executor: false, reviewer: true, pm: true, owner: true, system: false },
  retract: { executor: false, reviewer: false, pm: true, owner: true, system: false },
  supersede: { executor: false, reviewer: false, pm: true, owner: true, system: false },
  link_fix: { executor: false, reviewer: false, pm: true, owner: true, system: false },
  unlink_fix: { executor: false, reviewer: false, pm: true, owner: true, system: false },
  fixed: { executor: false, reviewer: false, pm: false, owner: false, system: true },
  reopen: { executor: false, reviewer: false, pm: false, owner: false, system: true },
};
const ROLES: MemoryRole[] = ["executor", "reviewer", "pm", "owner", "system"];
const MARKS = Object.keys(TABLE) as MemoryMarkKind[];

/** 每种角色在真库上怎么认出来：身份 + 单号 */
const CALLERS: Record<MemoryRole, { caller: MemoryCaller; orderId?: string }> = {
  executor: { caller: { actor: "agent-x", sessionId: "sx", family: "claude-code", verified: true }, orderId: "T60:write:r0" },
  reviewer: { caller: { actor: "agent-y", sessionId: "sy", family: "codex", verified: true }, orderId: "T61:review:r1" },
  pm: { caller: { actor: "agent-pm", sessionId: null, family: null, verified: false } },
  owner: { caller: { actor: "owner", sessionId: null, family: null, verified: false } },
  system: { caller: { actor: "scheduler", sessionId: null, family: null, verified: false } },
};

const memory = { kind: "pitfall" as const, author: "agent-pm", createdAt: 0 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pmem-m2-perm-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  for (const id of ["T60", "T61", "FIX"]) {
    createTask(db, OWNER, { project: P, id, title: id, kind: "code" });
    setTask(db, OWNER, { id, rev: 1, patch: { agent: "agent-x" } });
    assignStep(db, { actor: "agent-pm", now: 1_100 }, { taskId: id, step: "write", executor: "agent-x", executorKind: "agent" });
    db.run(`UPDATE tasks SET stage = 'build', headSHA = '${H1}' WHERE id = '${id}'`);
  }
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T61", headSHA: H1, moveFrom: "build" });
  assignStep(db, { actor: "agent-pm", now: 1_300 }, { taskId: "T61", step: "review", executor: "agent-y", executorKind: "agent" });
  // m1 = 被标的 fixable 坑（PM 写的），m2 = supersede 指向的新坑
  for (const title of ["坑一：事务里不能 await", "坑二：事务里只做同步写"]) {
    recordMemory(db, { actor: "agent-pm", now: 1_000 }, { project: P, kind: "pitfall", title, symptom: "提前提交", rule: "同步写", fixable: true,
      files: [], via: "tool", authorRole: "pm" });
  }
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

const argsFor = (mark: MemoryMarkKind) => ({
  memoryId: "ab12-m1", mark, ...(mark === "dispute" || mark === "retract" ? { reason: "规矩写反了" } : {}),
  ...(mark === "supersede" ? { by: "ab12-m2" } : {}), ...(["link_fix", "unlink_fix", "fixed", "reopen"].includes(mark) ? { taskId: "FIX" } : {}),
});

describe("§4.2 权限表：每一格", () => {
  test("实现的表与设计稿逐格一致", () => {
    for (const mark of MARKS) for (const role of ROLES) expect([mark, role, MARK_PERMISSIONS[mark].includes(role)]).toEqual([mark, role, TABLE[mark][role]]);
  });

  for (const mark of MARKS) {
    for (const role of ROLES) {
      test(`${mark} × ${role} → ${TABLE[mark][role] ? "允许" : "拒绝"}`, () => {
        expect(canMark(role, mark, { memory, actor: "someone", now: 10 }) === null).toBe(TABLE[mark][role]);
        const { caller, orderId } = CALLERS[role];
        const act = () => markAs(db, caller, { ...argsFor(mark), ...(orderId ? { orderId } : {}) } as never, 5_000);
        if (TABLE[mark][role]) {
          expect(act()).toMatchObject({ ok: true, mark });
          expect(listMarks(db, "ab12-m1").map((m) => [m.mark, m.actor])).toEqual([[mark, caller.actor]]);
        } else {
          expect(act).toThrow();
          expect(listMarks(db, "ab12-m1")).toEqual([]);
        }
      });
    }
    test(`${mark} × 没有角色 → 拒绝`, () => {
      expect(canMark(null, mark, { memory, actor: "agent-z", now: 10 })).not.toBeNull();
      expect(() => markAs(db, { actor: "agent-z", sessionId: "sz", family: "codex", verified: true }, argsFor(mark) as never, 5_000)).toThrow(/没有角色|24 小时|不是/);
    });
  }

  test("特例：审查员 confirm 只对坑，总结 / 决定不行", () => {
    expect(canMark("reviewer", "confirm", { memory: { ...memory, kind: "summary" }, actor: "agent-y", now: 10 })).toMatch(/只能 confirm 坑/);
    expect(canMark("reviewer", "confirm", { memory: { ...memory, kind: "decision" }, actor: "agent-y", now: 10 })).toMatch(/只能 confirm 坑/);
  });

  test("特例：作者 24 小时内可撤自己写的；过了 24 小时、或不是作者，执行者不行", () => {
    const mine = { ...memory, author: "agent-x", createdAt: 1_000 };
    expect(canMark("executor", "retract", { memory: mine, actor: "agent-x", now: 1_000 + AUTHOR_RETRACT_MS })).toBeNull();
    expect(canMark(null, "retract", { memory: mine, actor: "agent-x", now: 1_000 + AUTHOR_RETRACT_MS })).toBeNull();
    expect(canMark("executor", "retract", { memory: mine, actor: "agent-x", now: 1_001 + AUTHOR_RETRACT_MS })).toMatch(/24 小时/);
    expect(canMark("executor", "retract", { memory: mine, actor: "agent-w", now: 2_000 })).toMatch(/24 小时/);
    // 真库：执行者从单上写的坑，自己 24 小时内撤得掉
    recordMemory(db, { actor: "agent-x", now: 1_000 }, { project: P, kind: "pitfall", title: "坑三：重试不幂等", symptom: "重复写", rule: "带 dedup", fixable: true,
      files: [], via: "tool", authorRole: "executor", sources: [{ seq: 1 }] });
    const x = CALLERS.executor.caller;
    expect(() => markAs(db, x, { memoryId: "ab12-m3", mark: "retract", reason: "记错了" }, 1_000 + AUTHOR_RETRACT_MS + 1)).toThrow(/24 小时/);
    expect(markAs(db, x, { memoryId: "ab12-m3", mark: "retract", reason: "记错了" }, 2_000)).toMatchObject({ ok: true, status: "retracted" });
  });
});
