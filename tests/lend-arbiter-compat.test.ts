import { expect, test } from "bun:test";
import { harness, polled, wire, TEXT, FP } from "./lend-harness.js";
import { recordAsked, advance } from "../src/lib/lend-journal.js";
import { peerProto } from "../src/lib/lend-hello.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";

for (const [borrower, lender] of [[3, 2], [2, 3]] as const) {
  test(`A proto ${borrower}, B proto ${lender}: the foundation protocol still uses batched beat rather than lease polling`, async () => {
    const h = harness(), operations: string[] = [];
    try {
      h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
      const now = h.d.now(), orderId = "compat-order";
      recordAsked(h.db, { orderId, peer: "team-a", fp: FP, family: "codex", preview: polled(orderId) }, now);
      advance(h.db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now,
        wire: { order: wire(orderId), text: TEXT } }, now);
      h.d.v2 = { boot: "testboot", call: async (_peer, op, body) => {
        operations.push(op);
        if (op === "hello") {
          expect(parseV2Request("hello", { ...body, proto: lender }).ok).toBe(true);
          return { status: 200, body: { ok: true, v: 1, proto: borrower, helloMs: 60_000, beatMs: 15_000 } };
        }
        expect(op).toBe("beat"); expect(parseV2Request("beat", body).ok).toBe(true);
        const rows = body.orders as { orderId: string; gen: number }[];
        return { status: 200, body: { ok: true, v: 1, orders: rows.map((r) => ({ orderId: r.orderId, verdict: "ok",
          lease: { gen: r.gen, expiresAt: now + 600_000, ms: 600_000 } })) } };
      } };
      await h.tick();
      expect(peerProto(h.db, "team-a")).toBe(2); expect(operations).toContain("beat"); expect(h.ops()).not.toContain("lease");
    } finally { h.db.close(); }
  });
}
