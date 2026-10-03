import { expect, test } from "bun:test";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { driveLeased, workerName, type LendDeps } from "../src/lib/lend-drive.js";

test("different write orders actually create different worker sessions; a crashed same order recovers its own session", async () => {
  const db = openLendJournal(":memory:"), now = Date.now(), workers = new Map<string, { sessionId: string; cwd: string }>(), made: string[] = [];
  const fp = "abcd-bbbb-cccc-dddd", entry = { peer: "A", fp, families: { codex: 4 }, roles: ["write" as const], repos: ["o/r"], ordersPerDay: 100,
    grantedAt: new Date(now).toISOString(), until: new Date(now + 3600_000).toISOString() };
  const never = async (): Promise<never> => { throw new Error("unexpected external boundary"); };
  const deps: LendDeps = { db, now: () => now, call: never, renewal: () => null, writeOpen: true,
    readLend: async () => ({ status: "ok", file: { version: 2, enabled: true, lend: [entry], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "A", fp }], projects: [] }), notify: async () => ({ ok: true }), retireAsk: async () => ({ ok: true }),
    clone: never, selfFp: () => fp, identity: () => ({ name: "test", email: "test@invalid" }),
    push: { probe: never, work: never, pr: never }, removeDir: () => {}, verifyReceipt: never, writeReceipt: never, footer: () => "", failure: () => undefined,
    closeAsks: async () => ({ ok: true }), codexQuota: async () => null, log: (msg) => { throw new Error(msg); },
    worker: { find: (name) => workers.get(name), create: async (name, cwd, _purpose, gate) => {
      expect(await gate()).toBeNull(); made.push(name); workers.set(name, { sessionId: `fresh-session-${made.length}`, cwd }); return { ok: true };
    }, send: never, kill: never, alive: never } };
  try {
    for (const orderId of ["previous-repair", "fresh-repair"]) {
      recordAsked(db, { orderId, peer: "A", fp, family: "codex", preview: { repo: "o/r", step: "fix" } }, now);
      advance(db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 60_000, lastBeatAt: now,
        wire: { order: { taskId: "T1", step: "fix", head: "1".repeat(40) }, text: "write order", write: { branch: "lend/T1-abcd", base: "main" } } }, now);
      const row = advance(db, orderId, "claimed", "cloned", { dir: `/isolated/${orderId}` }, now);
      await driveLeased(row, deps);
    }
    const first = getOrder(db, "previous-repair")!, next = getOrder(db, "fresh-repair")!;
    expect(first.agent).toBe(workerName(first.orderId)); expect(next.agent).not.toBe(first.agent); expect(next.sessionId).not.toBe(first.sessionId);
    db.run("UPDATE lend_orders SET state = 'cloned', sessionId = NULL WHERE orderId = 'fresh-repair'");
    await driveLeased(getOrder(db, "fresh-repair")!, deps);
    expect(made.length).toBe(2); expect(getOrder(db, "fresh-repair")?.sessionId).toBe(next.sessionId);
  } finally { db.close(); }
});
