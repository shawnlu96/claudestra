/**
 * GATESWAP1 acceptance 1–3 on a real temp ledger, through the scheduler tick only (tests/recovery-fix-local-swap-fixture.ts): the
 * CIRES1 shape (peer Claude head, valid round-1 P1, fix refused by the outbound gate, local Codex with a positive quota proof) and the
 * slotless fixed peer are taken over once after 30 minutes through CONV2, and round 2 goes to a Claude reviewer; observe / off hold.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { recordGateRefused } from "../src/lib/order-gate-heads.js";
import { FIX_LOCAL_SWAP_WAIT_MS } from "../src/lib/recovery-fix-local-swap.js";
import { BRANCH, CLAUDE_BUSY, CLEAN, H3, leaked, MIN, swapFixture, toFix, type Sx } from "./recovery-fix-local-swap-fixture.js";

const N = FIX_LOCAL_SWAP_WAIT_MS;
const creates = (p: Sx) => p.probe.effects.filter((e) => e.startsWith("create:"));
const reclaims = (p: Sx) => p.events().filter((e) => e.data.op === "fix_strategy_reclaim");
const author = (p: Sx) => p.f.db.query("SELECT agent, sessionId, family FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author' AND state = 'active'")
  .get() as { agent: string; sessionId: string; family: string } | null;

/** Refused fix at round 1; returns the fixture with the refusal recorded. */
async function refused(mode: "on" | "observe" | "off" = "on") {
  const p = await swapFixture({ mode });
  const report = leaked();
  await toFix(p, report);
  expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("外发闸") });
  return { p, report };
}

/** Drive past the threshold in steps; returns the outcomes. */
async function pass(p: Sx, total: number, step = 10 * MIN, slots?: Parameters<Sx["later"]>[1]) {
  const out = [];
  for (let t = 0; t < total; t += step) out.push(await p.later(step, slots));
  return out;
}

/** The local author delivers H3; the card enters round 2 review. */
async function deliverLocal(p: Sx) {
  const a = author(p)!;
  p.heads[BRANCH] = { ok: true, head: H3 };
  expect(await p.f.cliWith({ callerSession: a.sessionId }, a.agent, "deliver", "T1", "--from", "fix", "--head", H3,
    "--text", "复现测试：two-ticks-claim，先红后绿")).toMatchObject({ ok: true });
  for (let i = 0; i < 4; i++) await p.later(MIN);
}

describe("acceptance 1: CIRES1 — gate-refused fix, local Codex takes over through CONV2, round 2 is reviewed by Claude", () => {
  test("waits below N, then exactly one reclaim + one local Codex author with the original report, then a Claude review of H3", async () => {
    const { p, report } = await refused();
    try {
      await pass(p, N - 2 * MIN, 7 * MIN);
      expect(p.swaps()).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      await pass(p, 6 * MIN, MIN);
      expect(p.swaps()).toEqual([expect.objectContaining({ id: expect.stringMatching(/^fix-local-swap:/), status: "done" })]);
      expect(heldLease(p.f.db, p.f.task())).toBeNull();
      expect(reclaims(p)).toHaveLength(1);
      expect(reclaims(p)[0]!.data).toMatchObject({ peer: "mate", family: "codex", source: "gate", round: 1 });
      expect(creates(p)).toHaveLength(1);
      expect(author(p)).toMatchObject({ family: "codex" });
      // the original report text, byte for byte, sits in the frozen fix material; nothing went out again
      const material = p.events().find((e) => e.data.op === "convergence_effect" && e.data.localSwap)!;
      expect(readFileSync(String(material.data.material), "utf8")).toContain(report);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(p.f.sent.at(-1)).toMatchObject({ agent: author(p)!.agent, route: "acp" });
      await pass(p, 20 * MIN, 5 * MIN);
      expect(creates(p)).toHaveLength(1); expect(reclaims(p)).toHaveLength(1);
      await deliverLocal(p);
      expect(p.f.task()).toMatchObject({ stage: "review", round: 2, headSHA: H3 });
      expect(p.swapEffects).toEqual(["archive:agent-rv-t1", "kill:agent-rv-t1"]); // the Codex reviewer of round 1 is retired, not reused
      const review = p.orders().filter((o) => o.step === "review" && o.head === H3);
      expect(review).toEqual([expect.objectContaining({ family: "claude" })]);
      expect(getWorkflow(p.f.db, "T1")).toMatchObject({ mode: "auto", authorFamily: "codex" });
    } finally { p.f.close(); }
  });
});

