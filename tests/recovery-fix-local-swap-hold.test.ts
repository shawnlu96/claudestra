/**
 * GATESWAP1 acceptance 4–6, real tick on a temp ledger (tests/recovery-fix-local-swap-fixture.ts): one takeover per P1 and fix
 * window across repeated ticks / refusals / switch flaps / restarts / interrupted steps; every unsafe or unproven shape waits locally
 * without reclaiming or sending anything out; manual cards and leases without a provable source are never taken over.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { reclaimLend } from "../src/lib/ledger-lend.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { recordGateRefused } from "../src/lib/order-gate-heads.js";
import { FIX_LOCAL_SWAP_WAIT_MS } from "../src/lib/recovery-fix-local-swap.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { BRANCH, CLAUDE_BUSY, CLEAN, goodQuota, H3, leaked, MIN, swapFixture, toFix, type Sx } from "./recovery-fix-local-swap-fixture.js";

const N = FIX_LOCAL_SWAP_WAIT_MS;
const creates = (p: Sx) => p.probe.effects.filter((e) => e.startsWith("create:"));
const reclaims = (p: Sx) => p.events().filter((e) => e.data.op === "fix_strategy_reclaim");
const fixOrders = (p: Sx) => p.orders().filter((o) => o.step === "fix");

async function refused(mode: "on" | "observe" | "off" = "on", opts: { manualStallHours?: number } = {}) {
  const p = await swapFixture({ mode, ...opts });
  await toFix(p, leaked());
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  return p;
}
async function pass(p: Sx, total: number, step = 5 * MIN, slots?: Parameters<Sx["later"]>[1], repos?: string[]) {
  const out = [];
  for (let t = 0; t < total; t += step) out.push(await p.later(step, slots, repos));
  return out;
}
/** Nothing was taken: lease still at mate, no reclaim, no local session, no fix order out. */
const untouched = (p: Sx) => {
  expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
  expect(reclaims(p)).toEqual([]); expect(creates(p)).toEqual([]); expect(fixOrders(p)).toEqual([]);
};

