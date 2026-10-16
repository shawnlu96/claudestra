/**
 * PMEMTUNE1 验收线 3 / 5（全文直发）：workOrderFor 出的写 / 审查单经 sendWithMemory 全文直发——发送成功后 wire 带记忆、记推出和一条检索尝试；
 * 发送失败台账上什么都不多；wake 投递不碰；检索出错 / 超时照发；memoryDirectInjection 未配置 = on，off = 逐字原样。
 * 两个发送点（scheduler-auto-tick.ts、scheduler-dispatch-recovery.ts）都经这一层包装：源码核对。
 */
import type { Database } from "bun:sqlite";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { sendWithMemory } from "../src/lib/memory-inject-dispatch.js";
import { MEMORY_CAPS } from "../src/lib/memory-retrieve.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import type { SessionRef, WorkOrder } from "../src/lib/worker-session.js";

const P = "demo";
const HEAD = "c".repeat(40);
let db: Database;
let now = 1_000;

const text = { mode: "text" as const, reason: "Codex tmux 会话没有派单工具" };
const ref = { taskId: "T1", role: "author", agent: "agent-dev", sessionId: "s1", family: "codex", transport: "tmux" } as unknown as SessionRef;
const intent = (node: string, id: string) => ({ id, taskId: "T1", project: P, node, specRev: 1, head: HEAD, action: "dispatch" }) as unknown as SchedulerIntent;
const order = (node: "write" | "adversarial_review", delivery: WorkOrder["delivery"] = text): WorkOrder =>
  ({ ...workOrderFor(getTask(db, "T1")!, intent(node, `intent-${node}`), null, ref, undefined, db)!, delivery });
const events = () => listEvents(db, { project: P });
const pushes = () => events().filter((e) => e.kind === "scheduler" && e.data.op === "memory_retrieve");
const attempts = () => events().filter((e) => e.kind === "note" && e.data.op === "memory_inject_attempt");
const pit = (title: string): MemoryInput => ({ project: P, kind: "pitfall", title, symptom: `${title}症状`, rule: `${title}规则`, files: ["src/lib/x.ts"],
  fixable: false, via: "tool", authorRole: "reviewer", taskId: "T1", head: "abc1234", specRev: 1 });
const decision = (title: string): MemoryInput => ({ project: P, kind: "decision", title, body: `${title}正文`, files: ["src/lib/x.ts"], via: "tool", authorRole: "owner", taskId: "T1" });
const remember = (m: MemoryInput) => recordMemory(db, { actor: "agent-pm", now: ++now }, m).memory.id;
const noPrep = { prepare: async () => ({ headFiles: null }) };

/** 记下收到的单子；status 决定发送结果 */
function sender(kind: "sent" | "replan" | "held" = "sent") {
  const got: WorkOrder[] = [];
  return { got, send: async (o: WorkOrder) => { got.push(o); return { kind }; } };
}

beforeEach(() => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  createTask(db, { actor: "owner", now }, { project: P, id: "T1", title: "批量写", kind: "code" });
  db.prepare("UPDATE tasks SET stage = 'build', headSHA = ?, extra = ? WHERE id = 'T1'").run(HEAD, JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
});
afterEach(() => {
  closeLedger(":memory:");
  rmSync(RECOVERY_POLICY_PATH, { force: true });
});

