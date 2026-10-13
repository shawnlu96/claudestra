/**
 * GATESWAP1 round-2 review, real tick on a temp ledger (tests/recovery-fix-local-swap-fixture.ts): the author-tree proof and the
 * positive quota proof are re-read at the reclaim's last edge (after the remote head is read) and the quota once more right before the
 * create (after the author tree is opened); a refusal there waits locally with one journaled reason. Round 3: the quota read is the
 * last await at both edges and the author tree is re-proved synchronously at the commit point. The tree check exempts exactly
 * the scheduler's dependency links of the tree's owning repo. Only the git, quota and remote-head ports are wrapped.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { FIX_LOCAL_SWAP_WAIT_MS, localSwapPorts } from "../src/lib/recovery-fix-local-swap.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { goodQuota, leaked, MIN, swapFixture, toFix, type Sx } from "./recovery-fix-local-swap-fixture.js";

const N = FIX_LOCAL_SWAP_WAIT_MS;
const UNKNOWN = { status: "unknown", source: "none", observedAt: null, plan: null, reason: "快照读失败", windows: [] } as unknown as InventoryQuota;
const creates = (p: Sx) => p.probe.effects.filter((e) => e.startsWith("create:"));
const reclaims = (p: Sx) => p.events().filter((e) => e.data.op === "fix_strategy_reclaim");
const waits = (p: Sx, part: string) => p.events().filter((e) => e.data.op === "convergence_effect" && String(e.data.reason ?? "").includes(part));
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

async function refused() {
  const p = await swapFixture();
  await toFix(p, leaked());
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  return p;
}
async function pass(p: Sx, total: number, step = 5 * MIN) {
  for (let t = 0; t < total; t += step) await p.later(step);
}
/** The real git, with the tree's actual commit spelled as the fixture's synthetic reviewed head H2 (git is an external port). */
function headAsH2(p: Sx, dir: string) {
  const actual = sh(dir, "rev-parse", "HEAD");
  localSwapPorts(p.f.db).git = async (args) => {
    const r = await git(args);
    return r.code === 0 && r.out === actual ? { ...r, out: H2 } : r;
  };
  localSwapPorts(p.f.db).gitSync = (args) => {
    const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" }), out = r.stdout.toString();
    return { code: r.exitCode, out: r.exitCode === 0 && out.trim() === actual ? H2 : out };
  };
}
/** A real linked worktree at the canonical author tree (worktreeRoot/t1), clean, at its main repo's commit. */
function linkedTree(p: Sx) {
  const main = join(p.f.dir, "main-repo"), dir = join(p.f.dir, "t1");
  mkdirSync(main);
  sh(main, "init", "-q"); sh(main, "commit", "--allow-empty", "-m", "base");
  sh(main, "worktree", "add", "-q", "--detach", dir);
  headAsH2(p, dir);
  return { main, dir };
}

describe("dirty-preflight: the tree proof is re-read at the reclaim's last edge", () => {
  test("the tree turns dirty while the remote head is read: no reclaim, no retirement, one journaled wait", async () => {
    const p = await refused();
    try {
      const { dir } = linkedTree(p);
      const real = p.context.remoteHead;
      let tripped = false;
      p.context.remoteHead = async (repo, branch) => {
        const h = await real(repo, branch);
        if (!tripped) { tripped = true; writeFileSync(join(dir, "wip.ts"), "x"); }
        return h;
      };
      await pass(p, N + MIN, N + MIN);
      expect(tripped).toBe(true);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      await pass(p, 3 * MIN, MIN);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(waits(p, "有改动")).toHaveLength(1);
    } finally { p.f.close(); }
  });
});

