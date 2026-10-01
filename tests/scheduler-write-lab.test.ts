/**
 * i28-W9 across both instances (tests/lend-lab-kit.ts): A's real ledger, scheduler tick, pool CLI and push loop; B's real lend
 * loop (hello, admit, claim, clone, push probe, worker start, push + PR, result with the receipt verified). B's write path is
 * opened with the lend-policy test switch `writeOpen` (production opens it with i28-R7e). A build order goes to B's Codex,
 * B delivers the lend/ branch, the card moves to review and its review is placed across, on a local Claude reviewer, never
 * back at B (which only lends Codex). With write closed at B, its hello grants no write and A builds locally.
 * The worker's own `lend submit` is covered by tests/lend-write.test.ts; here it is the journal row it writes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance } from "../src/lib/lend-journal.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { H2, toBuild } from "./scheduler-auto-helpers.js";
import { FP } from "./lend-harness.js";
import { H1, lab, MATE, type Lab } from "./lend-lab-kit.js";

const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 };

/** A borrows writing from B at `first`; B grants review + write; `open` = B's lend-policy writeOpen (R7e's switch). */
async function writeLab(open: boolean): Promise<Lab & { heads: Record<string, string> }> {
  const heads: Record<string, string> = {};
  const L = await lab({ remote: WRITE, remoteHead: (branch) => heads[branch] ?? H1 });
  L.b.writeOpen = open;
  // manager create's last gate (lendCreateDenied) reads the production WRITE_ROLE_OPEN with no test seam; R7e opens it.
  // Until then this worker keeps the loop's own gate (which honours writeOpen) and stands in for that last check.
  L.b.worker = { ...L.b.worker, create: async (name, cwd, _purpose, gate, order) => {
    const denied = await gate();
    if (denied) return { ok: false, error: denied };
    L.spawned.push({ name, order, args: [] });
    L.registry.set(name, { sessionId: `thr-${name}`, cwd });
    return { ok: true };
  } };
  L.grant([{ ...L.entry, roles: ["review", "write"] }]);
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
    const L = await writeLab(true);
    try {
      await until(L, () => bOrders(L)[0]?.state === "started");
      const [a] = L.orders();
      expect(a).toMatchObject({ step: "write", peer: MATE, family: "codex", status: "claimed", head: H1, branch: lendBranch("T1", FP) });
      expect(L.spawned).toMatchObject([{ order: a.orderId }]);
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

  test("write still closed at B (before R7e): a grant with write is void there, A never offers it a build and writes locally", async () => {
    const L = await writeLab(false);
    try {
      await L.passes(4);
      expect(L.wire.filter((w) => JSON.stringify(w.body).includes("\"write\""))).toEqual([]);
      expect(L.orders()).toEqual([]);
      expect(bOrders(L)).toEqual([]);
      expect(L.f.intents().at(-1)).toMatchObject({ action: "dispatch", recipient: "agent-task-one" });
    } finally { L.f.close(); }
  });
});
