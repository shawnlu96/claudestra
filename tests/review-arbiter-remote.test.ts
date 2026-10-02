import { expect, test } from "bun:test";
import { arbitrationFixture, verdictRequest, resultDeps, hello } from "./fix-strategy-remote-helpers.js";
import { P1 } from "./scheduler-auto-helpers.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendResult } from "../src/lib/ledger-lend-result.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";


for (const verdict of ["upheld", "overturned"] as const) {
  test(`remote ${verdict} has the local event shape and next-round merge effect without replacing ordinary reviewer`, async () => {
    const { f, p, intent } = await arbitrationFixture();
    try {
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "pooled" });
      const o = remoteOrder(f.db, intent.id)!;
      expect(o.family).toBe("codex"); expect(o.wire.node).toBe("arbitration");
      claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
      expect(getSchedulerSession(f.db, "T1", "reviewer")?.sessionId).toBe("s-rv");
      const claimed = remoteOrder(f.db, intent.id)!, req = verdictRequest(claimed, verdict);
      writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same-body", resultDeps);
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "arbitrated" });
      expect(getIntent(f.db, intent.id)?.status).toBe("done");
      const events = listEvents(f.db, { project: "p", target: "T1" }), read = currentReviewFacts(f.task(), events);
      expect(read.kind === "facts" && read.facts.findings.length).toBe(verdict === "upheld" ? 1 : 0);
      expect(events.find((e) => e.data.op === "arbitration_result")).toMatchObject({ actor: "scheduler", kind: "scheduler",
        data: { intentId: intent.id, specRev: f.task().specRev, round: f.task().round, findingId: P1.findingId, verdict, reviewerFamily: "codex" } });
      const next = p.plan();
      expect(await f.cli("scheduler", "scheduler-stage", next.id, "--to", verdict === "upheld" ? "fix" : "merge", "--max-workers", "2"))
        .toMatchObject({ ok: true });
      if (verdict === "upheld") expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", "4".repeat(40),
        "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "again" }]))).toMatchObject({ ok: false, code: "conflict" });
      expect(p.effects).toEqual([]);
    } finally { f.close(); }
  });
}

test("arbitration gives reviewFirst priority over another capable peer, and falls back past unsupported old peers to local", async () => {
  const { f, p, intent } = await arbitrationFixture(["Other", "First"]);
  try {
    p.context.remote!.reviewFirst = ["First"];
    await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
    expect(remoteOrder(f.db, intent.id)?.peer).toBe("First");
  } finally { f.close(); }
  const local = await arbitrationFixture();
  try {
    hello(local.f, "Peer", 2);
    expect(await arbiterStep(local.f.db, local.f.at("scheduler"), local.intent.id, 2, local.p.deps)).toMatchObject({ step: "ready" });
    expect(remoteOrder(local.f.db, local.intent.id)).toBeNull();
  } finally { local.f.close(); }
});

test("remote arbitration works even when local review slots are full", async () => {
  const { f, p, intent } = await arbitrationFixture();
  try {
    expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 0, p.deps)).toMatchObject({ step: "pooled" });
    expect(remoteOrder(f.db, intent.id)?.peer).toBe("Peer");
  } finally { f.close(); }
});

for (const peers of [["Peer"], []]) {
  test(`zero-slot arbitration through CLI registration ${peers.length ? "offers a peer" : "waits without a local worker"}`, async () => {
    const { f, p, intent } = await arbitrationFixture(peers);
    try {
      expect(await f.cli("scheduler", "scheduler-convergence", intent.id, "--max-workers", "0"))
        .toMatchObject({ ok: true, step: peers.length ? "pooled" : "waiting" });
      expect(p.effects).toEqual([]); expect(!!remoteOrder(f.db, intent.id)).toBe(!!peers.length);
    } finally { f.close(); }
  });
}