describe("quota-edge: a positive quota proof is re-read at the reclaim and create edges", () => {
  test("quota turns unknown while the remote head is read: the lease stays at mate; a fresh proof resumes", async () => {
    const p = await refused();
    try {
      const real = p.context.remoteHead;
      let tripped = false;
      p.context.remoteHead = async (repo, branch) => {
        const h = await real(repo, branch);
        if (!tripped) { tripped = true; p.state.quota = UNKNOWN; }
        return h;
      };
      await pass(p, N + MIN, N + MIN);
      expect(tripped).toBe(true);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      await pass(p, 3 * MIN, MIN);
      expect(reclaims(p)).toEqual([]);
      expect(waits(p, "额度未知")).toHaveLength(1);
      p.state.quota = goodQuota();
      await pass(p, 4 * MIN, MIN);
      expect(reclaims(p)).toHaveLength(1); expect(creates(p)).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("quota turns unknown while the author tree is opened: no create, one journaled wait; a fresh proof creates once", async () => {
    const p = await refused();
    try {
      const tree = p.probe.deps.authorTree!;
      let tripped = false;
      p.probe.deps.authorTree = async (...a) => { const r = await tree(...a); if (!tripped) { tripped = true; p.state.quota = UNKNOWN; } return r; };
      await pass(p, N + MIN, N + MIN);
      await pass(p, 3 * MIN, MIN);
      expect(tripped).toBe(true);
      expect(creates(p)).toEqual([]);
      expect(waits(p, "额度未知")).toHaveLength(1);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]); // never sent out instead
      p.state.quota = goodQuota();
      await pass(p, 4 * MIN, MIN);
      expect(creates(p)).toHaveLength(1);
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]);
    } finally { p.f.close(); }
  });
});

describe("r3 commit edges: the last await is the quota proof, the author tree is re-proved synchronously where the effect happens", () => {
  test("quota turns unknown while the tree's source-ref git (after the remote head) returns: no reclaim, the lease stays at mate", async () => {
    const p = await refused();
    try {
      linkedTree(p);
      const tree = localSwapPorts(p.f.db).git!, real = p.context.remoteHead;
      let headRead = false, tripped = false;
      p.context.remoteHead = async (repo, branch) => { const h = await real(repo, branch); headRead = true; return h; };
      localSwapPorts(p.f.db).git = async (args) => {
        const r = await tree(args);
        if (headRead && !tripped && args.some((a) => a.startsWith("refs/heads/"))) { tripped = true; p.state.quota = UNKNOWN; }
        return r;
      };
      await pass(p, N + MIN, N + MIN);
      await pass(p, 3 * MIN, MIN);
      expect(tripped).toBe(true);
      expect(reclaims(p)).toEqual([]); expect(p.probe.effects).toEqual([]);
      expect(heldLease(p.f.db, p.f.task())?.peer).toBe("mate");
      expect(waits(p, "额度未知")).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("the tree turns dirty while the quota is read after the author tree opens: no create, one journaled wait, intent not done", async () => {
    const p = await refused();
    try {
      const { dir } = linkedTree(p);
      const tree = p.probe.deps.authorTree!, quota = localSwapPorts(p.f.db).quota!;
      let opened = false, tripped = false;
      p.probe.deps.authorTree = async (...a) => { const r = await tree(...a); opened = true; return r; };
      localSwapPorts(p.f.db).quota = async (family) => {
        if (opened && !tripped) { tripped = true; writeFileSync(join(dir, "wip.ts"), "x"); }
        return quota(family);
      };
      await pass(p, N + MIN, N + MIN);
      await pass(p, 3 * MIN, MIN);
      expect(tripped).toBe(true);
      expect(creates(p)).toEqual([]);
      // the create gate's refusal, then the later passes' awaited preflight: each reason journaled once, never repeated
      const journaled = waits(p, "有改动").length;
      expect(journaled).toBeGreaterThanOrEqual(1);
      await pass(p, 3 * MIN, MIN);
      expect(waits(p, "有改动")).toHaveLength(journaled); expect(creates(p)).toEqual([]);
      expect(p.swaps()).not.toEqual([expect.objectContaining({ status: "done" })]);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]); // never sent out instead
    } finally { p.f.close(); }
  });
});

describe("dependency-links: the scheduler's exact dependency links of the owning repo are not edits", () => {
  test("a clean linked author tree with only the node_modules link: the takeover proceeds", async () => {
    const p = await refused();
    try {
      const { main, dir } = linkedTree(p);
      mkdirSync(join(main, "node_modules"));
      symlinkSync(join(main, "node_modules"), join(dir, "node_modules"));
      await pass(p, N + MIN, N + MIN);
      await pass(p, 3 * MIN, MIN);
      expect(waits(p, "node_modules")).toEqual([]);
      expect(reclaims(p)).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("a link elsewhere is still an edit", async () => {
    const p = await refused();
    try {
      const { dir } = linkedTree(p);
      mkdirSync(join(p.f.dir, "other-deps"));
      symlinkSync(join(p.f.dir, "other-deps"), join(dir, "node_modules"));
      await pass(p, N + MIN, N + MIN);
      await pass(p, 3 * MIN, MIN);
      expect(reclaims(p)).toEqual([]);
      expect(waits(p, "node_modules")).toHaveLength(1);
    } finally { p.f.close(); }
  });
});