describe("acceptance 2: the fixed peer has no Claude slot — same chain without any gate refusal", () => {
  test("clock starts at the first structured wait, survives a restart, acts once after N and never before", async () => {
    const p = await swapFixture();
    try {
      await toFix(p, CLEAN);
      await p.later(MIN, CLAUDE_BUSY);
      expect(p.events().some((e) => e.data.op === "gate_refused")).toBe(false);
      const start = p.observes().filter((e) => e.data.stretch === "start");
      expect(start).toHaveLength(1);
      await pass(p, 15 * MIN, 5 * MIN, CLAUDE_BUSY);
      p.restart();
      await pass(p, 12 * MIN, 4 * MIN, CLAUDE_BUSY);
      expect(p.swaps()).toEqual([]);
      expect(p.observes().filter((e) => e.data.stretch === "start")).toHaveLength(1); // the restart did not reset the clock
      await pass(p, 8 * MIN, MIN, CLAUDE_BUSY);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]);
      expect(reclaims(p)[0]!.data).toMatchObject({ source: "peer_slot", peer: "mate" });
      expect(creates(p)).toHaveLength(1);
      await pass(p, 10 * MIN, 5 * MIN, CLAUDE_BUSY);
      expect(p.swaps()).toHaveLength(1); expect(creates(p)).toHaveLength(1);
      await deliverLocal(p);
      p.hello();
      for (let i = 0; i < 2; i++) await p.later(MIN);
      expect(p.orders().filter((o) => o.step === "review" && o.head === H3)).toEqual([expect.objectContaining({ family: "claude" })]);
    } finally { p.f.close(); }
  });

  test("a stretch that ends (the peer frees a slot) restarts the clock instead of counting the old start", async () => {
    const p = await swapFixture();
    try {
      await toFix(p, CLEAN);
      await pass(p, 20 * MIN, 5 * MIN, CLAUDE_BUSY);
      p.hello(); // mate frees a Claude slot: the fix goes back to it and the stretch ends
      await p.tick();
      expect(p.orders().filter((o) => o.step === "fix")).toHaveLength(1);
      expect(p.observes().filter((e) => e.data.stretch === "end")).toHaveLength(1);
      expect(p.swaps()).toEqual([]);
    } finally { p.f.close(); }
  });
});

describe("acceptance 3: observe and off hold every effect", () => {
  test("observe: one deduplicated observation, no lease / mode / assignee / intent / session / send change", async () => {
    const { p } = await refused("observe");
    try {
      const before = { task: p.f.task(), sent: p.f.sent.length, orders: p.orders().length };
      await pass(p, N + 20 * MIN, 5 * MIN);
      p.restart();
      await pass(p, 10 * MIN, 5 * MIN);
      const notes = p.observes().filter((e) => String(e.data.actionKey).startsWith("take:"));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.data.evidence).toMatchObject({ source: "gate", family: "codex", fromFamily: "claude", peer: "mate" });
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      expect(p.f.task()).toMatchObject({ assignee: before.task.assignee, assigneeKind: before.task.assigneeKind, agent: null });
      expect(getWorkflow(p.f.db, "T1")?.mode).toBe("auto");
      expect(p.swaps()).toEqual([]); expect(p.probe.effects).toEqual([]); expect(p.swapEffects).toEqual([]);
      expect(p.f.sent.length).toBe(before.sent); expect(p.orders().length).toBe(before.orders);
    } finally { p.f.close(); }
  });

  test("off: no observation and no action", async () => {
    const { p } = await refused("off");
    try {
      await pass(p, N + 20 * MIN, 5 * MIN);
      expect(p.observes()).toEqual([]); expect(p.swaps()).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
    } finally { p.f.close(); }
  });

  for (const to of ["observe", "off"] as const) {
    test(`on → ${to} mid-chain stops before the next effect and keeps the receipts already written`, async () => {
      const { p } = await refused();
      try {
        await pass(p, N + MIN, N + MIN); // one pass: plan, materials, reclaim, claim, archive of the old local author
        expect(reclaims(p)).toHaveLength(1);
        expect(p.probe.effects).toEqual(["archive:agent-task-one"]);
        p.state.mode = to;
        const r = await p.later(MIN);
        expect(r.detail).toContain(`已切到 ${to}`);
        await pass(p, 5 * MIN, MIN);
        expect(p.probe.effects).toEqual(["archive:agent-task-one"]);
        expect(reclaims(p)).toHaveLength(1);
        expect(p.orders().filter((o) => o.step === "fix")).toEqual([]); // never sent out again
        p.state.mode = "on";
        await pass(p, 3 * MIN, MIN);
        expect(creates(p)).toHaveLength(1); expect(reclaims(p)).toHaveLength(1);
      } finally { p.f.close(); }
    });
  }
});

describe("PM 定值 5: a review order the gate refused, with no local slot of the needed family, is told to PM once per card and round", () => {
  for (const mode of ["on", "observe"] as const) {
    test(`${mode}: ${mode === "on" ? "one notice naming card, round, family and local room" : "one note, no notice"}; never a same-family review`, async () => {
      const { p } = await refused();
      try {
        await pass(p, N + 5 * MIN, MIN);
        p.remote.agents = { claude: 0, codex: 1 }; // no local Claude reviewer; mate is busy too
        const a = author(p)!;
        p.heads[BRANCH] = { ok: true, head: H3 };
        expect(await p.f.cliWith({ callerSession: a.sessionId }, a.agent, "deliver", "T1", "--from", "fix", "--head", H3,
          "--text", "复现测试：two-ticks-claim，先红后绿")).toMatchObject({ ok: true });
        await p.later(MIN, CLAUDE_BUSY);
        expect(p.f.task()).toMatchObject({ stage: "review", round: 2 });
        p.state.mode = mode;
        // the review offer refused by the gate (the same recorder the pool step uses)
        recordGateRefused(p.f.db, p.f.at("scheduler"), p.f.task(), "派单没过外发闸（审查单）");
        const before = p.notices.length;
        for (let i = 0; i < 4; i++) await p.later(5 * MIN, CLAUDE_BUSY);
        const told = p.notices.slice(before).filter((n) => n.includes("审查单被外发闸拒收"));
        expect(told).toHaveLength(mode === "on" ? 1 : 0);
        if (mode === "on") for (const part of ["T1", "第 2 轮", "claude"]) expect(told[0]).toContain(part);
        expect(p.observes().filter((e) => String(e.data.actionKey).startsWith("review-gate:"))).toHaveLength(1);
        expect(p.f.db.query("SELECT family FROM scheduler_sessions WHERE role = 'reviewer' AND state = 'active'").all()).not.toContainEqual({ family: "codex" });
      } finally { p.f.close(); }
    });
  }
});
