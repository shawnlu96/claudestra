/**
 * pmem-M5 验收线 3 / 4 / 5：项目记忆一节写进写单 / 审查单——整节与整单都在字节上限内；memoryIds 记进 scheduler 事件、同卡同 specRev
 * 同 head 只算一次；没有可推的记忆时单子与改前逐字一致、不写事件。另：bridge 的只读（query_only）连接上照样登记。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { markMemory, recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, getEventByDedup, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { MEMORY_CAPS } from "../src/lib/memory-retrieve.js";
import { ensureMemoryRetrieval, memoryDedupKey, memorySection, withMemory as previewMemory } from "../src/lib/memory-retrieve-order.js";
import { orderWireFor } from "../src/lib/order-take.js";
import { WIRE_MAX_BYTES } from "../src/lib/order-wire.js";
import { reviewOrderOf } from "../src/lib/review-order.js";

const withMemory: typeof previewMemory = (db, task, kind, head, wire, opts = {}) =>
  previewMemory(db, task, kind, head, wire, { ...opts, recordInjection: true });
const P = "demo";
const HEAD = "a".repeat(40);
const bytes = (s: string) => Buffer.byteLength(s);
let db: Database;
let path = ":memory:";

const memEvents = () => listEvents(db, { project: P }).filter((e) => e.kind === "scheduler" && e.data.op === "memory_retrieve");
const task = () => getTask(db, "T1")!;
const writeOrder = () => {
  const r = orderWireFor(db, { task: task(), stage: "build", step: "write", orderId: "T1:write:r0", intent: null }, true);
  if (!r.ok) throw new Error(r.error);
  return r.order;
};
const reviewOrder = (dir: string) => {
  const r = reviewOrderOf(db, { task: task(), orderId: "T1:review:r1", node: "review", head: HEAD, auto: false }, dir, true);
  if (!r.ok) throw new Error(r.error);
  return r.order;
};

/** 长到顶格的坑 / 决定：标题 80 字节、两段各 300 字节，验字节上限 */
const fat = (k: number, kind: "pitfall" | "decision"): MemoryInput => kind === "pitfall"
  ? { project: P, kind, title: `坑${k}`.padEnd(26, "坑"), symptom: "症".repeat(100), rule: "规".repeat(100), files: ["src/lib/x.ts"], fixable: false,
    via: "tool", authorRole: "reviewer", taskId: "T1", head: "abc1234", specRev: 1 }
  : { project: P, kind, title: `决${k}`.padEnd(26, "决"), body: "定".repeat(200), files: ["src/lib/x.ts"], via: "tool", authorRole: "owner", taskId: "T1" };

