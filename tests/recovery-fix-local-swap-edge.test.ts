/**
 * GATESWAP1 round-1 review, real tick on a temp ledger (tests/recovery-fix-local-swap-fixture.ts): the fixLocalSwap switch is re-read at
 * the archive / kill / tree / create edges themselves; the trigger is re-read right before the reclaim's effects (not only across
 * ticks); a dirty or unpushed author tree refuses before any reclaim or retirement; a manual fix card inside the owner's grant keeps a
 * durable fixed-peer wait clock of its own, so the owner threshold can ever be met.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { FIX_LOCAL_SWAP_WAIT_MS } from "../src/lib/recovery-fix-local-swap.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { BRANCH, CLAUDE_BUSY, CLEAN, leaked, MIN, swapFixture, toFix, type Sx } from "./recovery-fix-local-swap-fixture.js";

const N = FIX_LOCAL_SWAP_WAIT_MS;
const creates = (p: Sx) => p.probe.effects.filter((e) => e.startsWith("create:"));
const reclaims = (p: Sx) => p.events().filter((e) => e.data.op === "fix_strategy_reclaim");
const waits = (p: Sx, part: string) => p.events().filter((e) => e.data.op === "convergence_effect" && String(e.data.reason ?? "").includes(part));

async function refused() {
  const p = await swapFixture();
  await toFix(p, leaked());
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  return p;
}
async function pass(p: Sx, total: number, step = 5 * MIN, slots?: Parameters<Sx["later"]>[1]) {
  const out = [];
  for (let t = 0; t < total; t += step) out.push(await p.later(step, slots));
  return out;
}
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

describe("policy-edge: the switch is re-read at the archive / tree / create edges, not only around the chain", () => {
  test("off while the inventory is awaited: the old local author is not archived; on again resumes the same chain", async () => {
    const p = await refused();
    try {
      const agents = p.probe.deps.agents;
      let trip = true;
      p.probe.deps.agents = async () => { const r = await agents(); if (trip) { trip = false; p.state.mode = "off"; } return r; };
      await pass(p, N + MIN, N + MIN);
      expect(trip).toBe(false);
      expect(reclaims(p)).toHaveLength(1); // the reclaim ran under on; the archive edge is after the awaited inventory
      expect(p.probe.effects).toEqual([]);
      await pass(p, 3 * MIN, MIN);
      expect(p.probe.effects).toEqual([]);
      p.state.mode = "on";
      await pass(p, 4 * MIN, MIN);
      expect(p.probe.effects.filter((e) => e.startsWith("archive:"))).toHaveLength(1);
      expect(creates(p)).toHaveLength(1); expect(reclaims(p)).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("off while the author tree is awaited: no create; observe before the tree: no tree at all", async () => {
    const p = await refused();
    try {
      await pass(p, N + MIN, N + MIN);
      expect(p.probe.effects).toEqual(["archive:agent-task-one"]);
      const tree = p.probe.deps.authorTree!;
      p.probe.deps.authorTree = async (...a) => { p.state.mode = "off"; return tree(...a); };
      await p.later(MIN);
      expect(p.probe.effects.some((e) => e.startsWith("tree:"))).toBe(true);
      expect(creates(p)).toEqual([]);
      expect(waits(p, "已切到 off").length).toBeGreaterThan(0);
      p.probe.deps.authorTree = tree;
      p.state.mode = "observe";
      const trees = p.probe.effects.filter((e) => e.startsWith("tree:")).length;
      await pass(p, 3 * MIN, MIN);
      expect(p.probe.effects.filter((e) => e.startsWith("tree:"))).toHaveLength(trees);
      expect(creates(p)).toEqual([]);
      p.state.mode = "on";
      await pass(p, 3 * MIN, MIN);
      expect(creates(p)).toHaveLength(1);
    } finally { p.f.close(); }
  });
});

describe("trigger-expired: the reclaim re-reads the same trigger after its awaits", () => {
  test("peer_slot: mate frees a Claude slot while the remote head is read — no reclaim, no retirement", async () => {
    const p = await swapFixture();
    try {
      await toFix(p, CLEAN);
      const real = p.context.remoteHead;
      let trip = false, tripped = false;
      p.context.remoteHead = async (repo, branch) => {
        const h = await real(repo, branch);
        if (trip && !tripped) { tripped = true; p.hello(); } // a normal hello: Claude 2 free
        return h;
      };
      await pass(p, N - MIN, 5 * MIN, CLAUDE_BUSY);
      expect(p.swaps()).toEqual([]);
      trip = true;
      for (let i = 0; i < 10 && !tripped; i++) await p.later(MIN, CLAUDE_BUSY);
      expect(tripped).toBe(true);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      await pass(p, 3 * MIN, MIN);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(p.swaps().every((s) => s.status === "cancelled")).toBe(true);
    } finally { p.f.close(); }
  });

  test("gate: the refused material changes while the remote head is read — the frozen refusal no longer authorizes the reclaim", async () => {
    const p = await refused();
    try {
      const real = p.context.remoteHead;
      let tripped = false;
      p.context.remoteHead = async (repo, branch) => {
        const h = await real(repo, branch);
        if (!tripped) {
          tripped = true;
          const path = join(p.f.dir, "report-r1b.md");
          writeFileSync(path, leaked());
          const last = p.events().filter((e) => e.kind === "review").at(-1)!;
          insertEvent(p.f.db, p.f.at("agent-rv-t1"), { project: "p", target: "T1", kind: "review", text: "本机复核", data: { ...last.data, path } }, true);
        }
        return h;
      };
      await pass(p, N + MIN, N + MIN);
      expect(tripped).toBe(true);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
    } finally { p.f.close(); }
  });
});

describe("dirty-preflight: the author tree is checked read-only before any reclaim or retirement", () => {
  for (const [name, arrange, part] of [
    ["uncommitted edits in the target tree", (dir: string) => { writeFileSync(join(dir, "wip.ts"), "x"); }, "有改动"],
    ["a target tree past the reviewed head (unpushed work)", (dir: string) => { sh(dir, "commit", "--allow-empty", "-m", "wip"); }, "未推送"],
  ] as const) {
    test(`${name}: lease stays at mate, nothing archived or stopped, one journaled wait`, async () => {
      const p = await refused();
      try {
        const dir = join(p.f.dir, "t1");
        mkdirSync(dir);
        sh(dir, "init", "-q"); sh(dir, "commit", "--allow-empty", "-m", "base");
        arrange(dir);
        await pass(p, N + 15 * MIN);
        expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
        expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
        expect(waits(p, part)).toHaveLength(1);
        expect(getIntent(p.f.db, p.swaps()[0]!.id)?.status).toBe("pending");
        expect(H2).not.toBe(sh(dir, "rev-parse", "HEAD"));
      } finally { p.f.close(); }
    });
  }
});

describe("manual-wait-clock: a manual fix card inside the owner's grant keeps its own fixed-peer wait clock", () => {
  const policyFile = (hours: number) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: {
    manualStallHours: hours, keys: { manualRecovery: "on", fixLocalSwap: "on" } } } }));
  afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
  const toManual = async (p: Sx, reason: string) =>
    expect(await p.cli("pm", "workflow-set", "T1", "--rev", String(p.f.task().rev), "--workflow-rev", String(getWorkflow(p.f.db, "T1")!.rev),
      "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason", reason)).toMatchObject({ ok: true });

  test("manual before any peer-slot start: the clock starts while manual, the owner threshold hands it back, local Codex takes over", async () => {
    const p = await swapFixture({ manualStallHours: 1 });
    try {
      await toFix(p, CLEAN);
      policyFile(1);
      await toManual(p, "write_lease_ended: 固定 peer 没有 Claude 空位，等本机接回");
      expect(p.observes().filter((e) => e.data.stretch === "start")).toEqual([]);
      await p.later(MIN, CLAUDE_BUSY);
      expect(p.observes().filter((e) => e.data.stretch === "start")).toHaveLength(1);
      expect(getWorkflow(p.f.db, "T1")!.mode).toBe("manual"); // the note is a fact, not a mode change
      await pass(p, 30 * MIN, 10 * MIN, CLAUDE_BUSY);
      expect(getWorkflow(p.f.db, "T1")!.mode).toBe("manual"); // the owner's hour is not up yet
      for (let i = 0; i < 6 && !p.swaps().length; i++) await p.later(30 * MIN, CLAUDE_BUSY);
      const resume = p.events().find((e) => e.data.op === "workflow_resume");
      expect(resume?.data.recoveryProof).toMatchObject({ mechanism: "fix-local-swap", subreason: "fix_local_swap_peer_slot" });
      await pass(p, 3 * MIN, MIN, CLAUDE_BUSY);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]);
      expect(reclaims(p)[0]!.data).toMatchObject({ source: "peer_slot", peer: "mate" });
      expect(creates(p)).toHaveLength(1);
      expect(p.observes().filter((e) => e.data.stretch === "start")).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("outside the grant (no owner threshold / sticky PM takeover) a manual card records no clock", async () => {
    for (const [hours, reason] of [[0, "write_lease_ended: 等本机接回"], [1, "pm_takeover: PM 手工接管"]] as const) {
      const p = await swapFixture(hours ? { manualStallHours: hours } : {});
      try {
        await toFix(p, CLEAN);
        if (hours) policyFile(hours); else writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualRecovery: "on", fixLocalSwap: "on" } } } }));
        await toManual(p, reason);
        await pass(p, 90 * MIN, 30 * MIN, CLAUDE_BUSY);
        expect(p.observes()).toEqual([]); expect(getWorkflow(p.f.db, "T1")!.mode).toBe("manual");
        expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      } finally { p.f.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); }
    }
  });
});

void BRANCH;
