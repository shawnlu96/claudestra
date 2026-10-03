import { expect, test } from "bun:test";
import { arbiterBinding, arbiterOrder, arbiterStep, recordArbitration } from "../src/lib/review-arbiter-runtime.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { parseDeliverWire } from "../src/lib/order-wire.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { P1 } from "./scheduler-auto-helpers.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";

const HEAD = "3".repeat(40);

for (const verdict of ["upheld", "overturned"] as const) {
  test(`${verdict} arbitration runs in a new cross-family session, changes the actual merge gate and retires its context`, async () => {
    const f = await repeatedFix();
    try {
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", HEAD,
        "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "probe has no failing assertion" }]))).toMatchObject({ ok: true });
      await f.tick();
      expect(await f.review("changes", HEAD, [P1])).toMatchObject({ ok: true });
      const p = convergenceProbe(f), intent = p.plan();
      expect(intent.action).toBe("arbitrate");
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "ready" });
      const ref = arbiterBinding(f.db, intent.id)!;
      expect(ref.family).toBe("codex");
      expect(ref.sessionId).not.toBe("s-rv");
      expect(ref.agent).not.toBe("agent-task-one");
      expect(getSchedulerSession(f.db, "T1", "reviewer")?.sessionId).toBe("s-rv");
      const order = arbiterOrder(f.db, intent.id);
      expect(order.inputs.join("\n")).toContain("probe has no failing assertion");
      expect(order.writeBack).toContain("scheduler-arbiter-verdict");
      expect(() => recordArbitration(f.db, f.at("agent-task-one"), intent.id, verdict, HEAD, "report.md",
        { session: "s-one", registryPath: f.registryPath, reportText: "report", gitHead: () => HEAD, gitDirty: () => null })).toThrow();
      recordArbitration(f.db, f.at(ref.agent), intent.id, verdict, HEAD, "report.md",
        { session: ref.sessionId, registryPath: f.registryPath, reportText: "report", gitHead: () => HEAD, gitDirty: () => null });
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "waiting" });
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "arbitrated" });
      const read = currentReviewFacts(f.task(), listEvents(f.db, { project: "p", target: "T1" }));
      expect(read.kind === "facts" && read.facts.findings.length).toBe(verdict === "upheld" ? 1 : 0);
      const stage = p.plan();
      expect(await f.cli("scheduler", "scheduler-stage", stage.id, "--to", verdict === "upheld" ? "fix" : "merge", "--max-workers", "2")).toMatchObject({ ok: true });
      if (verdict === "overturned") expect(p.plan().action).toBe("merge");
      else expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", "4".repeat(40),
        "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "again" }]))).toMatchObject({ ok: false, code: "conflict" });
    } finally { f.close(); }
  });
}

test("deliver wire accepts disputes and refuses malformed values while old payloads stay identical", () => {
  const wire = { v: 1 as const, orderId: "order", head: HEAD, evidence: "/report.md", summary: "done", selfCheck: "checked" };
  expect(parseDeliverWire(wire)).toEqual({ ok: true, value: wire });
  expect(parseDeliverWire({ ...wire, disputes: [{ findingId: "x", reason: "why" }] })).toMatchObject({ ok: true });
  expect(parseDeliverWire({ ...wire, disputes: [{ findingId: "x", reason: "x".repeat(1001) }] }).ok).toBe(false);
});

test("an arbitration send claimed before a crash becomes unknown and is never sent again", async () => {
  const f = await repeatedFix();
  try {
    await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", HEAD,
      "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "not reproducible" }]));
    await f.tick(); await f.review("changes", HEAD, [P1]);
    const p = convergenceProbe(f), intent = p.plan();
    await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
    expect(await f.cli("scheduler", "scheduler-arbiter-delivery", intent.id, "--phase", "sending")).toMatchObject({ ok: true });
    const before = f.sent.length;
    const deps = { ...f.tickDeps, manager: async (...args: string[]) => args[1] === "scheduler-convergence"
      ? arbiterStep(f.db, f.at("scheduler"), args[2], 2, p.deps) : f.cli("scheduler", ...args.slice(1)) };
    const result = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, deps);
    expect(result.failed).toEqual([]);
    expect(result.cards[0]).toMatchObject({ step: "held", detail: "仲裁发送结果不明，不重复投递" });
    expect(getIntent(f.db, intent.id)?.status).toBe("unknown");
    await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, deps);
    expect(f.sent.length).toBe(before);
  } finally { f.close(); }
});