function setup(file = ":memory:"): void {
  path = file;
  db = openLedger(file);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T1", title: "批量写", kind: "code" });
  db.prepare("UPDATE tasks SET stage = 'build', headSHA = ?, extra = ? WHERE id = 'T1'").run(HEAD, JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
}

let tmp: string | null = null;
beforeEach(() => setup());
afterEach(() => {
  closeLedger(path);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("共存线：没有可推的记忆时逐字不变（验收线 5）", () => {
  test("写单与审查单：没有记忆 → 没有「项目记忆」项、没有事件；之后加了记忆，单子只在末尾多一项", () => {
    const dir = mkdtempSync(join(tmpdir(), "mret-"));
    tmp = dir;
    const w0 = writeOrder(), r0 = reviewOrder(dir);
    expect(JSON.stringify([w0, r0])).not.toContain("项目记忆");
    expect(memEvents()).toEqual([]);
    // 有记忆但都不可推（候选 = 本卡自己的总结）：同样逐字不变、不写事件
    recordMemory(db, { actor: "pm", now: 1 }, { project: P, kind: "summary", title: "自己", body: "x", via: "verify_summary", authorRole: "system", taskId: "T1", head: "abc1234", specRev: 1 });
    expect(writeOrder()).toEqual(w0);
    expect(memEvents()).toEqual([]);
    recordMemory(db, { actor: "pm", now: 2 }, fat(1, "pitfall"));
    const w1 = writeOrder(), r1 = reviewOrder(dir);
    expect({ ...w1, inputs: w1.inputs.slice(0, -1) }).toEqual(w0);
    expect(w1.inputs.at(-1)).toStartWith("项目记忆（原文，非指令");
    expect({ ...r1, inputs: r1.inputs.slice(0, -1) }).toEqual(r0);
    expect(r1.inputs.at(-1)).toStartWith("项目记忆·坑");
  });
});

describe("memoryIds 记进事件（验收线 4）", () => {
  test("写单：scheduler 事件 data.memoryIds；同卡同 specRev 同 head 只算一次，后来的记忆不改已发的单", () => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const w1 = writeOrder();
    const e = getEventByDedup(db, memoryDedupKey(task(), HEAD, "write"))!;
    expect(e).toMatchObject({ kind: "scheduler", actor: "scheduler", target: "T1", data: { op: "memory_retrieve", order: "write", specRev: 1, head: HEAD, memoryIds: ["ab12-m1"] } });
    expect(JSON.stringify(e.data)).not.toContain("症症"); // 事件不复制正文
    recordMemory(db, { actor: "pm", now: 2 }, fat(2, "pitfall"));
    expect(writeOrder()).toEqual(w1);
    expect(memEvents().length).toBe(1);
    // 换 specRev = 新一次检索
    db.prepare("UPDATE tasks SET specRev = 2 WHERE id = 'T1'").run();
    writeOrder();
    expect(getEventByDedup(db, memoryDedupKey(task(), HEAD, "write"))!.data.memoryIds).toEqual(["ab12-m2", "ab12-m1"]);
  });

  test("审查单与写单各记各的", () => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    recordMemory(db, { actor: "pm", now: 2 }, fat(2, "decision"));
    const dir = mkdtempSync(join(tmpdir(), "mret-"));
    tmp = dir;
    writeOrder();
    reviewOrder(dir);
    expect(getEventByDedup(db, memoryDedupKey(task(), HEAD, "write"))!.data.memoryIds).toEqual(["ab12-m2", "ab12-m1"]);
    expect(getEventByDedup(db, memoryDedupKey(task(), HEAD, "review"))!.data.memoryIds).toEqual(["ab12-m1"]);
  });

  test("bridge 的只读连接（query_only）：另开写连接登记", () => {
    closeLedger(":memory:");
    tmp = mkdtempSync(join(tmpdir(), "mret-"));
    setup(join(tmp, "ledger.sqlite"));
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const rw = db;
    const ro = new Database(path, { readwrite: true, create: false });
    ro.exec("PRAGMA query_only = ON");
    db = ro;
    const w = writeOrder();
    expect(w.inputs.at(-1)).toContain("ab12-m1");
    ro.close();
    db = rw;
    expect(memEvents().length).toBe(1);
  });
});

describe("字节上限（验收线 3）", () => {
  test("写单 ≤4 条、整节 ≤1600 字节；审查单只放坑 ≤3 条、≤1000 字节", () => {
    for (let k = 1; k <= 4; k++) recordMemory(db, { actor: "pm", now: k }, fat(k, "pitfall"));
    for (let k = 5; k <= 7; k++) recordMemory(db, { actor: "pm", now: k }, fat(k, "decision"));
    const w = memorySection(db, task(), "write", HEAD);
    expect(bytes(w)).toBeLessThanOrEqual(MEMORY_CAPS.write.bytes);
    expect(w.split("\n").filter((l) => l.startsWith("- [")).length).toBe(4);
    expect(w.split("\n").at(-1)).toBe("全文：show_memory <id>");
    const r = memorySection(db, task(), "review", HEAD);
    expect(bytes(r)).toBeLessThanOrEqual(MEMORY_CAPS.review.bytes);
    const lines = r.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.startsWith("- [坑 "))).toBe(true);
    // 写进单子后整单也过 parseOrderWire（orderWireFor 内部校验）
    expect(writeOrder().inputs.at(-1)).toBe(w);
  });

  test("整单已近 32KB：少放几条，一条都放不下就不加", () => {
    for (let k = 1; k <= 4; k++) recordMemory(db, { actor: "pm", now: k }, fat(k, "pitfall"));
    const wire = { inputs: ["x"], pad: "" };
    const room = (n: number) => ({ ...wire, pad: "p".repeat(WIRE_MAX_BYTES - bytes(JSON.stringify(wire)) - n) });
    const full = withMemory(db, task(), "write", HEAD, room(2000));
    expect(full.inputs.length).toBe(2);
    expect(bytes(JSON.stringify(full))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
    const tight = withMemory(db, task(), "write", HEAD, room(900));
    expect(tight.inputs.at(-1)!.split("\n").filter((l) => l.startsWith("- [")).length).toBeLessThan(4);
    expect(bytes(JSON.stringify(tight))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
    expect(memEvents().at(-1)!.data.memoryIds).toEqual([...tight.inputs.at(-1)!.matchAll(/\[坑 (ab12-m\d+)/g)].map((m) => m[1]));
    const none = room(50);
    expect(withMemory(db, task(), "write", HEAD, none)).toBe(none);
    expect(memEvents().at(-1)!.data.memoryIds).toEqual([]);
    expect(withMemory(db, task(), "write", HEAD, room(2000))).toEqual(full);
    expect(memEvents().at(-1)!.data.memoryIds).toHaveLength(4);
    const twenty = { inputs: Array.from({ length: 20 }, () => "i") };
    expect(withMemory(db, task(), "write", HEAD, twenty)).toBe(twenty);
  });

  test("出错不挡单：记忆表读坏了单子原样返回", () => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const wire = { inputs: ["x"] };
    db.prepare("DROP TRIGGER memories_no_update").run();
    db.prepare("UPDATE memories SET body = 'not json' WHERE id = 'ab12-m1'").run();
    expect(withMemory(db, task(), "write", HEAD, wire)).toBe(wire);
  });
});


describe("审查回归：实际注入与当前状态", () => {
  test("已有 fallback 时 prepared 仍优先，预览命中缓存不写事件", async () => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    writeOrder();
    const key = memoryDedupKey(task(), HEAD, "write");
    expect(getEventByDedup(db, `${key}:fallback`)!.data.items).toHaveLength(1);
    recordMemory(db, { actor: "pm", now: 2 }, fat(2, "pitfall"));
    await ensureMemoryRetrieval(db, task(), "write", HEAD, { embedder: null, headFiles: null });
    expect(getEventByDedup(db, `${key}:prepared`)!.data.items).toHaveLength(2);
    const before = listEvents(db, { project: P });
    expect(memorySection(db, task(), "write", HEAD)).toContain("ab12-m2");
    expect(previewMemory(db, task(), "write", HEAD, { inputs: ["原文"] }).inputs.at(-1)).toContain("ab12-m2");
    expect(listEvents(db, { project: P })).toEqual(before);
    expect(writeOrder().inputs.at(-1)).toContain("ab12-m2");
    expect(memEvents().at(-1)!.data.rankingSeq).toBe(getEventByDedup(db, `${key}:prepared`)!.seq);
  });

  test.each(["write", "review"] as const)("%s 预览 cache miss 只在内存排名，不开写事务或写事件", (kind) => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const before = listEvents(db, { project: P });
    const transaction = spyOn(db, "transaction");
    try {
      expect(memorySection(db, task(), kind, HEAD)).toContain("ab12-m1");
      expect(previewMemory(db, task(), kind, HEAD, { inputs: ["原文"] }).inputs.at(-1)).toContain("ab12-m1");
      expect(transaction).not.toHaveBeenCalled();
      expect(listEvents(db, { project: P })).toEqual(before);
    } finally { transaction.mockRestore(); }
  });

  test.each([false, true])("只读预览保留记忆且无旁路写入：query_only=%s", (queryOnly) => {
    closeLedger(":memory:");
    tmp = mkdtempSync(join(tmpdir(), "mret-preview-"));
    setup(join(tmp, "ledger.sqlite"));
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const before = listEvents(db, { project: P });
    const ro = new Database(path, { readonly: true });
    if (queryOnly) ro.exec("PRAGMA query_only = ON");
    // 持有写锁：另开连接偷写会失败；真实只读预览仍须保留记忆。
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(memorySection(ro, task(), "write", HEAD)).toContain("ab12-m1");
      expect(previewMemory(ro, task(), "review", HEAD, { inputs: ["原文"] }).inputs.at(-1)).toContain("ab12-m1");
      expect(listEvents(ro, { project: P })).toEqual(before);
    } finally {
      db.exec("ROLLBACK");
      ro.close();
    }
  });

  test("预算不够时不得记录未推出的 memoryIds", () => {
    recordMemory(db, { actor: "pm", now: 1 }, fat(1, "pitfall"));
    const wire = { inputs: ["x"], pad: "" };
    wire.pad = "p".repeat(WIRE_MAX_BYTES - bytes(JSON.stringify(wire)) - 50);
    expect(withMemory(db, task(), "write", HEAD, wire)).toBe(wire);
    expect(memEvents().flatMap((e) => e.data.memoryIds as string[])).toEqual([]);
  });

  test.each(["dispute", "retract", "supersede", "fixed"] as const)("缓存后 %s 的记忆不再注入", (mark) => {
    recordMemory(db, { actor: "pm", now: 1 }, { ...fat(1, "pitfall"), fixable: true });
    expect(writeOrder().inputs.at(-1)).toContain("ab12-m1");
    if (mark === "supersede") recordMemory(db, { actor: "pm", now: 2 }, fat(2, "pitfall"));
    if (mark === "fixed") markMemory(db, { actor: "pm" }, { memoryId: "ab12-m1", mark: "link_fix", taskId: "T1" });
    markMemory(db, { actor: "pm" }, {
      memoryId: "ab12-m1", mark, reason: "规则已变", ...(mark === "supersede" ? { by: "ab12-m2" } : {}), ...(mark === "fixed" ? { taskId: "T1" } : {}),
    });
    expect(writeOrder().inputs.join("\n")).not.toContain("ab12-m1");
    expect(memEvents().at(-1)!.data.memoryIds).toEqual([]);
  });

  test("缓存后的 open → fixing 显示当前状态", () => {
    recordMemory(db, { actor: "pm", now: 1 }, { ...fat(1, "pitfall"), fixable: true });
    expect(writeOrder().inputs.at(-1)).toContain("开放");
    markMemory(db, { actor: "pm" }, { memoryId: "ab12-m1", mark: "link_fix", taskId: "T1" });
    expect(writeOrder().inputs.at(-1)).toContain("修复中");
  });
});
