import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LendCentralJournal, type LendCentralJournalEntry } from "../src/bridge/shared-ledger-v2-lend-journal.js";
import { parseActor, parseLendOrder } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "s2-lend-journal-")); directories.push(directory);
  const order = parseLendOrder(fixtures.lendOrder.valid);
  const entry: LendCentralJournalEntry = { localProjectId: "local-project", localTaskId: "local-task", binding: {
    order, worker: order.worker!, executorInstanceId: "peer-a", peer: "peer-a", fp: "a".repeat(64), homeInstanceId: "local",
    actor: parseActor({ kind: "service", personId: "person", instanceId: "local", serviceId: "lend",
      representedPersonId: "owner", orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }),
  } };
  return { directory, entry, journal: new LendCentralJournal(directory) };
}
test("restart retains original binding instead of pinning a new fence or task version", async () => {
  const f = fixture(), original = structuredClone(f.entry);
  await f.journal.pin(f.entry);
  f.entry.binding.order.epoch++;
  f.entry.binding.order.leaseGen++;
  f.entry.binding.order.specRev++;
  expect(await new LendCentralJournal(f.directory).pin(f.entry)).toEqual(original);
  const file = join(f.directory, "bindings", readdirSync(join(f.directory, "bindings"))[0]!);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
test("another worker, fingerprint or local task cannot reuse the binding", async () => {
  const f = fixture(); await f.journal.pin(f.entry);
  const changes: ((e: LendCentralJournalEntry) => void)[] = [
    e => { e.localTaskId = "other"; }, e => { e.localProjectId = "other"; },
    e => { e.binding.fp = "b".repeat(64); },
    e => { e.binding.worker = { kind: "peer_agent", instanceId: "peer-a", agentId: "other" }; e.binding.order.worker = e.binding.worker; },
  ];
  for (const change of changes) {
    const copy = structuredClone(f.entry); change(copy);
    await expect(f.journal.pin(copy)).rejects.toThrow("forbidden");
  }
});
test("corrupt journal is preserved and never becomes a fresh binding", async () => {
  const f = fixture(); await f.journal.pin(f.entry);
  const file = join(f.directory, "bindings", readdirSync(join(f.directory, "bindings"))[0]!);
  writeFileSync(file, "broken");
  await expect(f.journal.pin(f.entry)).rejects.toThrow("journal corrupt");
  expect(readFileSync(file, "utf8")).toBe("broken");
});
