/**
 * i28-STALELEASE1 end to end (real ledger, scheduler tick, lend / pool CLI): mate's write order was withdrawn, this machine's
 * agent-task-one rebuilt and delivered the card on its own branch, review sent it to fix — and mate's write lease is still held.
 * on: the lease ends once, the fix goes to the original session (no new session, no peer intent, no probe of the old lend branch),
 * the next review is cross-model. observe: one sample per lease, nothing else changes. off: today's path. Blockers keep today's path.
 */
import { describe, expect, test } from "bun:test";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { STALE_LEASE_KEY, STALE_LEASE_OP } from "../src/lib/lend-local-continuity.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { authorRow, CARD_BRANCH, E2E_MS, LEND_BRANCH, ofOp, ready, toStaleFix, type P } from "./lend-local-continuity-helpers.js";

const H3 = "3".repeat(40);
const fixIntents = (p: P) => p.f.intents().filter((i) => i.node === "fix" && i.action === "dispatch");
const samples = (p: P) => ofOp(p, "recovery_observe").filter((e) => e.data.mechanism === STALE_LEASE_KEY);
const probedLendBranch = (p: P) => p.gh.some((a) => a[1]?.includes(LEND_BRANCH));

/** What today's path does with the stale lease: the fix is pooled back to mate and never reaches the local author. */
function todaysPath(p: P) {
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
  expect(fixIntents(p).some((i) => i.recipient === "agent-task-one")).toBe(false);
  expect(fixIntents(p).some((i) => i.recipient === "peer:mate")).toBe(true);
  expect(ofOp(p, STALE_LEASE_OP)).toEqual([]);
}

describe("staleLeaseHandover on: the original local author keeps the fix", () => {
  test("[验收线 1/2/5] lease ended once, fix dispatched to the original session, no peer fix intent, no lend-branch probe, review cross-model", async () => {
    const p = await ready("on");
    try {
      await toStaleFix(p);
      p.f.db.run("UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate', '$.keep', 'x') WHERE id = 'T1'");
      const before = { author: authorRow(p), ensured: p.f.ensured.length, agent: p.f.task().agent, assignee: [p.f.task().assigneeKind, p.f.task().assignee] };
      expect(await p.tick()).toMatchObject({ step: "replan", detail: expect.stringContaining("本机原作者接手") });
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "ended", reason: "本机原作者接手：agent-task-one" });
      expect(p.f.task().extra).toMatchObject({ keep: "x" });
      expect(p.f.task().extra.placement).toBeUndefined();
      for (let i = 0; i < 4; i++) await p.tick();
      const [handed] = ofOp(p, STALE_LEASE_OP);
      expect(ofOp(p, STALE_LEASE_OP)).toHaveLength(1);
      expect(handed.data).toMatchObject({ peer: "mate", agent: "agent-task-one", leaseBranch: LEND_BRANCH, branch: CARD_BRANCH, head: H2, unpin: true });
      expect(fixIntents(p).map((i) => [i.recipient, i.status])).toEqual([["agent-task-one", "done"]]);
      expect(p.f.sent.filter((s) => s.agent === "agent-task-one" && s.text.includes("fix"))).toHaveLength(1);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(probedLendBranch(p)).toBe(false);
      expect({ author: authorRow(p), ensured: p.f.ensured.length, agent: p.f.task().agent, assignee: [p.f.task().assigneeKind, p.f.task().assignee] }).toEqual(before);
      expect(ofOp(p, "recovery_observe").filter((e) => e.data.mechanism === "localFallback" && String(e.text).includes("family_switch"))).toEqual([]);
      // The fixed head goes to review by the other family (the bound Codex reviewer), as for any local card.
      expect(await p.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H3)).toMatchObject({ ok: true });
      for (let i = 0; i < 3; i++) await p.tick();
      const review = p.f.intents().filter((i) => i.action === "review").at(-1)!;
      expect(review).toMatchObject({ recipient: "agent-rv-t1", status: "done" });
      expect(p.f.db.query("SELECT family FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer'").get()).toEqual({ family: "codex" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 3] a live write order under the lease blocks: lease held, nothing dispatched here", async () => {
    const p = await ready("on");
    try {
      await toStaleFix(p);
      p.f.db.run("UPDATE lend_orders SET status = 'claimed' WHERE taskId = 'T1' AND step = 'write'");
      for (let i = 0; i < 2; i++) await p.tick();
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
      expect(ofOp(p, STALE_LEASE_OP)).toEqual([]);
      expect(fixIntents(p).some((i) => i.recipient === "agent-task-one")).toBe(false);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] the card's branch is the lease's lend branch (the peer's own line): the fix goes back to the lease holder as today", async () => {
    const p = await ready("on");
    try {
      await toStaleFix(p);
      p.f.db.run("UPDATE tasks SET branch = ? WHERE id = 'T1'", [LEND_BRANCH]);
      p.heads[LEND_BRANCH] = { ok: true, head: H2 };
      await p.tick();
      todaysPath(p);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("staleLeaseHandover observe / off", () => {
  test("[验收线 6] observe (default): one sample for the lease over several ticks, lease and dispatch exactly as off", async () => {
    const p = await ready("observe");
    try {
      await toStaleFix(p);
      await p.tick();
      await p.tick();
      expect(samples(p)).toHaveLength(1);
      expect(samples(p)[0].text).toContain("本来会结束 mate 的写租约，把 fix 派给 agent-task-one");
      todaysPath(p);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 6] off: nothing recorded, today's path", async () => {
    const p = await ready("off");
    try {
      await toStaleFix(p);
      await p.tick();
      await p.tick();
      expect(samples(p)).toEqual([]);
      todaysPath(p);
    } finally { p.f.close(); }
  }, E2E_MS);
});
