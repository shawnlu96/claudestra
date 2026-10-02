import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { command, harness, worker } from "./shared-ledger-v2-lend-server-fixture.test.js";
import { readLendRow } from "../src/shared-ledger/lend/storage.js";

test("two independent SQLite connections share one claim authority, surviving connection restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "lend-center-")), file = join(dir, "central.sqlite");
  const h = harness("review", new Database(file));
  let other = new Database(file);
  try {
    h.db.exec("PRAGMA journal_mode=WAL");
    const o = h.create();
    const secondOwner = h.connect(other);
    const runSecond = () => other.transaction(() => secondOwner.inCallerTransaction(h.scope, h.names, c => {
      return h.domain.applyInTransaction(c, command("lend.claim", { claim: {
        ...V2_DTO_FIXTURES.lendClaim.valid as object, orderId: o.orderId, worker: { ...worker, agentId: "second-worker" },
      } }));
    }))();
    const cached = other.query("SELECT body FROM v2_lend_orders").get() as { body: string };
    expect(JSON.parse(cached.body).status).toBe("pooled");
    h.claim(o.orderId);
    expect(() => runSecond()).toThrow("stale_order");
    other.close(); other = new Database(file);
    const restarted = h.connect(other);
    const row = other.transaction(() => restarted.inCallerTransaction(h.scope, h.names, c => readLendRow(c, "order", o.orderId)))();
    expect(row).toMatchObject({ status: "claimed", worker, leaseGen: 1 });
    expect(h.count("v2_lend_claims")).toBe(1);
  } finally { other.close(); h.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
