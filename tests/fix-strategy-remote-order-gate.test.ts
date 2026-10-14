import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { offerConvergence } from "../src/lib/fix-strategy-remote-order.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { gateRefusalFacts } from "../src/lib/scheduler-dispatch-block.js";
import { FIX_LOCAL_SWAP_WAIT_MS } from "../src/lib/recovery-fix-local-swap.js";
import { hello } from "./fix-strategy-remote-helpers.js";
import { BRANCH, CLEAN, CLAUDE_BUSY, leaked, swapFixture, toFix } from "./recovery-fix-local-swap-fixture.js";

test("GATESWAP2: remote convergence refusal is fixLocalSwap gate source, not peer capacity", async () => {
  const p = await swapFixture({ mode: "observe" });
  try {
    await toFix(p, CLEAN);
    p.context.spec = leaked();
    writeFileSync(p.f.task().spec!, p.context.spec);
    hello(p.f, "mate", 3, { claude: 2, codex: 0 });
    const task = p.f.task(), events = p.events();
    const plan = (id: string) => planIntent(p.f.db, p.f.at("scheduler"), { id, taskId: task.id, taskRev: p.f.task().rev,
      workflowRev: getWorkflow(p.f.db, task.id)!.rev, causalSeq: p.events().at(-1)!.seq, node: "fix", action: "fix_swap", reason: "换会话" }).intent;
    let intent = plan("convergence-gate-1");
    const offer = () => offerConvergence(p.f.db, p.f.at("scheduler"), intent, p.context, "mate", "claude", (current, orderId) =>
      writeOrderWire(current, { orderId, step: "fix", head: current.headSHA!, branch: BRANCH, base: "main",
        spec: p.context.spec!, report: CLEAN, findings: [], repo: "o/r", pr: 7 }));
    expect(offer).toThrow("peer 外发拒绝优先");
    expect(offer).toThrow("peer 外发拒绝优先");
    const refused = p.events().filter((e) => e.data.op === "gate_refused");
    expect(refused).toHaveLength(1);
    expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
    p.f.advance(FIX_LOCAL_SWAP_WAIT_MS);
    p.hello(CLAUDE_BUSY);
    const snapshot = autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(),
      pool: { remote: p.remote, borrow: p.borrow } });
    expect(snapshot.localSwap).toMatchObject({ ripe: true, candidate: { source: "gate", since: refused[0]!.ts, sinceSeq: refused[0]!.seq } });
    expect(refused[0]!.data).toMatchObject(gateRefusalFacts(task, events, intent.id, p.context.spec));
    expect(refused[0]!.data).toMatchObject({ window: expect.any(Number), round: task.round, material: expect.any(String), intentId: intent.id });
    settleIntent(p.f.db, p.f.at("scheduler"), { id: intent.id, from: "pending", to: "cancelled", receipt: "材料修订后重挂" });
    p.context.spec += "\n补充验收说明";
    writeFileSync(task.spec!, p.context.spec);
    hello(p.f, "mate", 3, { claude: 2, codex: 0 });
    intent = plan("convergence-gate-2");
    expect(offer).toThrow("peer 外发拒绝优先");
    expect(offer).toThrow("peer 外发拒绝优先");
    const next = p.events().filter((e) => e.data.op === "gate_refused");
    expect(next).toHaveLength(2);
    expect(next[1]!.data.intentId).toBe(intent.id);
    expect(next[1]!.data.material).not.toBe(next[0]!.data.material);
    expect(next[0]!.data).toEqual(refused[0]!.data);
  } finally { p.f.close(); }
});
