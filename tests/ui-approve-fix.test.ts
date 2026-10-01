/** UI rejection fixes retain their entry source, code evidence and planner P1 safeguards across local / pooled orders. */
import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimLend, offerLendCore } from "../src/lib/ledger-lend.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setTask } from "../src/lib/ledger-write.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";
import { currentOrders, orderWireFor } from "../src/lib/order-take.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";
import { uiRejectFix } from "../src/lib/scheduler-ui-gate.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import { renderWorkOrder } from "../src/lib/worker-order.js";
import { autoFixture, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const NOTE = "深色模式下按钮看不清";
const CODE_REPORT = "# 代码审查\n并发修改会丢失数据,需保留互斥。";
const reportPath = (f: F) => join(f.dir, "code-review.md");
const snapshot = (f: F) => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 10_000 });

async function review(f: F, rows: ReviewFinding[], head = H2) {
  const path = reportPath(f), findings = join(f.dir, "findings.json");
  writeFileSync(path, CODE_REPORT);
  writeFileSync(findings, JSON.stringify(rows));
  expect(await f.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", rows.length ? "changes" : "pass",
    "--p0", "0", "--p1", String(rows.filter((r) => r.severity === "P1").length), "--p2", String(rows.filter((r) => r.severity === "P2").length),
    "--head", head, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", path)).toMatchObject({ ok: true });
}

async function toReview(f: F, rows: ReviewFinding[]) {
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  await f.tick();
  await f.tick();
  await review(f, rows);
}

async function reject(f: F) {
  expect(await f.cli("pm", "ui-reject", "T1", "--text", NOTE)).toMatchObject({ ok: true });
}

async function pause(f: F) {
  for (const [from, to] of [["fix", "blocked"], ["blocked", "fix"]]) {
    expect(await f.cli("pm", "stage", "T1", "--from", from, "--to", to)).toMatchObject({ ok: true });
  }
}

async function localOrder(f: F) {
  const planned = planScheduler(snapshot(f));
  expect(planned).toMatchObject({ kind: "intent", action: "dispatch", node: "fix" });
  if (planned.kind !== "intent") throw new Error(planned.reason);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
  const [order] = currentOrders(f.db, { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" });
  expect(order?.intent).not.toBeNull();
  const pulled = orderWireFor(f.db, order!);
  if (!pulled.ok) throw new Error(pulled.error);
  const full = workOrderFor(f.task(), order!.intent!, planned, boundRef(f.db, "T1", "author")!);
  expect(full).not.toBeNull();
  return { order: pulled.order, text: renderWorkOrder(full!), planned };
}

const PROBE = { peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true as const, head: H2 }) };
const QUERY = { peer: "mate", repo: "example/claudestra", base: "main" };

async function pooledOrder(f: F) {
  const branch = "lend/T1-abcd";
  setTask(f.db, f.at("pm"), { id: "T1", rev: f.task().rev, patch: { branch } });
  holdWriteLease(f.db, f.task(), { peer: QUERY.peer, repo: QUERY.repo, branch, fp: "abcd-ef01-2345-6789" }, 1000);
  const write = await writeMaterials(f.db, f.task(), QUERY, PROBE);
  expect(write).not.toBeNull();
  const order = offerLendCore(f.db, f.at("scheduler"), { taskId: "T1", peer: QUERY.peer, repo: QUERY.repo, family: "codex", pr: null,
    spec: "修复截图与代码审查问题", borrow: { peer: QUERY.peer, projects: ["p"], roles: ["write"], maxOpen: 2 }, write: write!,
  });
  const claimed = claimLend(f.db, f.at("owner"), QUERY.peer, { v: 1, orderId: order.orderId, worker: "agent-lend-0123456789" },
    () => ({ peer: QUERY.peer, projects: ["p"], roles: ["write"], maxOpen: 2 }));
  expect(claimed).toMatchObject({ order: order.wire });
  return order;
}

describe("UI fix orders share their rejection source and combined evidence", () => {
  for (const code of [false, true]) for (const paused of [false, true]) {
    test(`local + pooled: screenshot ${code ? "and code P1" : "only"}, paused=${paused}`, async () => {
      const f = autoFixture({ template: "ui" });
      try {
        await toReview(f, code ? [P1, P2] : []);
        await reject(f);
        expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
        const binding = { round: f.task().round, specRev: f.task().specRev, headSHA: f.task().headSHA };
        if (paused) { await pause(f); await pause(f); }
        expect(f.task()).toMatchObject(binding);
        const source = `台账事件 #${snapshot(f).pmUiGate!.seq}`;
        const { order, text, planned } = await localOrder(f);
        expect(order.findings).toEqual(planned.workOrder!.findings);
        expect(order.findings).toHaveLength(code ? 3 : 1);
        for (const contents of [text, JSON.stringify(order)]) {
          for (const value of [NOTE, source, ...(code ? [P1.probe, P1.findingId, P2.probe, reportPath(f)] : [])]) expect(contents).toContain(value);
        }
        if (!code) unlinkSync(reportPath(f)); // A passed report is not required to fix screenshots.
        const pooled = await pooledOrder(f);
        expect(pooled.wire.findings).toEqual(order.findings);
        for (const contents of [pooled.text, pooled.wire.inputs.join("\n")]) {
          for (const value of [NOTE, source, ...(code ? ["代码审查", "需保留互斥", "code-review.md"] : [])]) expect(contents).toContain(value);
        }
        if (code) expect(pooled.text).toContain(P1.probe);
      } finally { f.close(); }
    });
  }

  for (const template of ["ui", "code"] as const) {
    test(`code P1 only is unchanged (${template})`, async () => {
      const f = autoFixture({ template });
      try {
        await toReview(f, [P1, P2]);
        expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
        const { order, text } = await localOrder(f);
        expect(order.findings).toEqual([P1, P2]);
        expect(text).toContain(reportPath(f));
        expect(text).not.toContain("ui_screenshot");
        const pooled = await pooledOrder(f);
        expect(pooled.wire.findings).toEqual([P1, P2]);
        expect(pooled.wire.inputs.join("\n")).toContain(CODE_REPORT);
      } finally { f.close(); }
    });
  }

  test("a fixer already dispatched before the pause can take the screenshot instructions again", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toReview(f, []);
      await reject(f);
      await f.tick();
      const first = await localOrder(f);
      await pause(f);
      const [order] = currentOrders(f.db, { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" });
      const pulled = orderWireFor(f.db, order!);
      expect(pulled).toMatchObject({ ok: true, order: { findings: first.order.findings, inputs: first.order.inputs } });
      expect(await f.tick()).not.toMatchObject({ step: "manual" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("combined pooled order refuses a missing code report instead of dropping code evidence", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toReview(f, [P1]);
      await reject(f);
      await f.tick();
      unlinkSync(reportPath(f));
      await expect(writeMaterials(f.db, f.task(), QUERY, PROBE)).rejects.toThrow("找不到上一轮审查报告原文");
    } finally { f.close(); }
  });

  test("round/specRev and the original review→fix source stay mandatory across pauses", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toReview(f, []);
      await reject(f);
      await f.tick();
      await pause(f);
      const s = snapshot(f);
      expect(uiRejectFix(s)?.findings[0].probe).toBe(NOTE);
      for (const key of ["round", "specRev"] as const) {
        expect(uiRejectFix({ ...s, pmUiGate: { ...s.pmUiGate!, [key]: s.task[key] + 1 } })).toBeNull();
        const events = s.events.map((e) => e.kind === "stage" && e.data.from === "review" && e.data.to === "fix"
          ? { ...e, data: { ...e.data, [key]: s.task[key] + 1 } } : e);
        expect(uiRejectFix({ ...s, events })).toBeNull();
      }
      const entered = s.events.findLast((e) => e.kind === "stage" && e.data.from === "review" && e.data.to === "fix")!;
      expect(uiRejectFix({ ...s, pmUiGate: { ...s.pmUiGate!, seq: entered.seq + 1 } })).toBeNull();
      for (const from of ["merge", "live", "blocked"]) {
        const events = s.events.map((e) => e.seq === entered.seq ? { ...e, data: { ...e.data, from } } : e);
        expect(uiRejectFix({ ...s, events })).toBeNull();
      }
      const events = s.events.filter((e) => !(e.kind === "stage" && e.data.to === "blocked"));
      expect(uiRejectFix({ ...s, events })).toBeNull();
      expect(uiRejectFix({ ...s, task: { ...s.task, headSHA: "3".repeat(40) }, screenshotsDigest: "e".repeat(64) })?.findings[0].probe).toBe(NOTE);
    } finally { f.close(); }
  });

  for (const sameFinding of [true, false]) test(`PM rejection preserves code P1 fallback and streak limit (same finding=${sameFinding})`, async () => {
    const f = autoFixture({ template: "ui" });
    const limit = sameFinding ? 3 : 4;
    const finding = (round: number) => sameFinding ? P1 : { ...P1, findingId: `race-${round}`, family: `family${round}` };
    try {
      await toReview(f, [finding(1)]);
      for (let round = 1; round <= limit; round++) {
        await reject(f);
        // PM can push the rejected card to fix even when automatic review progression would escalate.
        expect(await f.cli("pm", "stage", "T1", "--from", "review", "--to", "fix")).toMatchObject({ ok: true });
        const plan = planScheduler(snapshot(f));
        if (round === limit) {
          expect(plan).toMatchObject({ kind: "escalate", code: "fix_history" });
          break;
        }
        const { planned } = await localOrder(f);
        expect(planned.workOrder!.fallbackWarning).toBe(round === limit - 1 ? "再不行退到：只报错不修" : null);
        const head = String(round + 3).repeat(40);
        expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", head)).toMatchObject({ ok: true });
        await f.tick();
        await review(f, [finding(round + 1)], head);
      }
    } finally { f.close(); }
  });
});
