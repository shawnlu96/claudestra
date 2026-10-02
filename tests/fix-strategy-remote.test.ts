import { expect, test } from "bun:test";
import { fourRoundFix, repeatedFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor, hello } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendDeliver } from "../src/lib/ledger-lend-result.js";
import { resultDeps } from "./fix-strategy-remote-helpers.js";
import type { DeliverRequest } from "../src/lib/lend-wire.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { workerName } from "../src/lib/lend-drive.js";
import { listEvents } from "../src/lib/ledger-store.js";

test("family swap after local family refusal goes to the capable peer on the card branch, carrying reports/diff/probes", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan();
    p.deps.localFamilyWait = () => "本机不接codex";
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "pooled" });
    const order = remoteOrder(f.db, intent.id)!;
    expect(order.family).toBe("codex"); expect(order.branch).toBe("feat/T1");
    expect(heldLease(f.db, f.task())).toMatchObject({ peer: "Peer", branch: "feat/T1", state: "held" });
    const inputs = order.wire.inputs.join("\n");
    for (const material of ["original report", "repair diff", "two ticks claim"]) expect(inputs).toContain(material);
    expect(order.wire.acceptance.join("\n")).toContain("先把复现写成测试");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(f.db.query("SELECT COUNT(*) n FROM lend_orders").get()).toMatchObject({ n: 1 });
    expect(getIntent(f.db, intent.id)?.status).toBe("submitted");
    expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
  } finally { f.close(); }
});

test("full local Codex slots transfer rather than create another local worker", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan();
    p.edit((r) => { for (let n = 0; n < 6; n++) r.agents[`agent-busy-${n}`] = { runtime: "codex", status: "active", sessionId: `busy-${n}` }; });
    for (let n = 0; n < 6; n++) f.db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt)
      VALUES (?, 'p', 'busy', 'code', 'build', ?, 0, 0)`).run(`busy-${n}`, `agent-busy-${n}`);
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "pooled" });
    expect(remoteOrder(f.db, intent.id)?.family).toBe("codex");
  } finally { f.close(); }
});

test("no target family waits with every machine reason, and a failed PM send retries before successful-send dedup", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f, ["Old", "Full"]), intent = p.plan();
    hello(f, "Old", 2); hello(f, "Full", 3, { codex: 0, claude: 0 });
    p.deps.localFamilyWait = () => "本机不接codex";
    let tries = 0;
    p.context.notify = async (text) => { if (++tries === 1) throw new Error("offline"); p.notices.push(text); };
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    for (let n = 0; n < 3; n++) {
      const result = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      expect(result.detail).toContain("Old：proto 2"); expect(result.detail).toContain("Full：");
    }
    expect(tries).toBe(2); expect(p.notices.length).toBe(1); expect(heldLease(f.db, f.task())).toBeNull();
  } finally { f.close(); }
});

test("peer author two-round repair returns a new order to its holder; original worker/session cannot be reused", async () => {
  const f = await repeatedFix();
  try {
    const p = remoteProbe(f); peerAuthor(f); const intent = p.plan();
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "pooled" });
    const o = remoteOrder(f.db, intent.id)!;
    expect(o.peer).toBe("Peer"); expect(o.family).toBe("codex");
    const worker = workerName(o.orderId);
    expect(worker).not.toBe(workerName("prior-order")); expect(worker).not.toBe("old-worker");
    claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker }, () => p.context.borrow[0]);
    expect(remoteOrder(f.db, intent.id)?.worker).toBe(worker);
    expect(p.effects).toEqual([]);
  } finally { f.close(); }
});

test("Codex author cannot swap to Claude when neither machine lends that family; lease reclaim does not secretly open local Claude", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f); peerAuthor(f); const intent = p.plan();
    p.deps.localFamilyWait = (_t, family) => family === "claude" ? "本机不接claude" : null;
    const result = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(result).toMatchObject({ step: "waiting" }); expect(result.detail).toContain("claude");
    expect(remoteOrder(f.db, intent.id)).toBeNull(); expect(p.effects).toEqual([]); expect(p.notices.length).toBe(1);
    expect(f.task()).toMatchObject({ assigneeKind: "agent", assignee: "agent-task-one", agent: "agent-task-one" });
    expect(getIntent(f.db, intent.id)?.taskRev).toBe(f.task().rev);
    expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "fix_strategy_reclaim")).toBe(true);
  } finally { f.close(); }
});

test("remote card-branch delivery atomically advances the head and closes its old-head intent, retaining the actual new peer session", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    const o = remoteOrder(f.db, intent.id)!, worker = workerName(o.orderId);
    claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker }, () => p.context.borrow[0]);
    const head = "5".repeat(40), req: DeliverRequest = { v: 1, orderId: o.orderId, gen: 1, branch: "feat/T1", pr: 7,
      session: { id: "new-peer-session", family: "codex" }, deliver: { v: 1, orderId: o.orderId, head, evidence: "report.md",
        summary: "复现测试：remote-race，先红后绿", selfCheck: "Assertion failed before the fix and passed after it." } };
    const deps = { ...resultDeps, peerFp: async () => "abcd-bbbb-cccc-dddd", remoteHead: async () => ({ ok: true as const, head }) };
    const receipt = await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "delivery-body", deps);
    expect(f.task()).toMatchObject({ stage: "review", headSHA: head, branch: "feat/T1" });
    expect(getIntent(f.db, intent.id)?.status).toBe("done"); expect(remoteOrder(f.db, intent.id)?.status).toBe("done");
    expect(getSchedulerSession(f.db, "T1", "author")).toMatchObject({ transport: "peer", family: "codex", sessionId: "new-peer-session" });
    expect(await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "delivery-body", deps)).toEqual(receipt);
  } finally { f.close(); }
});

test("material transfer never shortens an arbitrary hexadecimal secret to evade the existing peer gate", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
    p.deps.readReport = async () => "credential 0123456789abcdef0123456789abcdef01234567";
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow();
    expect(remoteOrder(f.db, intent.id)).toBeNull(); expect(heldLease(f.db, f.task())).toBeNull();
  } finally { f.close(); }
});

for (const peers of [["Peer"], []]) {
  test(`zero-slot repair through CLI registration ${peers.length ? "transfers to peer" : "waits"} without creating a local worker`, async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f, peers), intent = p.plan();
      expect(await f.cli("scheduler", "scheduler-convergence", intent.id, "--max-workers", "0")).toMatchObject({ ok: true, step: "waiting" });
      const result = await f.cli("scheduler", "scheduler-convergence", intent.id, "--max-workers", "0");
      expect(result).toMatchObject({ ok: true, step: peers.length ? "pooled" : "waiting" });
      expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
      expect(!!remoteOrder(f.db, intent.id)).toBe(!!peers.length);
    } finally { f.close(); }
  });
}
