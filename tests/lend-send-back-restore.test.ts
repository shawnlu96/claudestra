/** SENDBACK1: what a card gets back when its write lease ends without the peer's work (the pure half; ledger paths in lend-send-back-local-author). */
import { describe, expect, test } from "bun:test";
import type { WriteLease } from "../src/lib/ledger-lend-lease.js";
import { leaseRestore } from "../src/lib/lend-send-back-restore.js";

const FP = "abcd-ef01-2345-6789";
const lease = (prevAssigneeKind: string | null, prevAssignee: string | null): WriteLease => ({
  taskId: "T9", project: "p", peer: "Sekai", fp: FP, branch: "lend/T9-abcd", repo: "o/r", prevAssignee, prevAssigneeKind,
  state: "ended", reason: "x", createdAt: 1, updatedAt: 2,
});
const peerCard = (extra: Record<string, unknown> = {}) => ({ assigneeKind: "peer_agent" as const, assignee: `${FP}/agent-lend-0123456789`, extra });

describe("assignee: back to what the lease recorded, only while the card still names that peer's worker", () => {
  test("a local agent comes back as agent (the PM reclaim patch shape)", () => {
    expect(leaseRestore(peerCard(), lease("agent", "agent-dev"))).toEqual({
      patch: { agent: "agent-dev" }, restored: { assigneeKind: "agent", assignee: "agent-dev" }, unpinned: null });
  });

  test("an empty assignee comes back empty; a human comes back as that human", () => {
    expect(leaseRestore(peerCard(), lease(null, null), "Sekai")?.patch).toEqual({ assigneeKind: null, assignee: null });
    expect(leaseRestore(peerCard(), lease("human", "alice"))?.patch).toEqual({ assigneeKind: "human", assignee: "alice" });
  });

  test("assignee changed in between (PM, another peer, a local agent) or no lease: nothing to restore", () => {
    expect(leaseRestore({ ...peerCard(), assignee: "ffff-ffff-ffff-ffff/agent-lend-x" }, lease("agent", "agent-dev"), "Sekai")).toBeNull();
    expect(leaseRestore({ assigneeKind: "agent", assignee: "pm-choice", extra: {} }, lease("agent", "agent-dev"), "Sekai")).toBeNull();
    expect(leaseRestore(peerCard(), null, "Sekai")).toBeNull();
  });
});

describe("placement: only a pin on exactly the peer sent back is dropped", () => {
  const extra = { repo: "o/r", fileGlobs: ["src/a.ts"], placementReservation: { mode: "observe", family: "codex", maxOpen: 10 } };

  test("peer:<that peer> is removed, every other extra key kept verbatim", () => {
    const r = leaseRestore({ assigneeKind: null, assignee: null, extra: { ...extra, placement: "peer:Sekai" } }, null, "Sekai");
    expect(r).toEqual({ patch: { extra }, restored: null, unpinned: "peer:Sekai" });
    expect(JSON.stringify(r!.patch.extra)).toBe(JSON.stringify(extra));
  });

  test("pinned to another peer, a peer with a longer name, or local: untouched", () => {
    for (const placement of ["peer:Other", "peer:Sekai2", "local", "Sekai"]) {
      expect(leaseRestore({ assigneeKind: null, assignee: null, extra: { ...extra, placement } }, null, "Sekai")).toBeNull();
    }
  });

  test("without a peer to unpin (PM reclaim) the pin stays and the patch is the assignee alone", () => {
    expect(leaseRestore(peerCard({ placement: "peer:Sekai" }), lease("agent", "agent-dev"))?.patch).toEqual({ agent: "agent-dev" });
    expect(leaseRestore({ assigneeKind: null, assignee: null, extra: { placement: "peer:Sekai" } }, lease(null, null))).toBeNull();
  });

  test("both at once land in one patch", () => {
    expect(leaseRestore(peerCard({ placement: "peer:Sekai", repo: "o/r" }), lease(null, null), "Sekai")).toEqual({
      patch: { assigneeKind: null, assignee: null, extra: { repo: "o/r" } }, restored: { assigneeKind: null, assignee: null }, unpinned: "peer:Sekai" });
  });
});
