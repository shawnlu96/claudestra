/**
 * i28-ASK1：标准答复块随单下发——本机审查单、出借池审查单、调度派单（写 / 修 / 审）、take_order 领的写单、出借池写 / 修单都带同一段，
 * 审查单另带分级规则；文字只有 order-standard-answers.ts 一份。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { writeOrderWire, type WriteOrderInput } from "../src/lib/ledger-lend-lease.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { GRADING_RULE, REVIEW_ASK_REPLY, STANDARD_ANSWERS_HEAD, standardAnswers } from "../src/lib/order-standard-answers.js";
import { currentOrders, orderWireFor } from "../src/lib/order-take.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { SessionRef } from "../src/lib/worker-session.js";

const P = "claude-orchestrator";
const H = "c".repeat(40);
const OWNER = { actor: "owner", now: 1_000 };
let db: Database;

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: P, id: "T60", title: "卡", kind: "code" });
  setTask(db, OWNER, { id: "T60", rev: 1, patch: { agent: "agent-x" } });
});
afterEach(() => closeLedger(":memory:"));

describe("文字本身", () => {
  test("审查单带分级规则，写单 / 修复单不带；两种都带环境、职责、规格为准", () => {
    const review = standardAnswers("review"), author = standardAnswers("author");
    for (const s of [review, author]) {
      expect(s.startsWith(STANDARD_ANSWERS_HEAD)).toBe(true);
      expect(s).toContain("bun install --frozen-lockfile");
      expect(s).toContain("CI 由合并闸核对");
      expect(s).toContain("以规格为准");
    }
    expect(review).toContain(GRADING_RULE);
    expect(author).not.toContain("分级");
  });

  test("审查单提问的当场答复：分级规则原文 + 写进报告交结论；短于旧版远端显示的 300 字", () => {
    expect(REVIEW_ASK_REPLY).toContain(GRADING_RULE);
    expect(REVIEW_ASK_REPLY).toContain("把你的判断和理由写进报告，交结论");
    expect(REVIEW_ASK_REPLY.length).toBeLessThanOrEqual(300);
  });

  test("只有一份实现：src 里别的文件不出现这段文字", () => {
    const owners: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /frozen-lockfile` 装依赖|审查员只审代码|拿不准就写进报告/.test(readFileSync(p, "utf8"))) owners.push(p);
      }
    };
    walk(join(import.meta.dir, "..", "src"));
    expect(owners.map((p) => p.slice(p.indexOf("src/")))).toEqual(["src/lib/order-standard-answers.ts"]);
  });
});

describe("每条派单路径都带", () => {
  test("take_order 领的写单：标准答复（不带分级）", () => {
    assignStep(db, { actor: "agent-pm", now: 1_100 }, { taskId: "T60", step: "write", executor: "agent-x", executorKind: "agent" });
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T60'");
    const [cur] = currentOrders(db, { agent: "agent-x", sessionId: "sx", family: "claude-code", channelId: "ch-x" });
    const r = orderWireFor(db, cur!);
    expect(r.ok && r.order.inputs.at(-1)).toBe(standardAnswers("author"));
  });

  test("本机审查单（take_review）：标准答复 + 分级", () => {
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T60'`);
    const r = reviewOrderOf(db, { task: getTask(db, "T60")!, orderId: "T60:review:r1", node: "review", head: H, auto: false });
    expect(r.ok && r.order.inputs.at(-1)).toBe(standardAnswers("review"));
  });

  test("出借池审查单：标准答复 + 分级（外发闸折叠后仍在）", () => {
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T60'`);
    offerLendCore(db, { actor: "scheduler", now: 1_000 }, { taskId: "T60", peer: "mate", family: "codex", repo: "shawnlu96/claudestra", pr: 12,
      spec: "规格", borrow: { peer: "mate", projects: [P], roles: ["review"], maxOpen: 1 } });
    const last = listLendOrders(db, "T60")[0]!.wire.inputs.at(-1)!;
    expect(last).toContain("bun install --frozen-lockfile");
    expect(last).toContain("拿不准就写进报告并说明理由");
  });

  test("出借池写单 / 修复单：标准答复（不带分级）", () => {
    const task = { id: "T9", specRev: 2, round: 1 } as LedgerTask;
    const o: WriteOrderInput = { orderId: "lend:T9:s2:r1:a0", step: "write", head: "b".repeat(40), branch: "lend/T9-abcd", base: "main", spec: "规格",
      report: null, findings: [], repo: "shawnlu96/claudestra", pr: 7 };
    expect(writeOrderWire(task, o).inputs.at(-1)).toBe(standardAnswers("author"));
    expect(writeOrderWire(task, { ...o, step: "fix", report: "## P1" }).inputs.at(-1)).toBe(standardAnswers("author"));
  });

  test("调度派单：写 / 修带标准答复，审带分级", () => {
    const task = { id: "T1", round: 2 } as LedgerTask;
    const ref: SessionRef = { taskId: "T1", role: "author", agent: "agent-t1", sessionId: "s".repeat(36), family: "codex", transport: "acp" };
    const intent = (node: string) => ({ id: `t68:s1:r2:${node}:a0`, node, head: H, specRev: 3 }) as SchedulerIntent;
    for (const node of ["write", "fix"]) expect(workOrderFor(task, intent(node), null, ref)!.inputs.at(-1)).toBe(standardAnswers("author"));
    expect(workOrderFor(task, intent("adversarial_review"), null, { ...ref, role: "reviewer" })!.inputs.at(-1)).toBe(standardAnswers("review"));
  });
});
