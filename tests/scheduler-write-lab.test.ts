/**
 * i28-W9 across both instances (tests/lend-lab-kit.ts): A's real ledger, scheduler tick, pool CLI and push loop; B's real lend
 * loop (hello, admit, claim, clone, push probe, worker start through manager create's last gate, push + PR, result with the
 * receipt verified). A build
 * order goes to B's Codex, B delivers the lend/ branch, the card moves to review and its review is placed across, on a local
 * Claude reviewer, never back at B (which only lends Codex). Old review-only grants also receive builds.
 * The worker's own `lend submit` is covered by tests/lend-write.test.ts; here it is the journal row it writes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance } from "../src/lib/lend-journal.js";
import type { LendRole } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { H2, toBuild } from "./scheduler-auto-helpers.js";
import { FP } from "./lend-harness.js";
import { H1, lab, MATE, MODEL, type Lab } from "./lend-lab-kit.js";

const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 };

/** A borrows writing from B at `first`; vary the legacy roles in B's grant. */
async function writeLab(roles: LendRole[]): Promise<Lab & { heads: Record<string, string> }> {
  const heads: Record<string, string> = {};
  const L = await lab({ remote: WRITE, remoteHead: (branch) => heads[branch] ?? H1 });
  L.grant([{ ...L.entry, roles }]);
  L.borrow[0] = { ...L.borrow[0], roles: ["review", "write"], priority: "first" };
  // The fixture's reviewer is an ACP Codex session; the review of a Codex-written head is a Claude one, driven over tmux.
  const reg = JSON.parse(readFileSync(L.f.registryPath, "utf8"));
  reg.agents["agent-rv-t1"] = { ...reg.agents["agent-rv-t1"], runtime: "claude-code", transport: undefined };
  writeFileSync(L.f.registryPath, JSON.stringify(reg));
  await toBuild(L.f);
  return Object.assign(L, { heads });
}

const bOrders = (L: Lab) => L.db.query("SELECT orderId, state FROM lend_orders").all() as { orderId: string; state: string }[];

async function until(L: Lab, done: () => boolean, max = 12) {
  for (let i = 0; i < max && !done(); i++) await L.pass();
  expect(done()).toBe(true);
}

describe("a build order across two instances", () => {
  test("A pools the build at B → B claims, clones, starts its Codex, pushes the lend/ branch → review placed across, on Claude", async () => {
    const L = await writeLab(["review", "write"]);
    try {
      await until(L, () => bOrders(L)[0]?.state === "started");
      const [a] = L.orders();
      expect(a).toMatchObject({ step: "write", peer: MATE, family: "codex", status: "claimed", head: H1, branch: lendBranch("T1", FP) });
      expect(L.spawned).toMatchObject([{ order: a.orderId, args: expect.arrayContaining([MODEL]) }]);
      expect(L.refusedSpawns).toEqual([]);
      expect(L.f.sent.filter((s) => s.text.includes("开工"))).toEqual([]); // A's local author got no work order
      // The worker commits H2 on the lend/ branch (main stays at H1, the order's start) and the push lands it there.
      L.heads[lendBranch("T1", FP)!] = H2;
      advance(L.db, bOrders(L)[0].orderId, "started", "result_pending", { work: { head: H2, summary: "实现了 x", selfCheck: "单测全绿" } }, L.now());
      await until(L, () => L.f.task().stage === "review");
      expect(L.bState(a.orderId)).toBe("acked");
      expect(L.ops()).toEqual(expect.arrayContaining(["hello", "claim", "result"]));
      expect(L.orders()[0]).toMatchObject({ status: "done" });
      expect(L.f.task()).toMatchObject({ headSHA: H2, branch: lendBranch("T1", FP) });

      // B only lends Codex and the head is Codex-written: the review goes to a local Claude reviewer, B gets no review order.
      await until(L, () => L.f.intents().at(-1)?.action === "review");
      expect(L.f.ensured.at(-1)).toEqual({ role: "reviewer", family: "claude" });
      expect(L.f.intents().at(-1)?.recipient?.startsWith("peer:")).toBe(false);
      expect(L.orders()).toHaveLength(1);
    } finally { L.f.close(); }
  });

  test("B's old review-only grant reports both roles and runs the build remotely", async () => {
    const L = await writeLab(["review"]);
    try {
      await until(L, () => bOrders(L)[0]?.state === "started");
      const hellos = L.wire.filter((w) => w.op === "hello");
      expect(hellos.length).toBeGreaterThan(0);
      for (const h of hellos) expect(h.body).toMatchObject({ grant: { roles: ["review", "write"] } });
      expect(L.orders()).toMatchObject([{ step: "write", peer: MATE, family: "codex", status: "claimed" }]);
      expect(L.spawned).toHaveLength(1);
      expect(L.refusedSpawns).toEqual([]);
      expect(L.f.sent.filter((s) => s.text.includes("开工"))).toEqual([]);
    } finally { L.f.close(); }
  });
});