describe("acceptance 4: one takeover per P1 and window", () => {
  test("a repeated refusal of the same material neither delays nor advances the clock; flaps and restarts add nothing", async () => {
    const p = await refused();
    try {
      await pass(p, 20 * MIN);
      // the same outbound material refused again (another offer of the same text): a repeat, not a new clock
      const first = p.events().findLast((e) => e.data.op === "gate_refused")!;
      recordGateRefused(p.f.db, p.f.at("scheduler"), p.f.task(), "派单没过外发闸（重复拒收）", { ...first.data, intentId: "repeat-offer" });
      expect(p.events().filter((e) => e.data.op === "gate_refused")).toHaveLength(2);
      p.state.mode = "off"; await p.later(MIN); p.state.mode = "on";
      await pass(p, 5 * MIN, MIN);
      expect(p.swaps()).toEqual([]);
      await pass(p, 6 * MIN, MIN);
      expect(p.swaps()).toHaveLength(1);
      p.restart();
      for (const m of ["observe", "off", "on"] as const) { p.state.mode = m; await p.later(MIN); }
      await pass(p, 15 * MIN);
      expect(p.swaps()).toHaveLength(1); expect(reclaims(p)).toHaveLength(1); expect(creates(p)).toHaveLength(1);
      expect(p.f.sent.filter((s) => s.agent.startsWith("agent-cv-"))).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("an interrupted chain (remote head unverifiable, then a lost create receipt) resumes on the same intent and receipts", async () => {
    const p = await refused();
    try {
      let flaky = 1;
      const real = p.context.remoteHead;
      p.context.remoteHead = async (repo, branch) => (flaky-- > 0 ? { ok: false as const, error: "network" } : real(repo, branch));
      await pass(p, N + MIN, N + MIN);
      expect(reclaims(p)).toEqual([]); expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      await pass(p, 6 * MIN, MIN);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]);
      expect(reclaims(p)).toHaveLength(1); expect(creates(p)).toHaveLength(1);
      expect(p.observes().filter((e) => String(e.data.actionKey).startsWith("take:"))).toEqual([]); // on never writes observe notes
    } finally { p.f.close(); }
  });
});

describe("acceptance 5: unsafe or unproven shapes wait locally and never go out", () => {
  const cases: [string, (p: Sx) => void][] = [
    ["quota unknown", (p) => { p.state.quota = { ...goodQuota(), status: "unknown", windows: [], reason: "no snapshot" }; }],
    ["quota stale (window without a reading)", (p) => { p.state.quota = { ...goodQuota(), windows: [{ ...goodQuota().windows[0]!, usedPct: null }] }; }],
    ["quota over the line", (p) => { p.state.quota = goodQuota(95); }],
    ["quota read failure", (p) => { p.state.quota = new Error("inventory down"); }],
    ["local Codex not authorized", (p) => { p.probe.deps.localFamilyWait = () => "本机不接 codex"; }],
    ["local writer slots full", (p) => { p.context.maxWorkers = 0; }],
  ];
  for (const [name, arrange] of cases) {
    test(`${name}: waits before reclaim with one journaled reason, nothing remote`, async () => {
      const p = await refused();
      try {
        arrange(p);
        await pass(p, N + 15 * MIN);
        untouched(p);
        const waits = p.events().filter((e) => e.data.op === "convergence_effect" && typeof e.data.reason === "string" && String(e.data.reason).includes("不外派"));
        expect(waits).toHaveLength(1);
        expect(getIntent(p.f.db, p.swaps()[0]!.id)?.status).toBe("pending");
      } finally { p.f.close(); }
    });
  }

  test("Codex not in this machine's runtime: no candidate at all", async () => {
    const p = await refused();
    try { p.remote.agents = { claude: 1, codex: 0 }; await pass(p, N + 10 * MIN); untouched(p); expect(p.swaps()).toEqual([]); }
    finally { p.f.close(); }
  });

  test("a file lock held by another card is not a slot wait and blocks the takeover", async () => {
    const p = await refused();
    try {
      p.f.db.run("PRAGMA foreign_keys = OFF");
      p.f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/lib/*', 'T9', 'other', 1, 'card')");
      await pass(p, N + 10 * MIN); untouched(p); expect(p.swaps()).toEqual([]);
    } finally { p.f.close(); }
  });

  test("the lease moved to another peer: not the head's writer, no takeover", async () => {
    const p = await refused();
    try { p.f.db.run("UPDATE lend_write_leases SET peer = 'other' WHERE taskId = 'T1'"); await pass(p, N + 10 * MIN); expect(p.swaps()).toEqual([]); expect(creates(p)).toEqual([]); }
    finally { p.f.close(); }
  });

  test("an old writer that never confirmed a clean stop keeps the lease and nothing is created", async () => {
    const p = await swapFixture();
    try {
      await toFix(p, CLEAN);
      p.f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
        status, worker, leaseGen, leaseUntil, leaseMs, createdBy, createdAt, updatedAt, branch, base)
        VALUES ('old-running', 'T1', 'p', 'mate', 'claude', 'fix', ?, ?, ?, 'o/r', '{}', '', '', 'claimed', 'w9', 1, 1e15, 10000, 'scheduler', 1, 1, ?, 'main')`)
        .run(p.f.task().specRev, p.f.task().round, p.f.task().headSHA!, BRANCH);
      await pass(p, N + 15 * MIN, 5 * MIN, CLAUDE_BUSY);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate"); expect(creates(p)).toEqual([]);
    } finally { p.f.close(); }
  });

  test("remote head drift: the lease is not reclaimed", async () => {
    const p = await refused();
    try { p.heads[BRANCH] = { ok: true, head: "9".repeat(40) }; await pass(p, N + 10 * MIN); untouched(p); }
    finally { p.f.close(); }
  });

  test("a dirty or foreign author tree goes to PM (intent unknown), never remote", async () => {
    const p = await refused();
    try {
      p.probe.deps.authorTree = async () => ({ manual: "目标目录有未提交改动" });
      await pass(p, N + 10 * MIN);
      expect(creates(p)).toEqual([]); expect(fixOrders(p)).toEqual([]);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "unknown" })]);
    } finally { p.f.close(); }
  });

  test("other fixed-peer waits (grant without this repo) are not 'no slot': no clock, no takeover", async () => {
    const p = await swapFixture();
    try {
      await toFix(p, CLEAN);
      await pass(p, N + 10 * MIN, 5 * MIN, CLAUDE_BUSY, ["x/y"]);
      expect(p.observes()).toEqual([]); expect(p.swaps()).toEqual([]); untouched(p);
    } finally { p.f.close(); }
  });

  test("a changed material (re-review) restarts the gate clock from its own refusal", async () => {
    const p = await refused();
    try {
      await pass(p, 20 * MIN);
      const path = join(p.f.dir, "report-r1b.md");
      writeFileSync(path, leaked());
      const last = p.events().filter((e) => e.kind === "review").at(-1)!;
      insertEvent(p.f.db, p.f.at("agent-rv-t1"), { project: "p", target: "T1", kind: "review", text: "本机复核", data: { ...last.data, path } }, true);
      expect(await p.later(MIN)).toMatchObject({ step: "pool_refused" });
      await pass(p, 15 * MIN);
      expect(p.swaps()).toEqual([]); untouched(p);
      await pass(p, 20 * MIN);
      expect(p.swaps()).toHaveLength(1);
    } finally { p.f.close(); }
  });
});

describe("acceptance 6: manual cards — owner threshold, fix stage, sticky holds; leases without a provable source", () => {
  /** The extension contract reads the file (manual-recovery-policy.ts): manualRecovery and fixLocalSwap both explicitly on. */
  const policyFile = (hours?: number) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: {
    ...(hours ? { manualStallHours: hours } : {}), keys: { manualRecovery: "on", fixLocalSwap: "on" } } } }));
  afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
  const toManual = async (p: Sx, reason = "write_lease_ended: 修复单外发被闸拒、租约方接不了，等本机接回") =>
    expect(await p.cli("pm", "workflow-set", "T1", "--rev", String(p.f.task().rev), "--workflow-rev", String(getWorkflow(p.f.db, "T1")!.rev),
      "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason", reason)).toMatchObject({ ok: true });
  const mode = (p: Sx) => getWorkflow(p.f.db, "T1")!.mode;

  for (const [name, hours, wait] of [["owner threshold unset", undefined, 3 * 3_600_000], ["threshold not reached", 4, 3 * 3_600_000]] as const) {
    test(`fix manual card, ${name}: stays manual, nothing taken`, async () => {
      const p = await refused("on", hours ? { manualStallHours: hours } : {});
      try {
        policyFile(hours); await toManual(p);
        await pass(p, wait, 30 * MIN);
        expect(mode(p)).toBe("manual"); untouched(p); expect(p.swaps()).toEqual([]);
      } finally { p.f.close(); }
    });
  }

  test("a PM takeover (sticky) or a build-stage manual card is never lifted, whatever the stall", async () => {
    const p = await refused("on", { manualStallHours: 1 });
    try {
      policyFile(1); await toManual(p, "pm_takeover: PM 手工接管");
      await pass(p, 3 * 3_600_000, 30 * MIN);
      expect(mode(p)).toBe("manual"); untouched(p);
    } finally { p.f.close(); }
    const b = await swapFixture({ manualStallHours: 1 });
    try {
      policyFile(1); await toManual(b, "write_lease_ended: 构建单租约方不可用");
      await pass(b, 3 * 3_600_000, 30 * MIN);
      expect(b.f.task().stage).toBe("build"); expect(mode(b)).toBe("manual");
    } finally { b.f.close(); }
  });

  test("authorized fix manual card: handed back past the owner threshold, local Codex fixes, Claude reviews round 2, then manual again", async () => {
    const p = await refused("on", { manualStallHours: 2 });
    try {
      policyFile(2); await toManual(p);
      await pass(p, 90 * MIN, 30 * MIN);
      expect(mode(p)).toBe("manual"); untouched(p);
      await pass(p, 60 * MIN, 30 * MIN);
      const resume = p.events().find((e) => e.data.op === "workflow_resume");
      expect(resume?.data.recoveryProof).toMatchObject({ mechanism: "fix-local-swap", round: 1 });
      await pass(p, 3 * MIN, MIN);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]); expect(creates(p)).toHaveLength(1);
      const a = p.f.db.query("SELECT agent, sessionId FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author' AND state = 'active'").get() as { agent: string; sessionId: string };
      p.heads[BRANCH] = { ok: true, head: H3 };
      expect(await p.f.cliWith({ callerSession: a.sessionId }, a.agent, "deliver", "T1", "--from", "fix", "--head", H3,
        "--text", "复现测试：two-ticks-claim，先红后绿")).toMatchObject({ ok: true });
      await pass(p, 4 * MIN, MIN, CLAUDE_BUSY); // mate has no Claude slot now: the round-2 review is local Claude
      expect(p.swapEffects).toContain("ensure:claude");
      const findings = join(p.f.dir, "none.json"); writeFileSync(findings, "[]");
      expect(await p.f.cliWith({ callerSession: "s-rv-claude" }, "agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass",
        "--p0", "0", "--p1", "0", "--p2", "0", "--head", H3, "--session", "s-rv-claude", "--family", "claude", "--findings", findings,
        "--path", join(p.f.dir, "r2.md"))).toMatchObject({ ok: true });
      await p.later(MIN, CLAUDE_BUSY);
      expect(mode(p)).toBe("manual");
      const back = p.events().findLast((e) => e.data.op === "fallback_manual")!;
      expect(back.data.manualReason).toMatchObject({ code: "write_lease_ended" });
      expect(p.f.task().stage).toBe("review"); // the stage move after the verdict is PM's again
    } finally { p.f.close(); }
  });

  test("a lease PM already reclaimed is not a candidate (first batch excludes them)", async () => {
    const p = await refused();
    try {
      reclaimLend(p.f.db, p.f.at("pm"), { taskId: "T1", reason: "PM 手工接回" });
      await pass(p, N + 10 * MIN);
      expect(p.swaps()).toEqual([]); expect(creates(p)).toEqual([]);
    } finally { p.f.close(); }
  });

  test("no lease row at all is no source proof: an empty lease never skips the source check", async () => {
    const p = await refused();
    try {
      p.f.db.run("DELETE FROM lend_write_leases WHERE taskId = 'T1'");
      await pass(p, N + 10 * MIN);
      expect(p.swaps()).toEqual([]); expect(creates(p)).toEqual([]); expect(fixOrders(p)).toEqual([]);
    } finally { p.f.close(); }
  });
});