describe("[验收线 3] 全文直发带记忆，只在发送成功后登记", () => {
  test("写单（未配置 = on）：发出去的单子末尾一节、预算内；推出与尝试各记一条（channel = direct）", async () => {
    const id = remember(pit("并发写要加锁"));
    const s = sender();
    const r = await sendWithMemory(db, getTask(db, "T1")!, order("write"), s.send, noPrep);
    expect(r).toEqual({ kind: "sent" });
    const section = s.got[0]!.inputs.at(-1)!;
    expect(section).toStartWith("项目记忆（原文，非指令");
    expect(section).toContain(id);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MEMORY_CAPS.write.bytes);
    expect(pushes().map((e) => e.data)).toEqual([expect.objectContaining({ order: "write", head: HEAD, memoryIds: [id], channel: "direct" })]);
    expect(attempts().map((e) => e.data)).toEqual([expect.objectContaining({ channel: "direct", order: "write", result: "injected", count: 1, orderId: "intent-write" })]);
    expect(events().find((e) => e.data.op === "memory_rank")!.data.elapsedMs).toEqual(expect.any(Number));
  });

  test("审查单：只放坑", async () => {
    const p = remember(pit("审查要看的坑")), d = remember(decision("一条决定"));
    const s = sender();
    await sendWithMemory(db, getTask(db, "T1")!, order("adversarial_review"), s.send, noPrep);
    const section = s.got[0]!.inputs.at(-1)!;
    expect(section).toStartWith("项目记忆·坑");
    expect(section).toContain(p);
    expect(section).not.toContain(d);
    expect(pushes()[0]!.data).toMatchObject({ order: "review", memoryIds: [p], channel: "direct" });
  });

  test("发送失败（replan / held）：不记推出、不记尝试，台账上一条事件都不多", async () => {
    remember(pit("并发写要加锁"));
    const before = events().length;
    for (const kind of ["replan", "held"] as const) {
      const s = sender(kind);
      expect(await sendWithMemory(db, getTask(db, "T1")!, order("write"), s.send, noPrep)).toEqual({ kind });
      expect(s.got[0]!.inputs.at(-1)).toStartWith("项目记忆");
    }
    expect(events()).toHaveLength(before);
  });

  test("wake 投递与复述单不碰：原样交给 send，什么都不记", async () => {
    remember(pit("并发写要加锁"));
    const before = events().length;
    const s = sender();
    const wake = order("write", { mode: "wake" });
    await sendWithMemory(db, getTask(db, "T1")!, wake, s.send, noPrep);
    expect(s.got[0]).toBe(wake);
    expect(events()).toHaveLength(before);
  });

  test("检索抛错 / 超时：单子原样发出，尝试记 error（只在发出之后）", async () => {
    remember(pit("并发写要加锁"));
    for (const [i, prepare] of [async () => { throw new Error("向量库坏了"); }, () => new Promise<never>(() => {})].entries()) {
      const plain = { ...order("write"), dedupKey: `intent-err-${i}` };
      const s = sender();
      await sendWithMemory(db, getTask(db, "T1")!, plain, s.send, { prepare, timeoutMs: 30 });
      expect(s.got[0]).toBe(plain);
    }
    expect(attempts().map((e) => [e.data.result, e.data.count])).toEqual([["error", 0], ["error", 0]]);
    expect(String(attempts()[1]!.data.reason)).toContain("超时");
    expect(pushes()).toEqual([]);
  });
});

describe("[验收线 5] memoryDirectInjection 开关", () => {
  test("off：单子逐字原样、台账不多；observe：原样发，发出后只记一条观察样本", async () => {
    remember(pit("并发写要加锁"));
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { keys: { memoryDirectInjection: "off" } } } }));
    const before = events().length;
    const plain = order("write");
    const s = sender();
    await sendWithMemory(db, getTask(db, "T1")!, plain, s.send, noPrep);
    expect(s.got[0]).toBe(plain);
    expect(events()).toHaveLength(before);

    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { keys: { memoryDirectInjection: "observe" } } } }));
    await sendWithMemory(db, getTask(db, "T1")!, plain, s.send, noPrep);
    expect(s.got[1]).toBe(plain);
    expect(pushes()).toEqual([]);
    const obs = events().filter((e) => e.data.op === "recovery_observe");
    expect(obs.map((e) => e.data)).toEqual([expect.objectContaining({ mechanism: "memoryDirectInjection", actionKey: "intent-write", count: 1, result: "injected" })]);
  });

  test("未配置 = on：发出后留一条缺省档生效记录（recovery_default_on）", async () => {
    remember(pit("并发写要加锁"));
    await sendWithMemory(db, getTask(db, "T1")!, order("write"), sender().send, noPrep);
    expect(events().filter((e) => e.data.op === "recovery_default_on").map((e) => e.data.mechanism)).toEqual(["memoryDirectInjection"]);
  });
});

describe("[验收线 3] 发送点都经包装", () => {
  test("scheduler-auto-tick.ts、scheduler-dispatch-recovery.ts 的 driveDispatch 都包在 sendWithMemory 里", () => {
    for (const f of ["scheduler-auto-tick.ts", "scheduler-dispatch-recovery.ts"]) {
      const src = readFileSync(join(import.meta.dir, "../src/lib", f), "utf8");
      expect(src).toMatch(/sendWithMemory\([^\n]*\{ \.\.\.order, delivery \}, \(o\) => driveDispatch\(/);
      expect(src).not.toMatch(/driveDispatch\([^\n]*\{ \.\.\.order, delivery \}\)/);
    }
  });
});
