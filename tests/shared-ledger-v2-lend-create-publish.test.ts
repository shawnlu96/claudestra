/** S2F2 acceptance line 4 (E16 ①): on the central delivery path a write order is published (branch pushed, PR opened) before
 * lend.result is sent; a failed publish sends none. The publish itself is the injected port (the legacy publishWork, wired by S2F6). */
import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerLendTool } from "../src/bridge/lend-tools.js";
import {
  configureLendCentral, configureLendCentralRouting, type LendCentralPublished, type LendCentralPublishWork, type LendCentralRoutingPort,
} from "../src/bridge/shared-ledger-v2-lend.js";
import type { LendCentralJournalEntry } from "../src/bridge/shared-ledger-v2-lend-journal.js";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import type { LendCentralView } from "../src/lib/ledger-lend-central-checks.js";
import type { LendCentralTransport } from "../src/lib/ledger-lend-central.js";
import type { LendEntry, LendRead } from "../src/lib/lend-config.js";
import {
  parseActor, parseLendOrder, parseLendLease, parseTask, parseReceipt, v2ObjectDigest, V2ContractError, type V2Command, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const directories: string[] = [], databases: ReturnType<typeof openLendJournal>[] = [];
afterEach(() => {
  configureLendCentral(null); configureLendCentralRouting(null);
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
});

type Publish = (work: LendCentralPublishWork) => Promise<LendCentralPublished>;
/** One claimed central order held by a started lend worker; `publish` undefined = the port is not injected. */
function fixture(publish: Publish | undefined, step: "write" | "fix" | "review" = "write", pr: number | null = null) {
  const directory = mkdtempSync(join(tmpdir(), "s2f2-publish-")); directories.push(directory);
  const worker = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "agent-lend-test" }, write = step !== "review";
  const order = parseLendOrder({ ...parseLendOrder(fixtures.lendOrder.valid), worker, pr,
    ...(write ? { step, branch: "lend/task-abcd", base: "main" } : {}) });
  const lease = parseLendLease({ ...parseLendLease(fixtures.lendLease.valid), worker });
  const task = parseTask({ ...parseTask(fixtures.task.valid), stage: step === "write" ? "build" : step, head: order.head });
  const entry: LendCentralJournalEntry = { localProjectId: "local-project", localTaskId: "local-task", binding: {
    order, worker, executorInstanceId: "peer-a", peer: "peer-a", fp: "a".repeat(64), homeInstanceId: "local",
    actor: parseActor({ kind: "service", personId: "person", instanceId: "local", serviceId: "lend", representedPersonId: "owner",
      orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }),
  } };
  const grant: LendEntry = { peer: "peer-a", fp: entry.binding.fp, families: { codex: 2 }, roles: ["review", "write"],
    repos: [order.repository], ordersPerDay: 10, grantedAt: new Date(1000).toISOString(), until: new Date(100000).toISOString() };
  const read: LendRead = { status: "ok", file: { version: 2, enabled: true, lend: [grant], borrow: [] } };
  const trail: string[] = [], commands: V2Command[] = [], published: LendCentralPublishWork[] = [], receipts = new Map<string, V2Receipt>();
  const view: LendCentralView = { order: structuredClone(order), lease, task, now: 2000 };
  let lose = false;
  const transport: LendCentralTransport = {
    receipt: async id => receipts.get(id) ?? null,
    view: async () => structuredClone(view),
    command: async c => {
      trail.push(c.type); commands.push(structuredClone(c));
      if (lose) throw new V2ContractError("unavailable");
      const receipt = parseReceipt({ ...parseReceipt(fixtures.receipt.valid), requestId: c.requestId, command: c.type,
        commandDigest: v2ObjectDigest(c), result: { entityId: order.orderId, rev: 1, specRev: order.specRev, version: null, epoch: c.epoch,
          operationId: c.type === "lend.result" ? c.payload.result.operationId : null } });
      receipts.set(c.requestId, receipt);
      return receipt;
    },
  };
  let mode: "off" | "observe" | "on" = "on";
  const routing: LendCentralRoutingPort = { route: () => "central", bindingFor: id => id === order.orderId ? entry : null,
    sharedResult: () => ({ summary: "home approved summary", artifactIds: [] }),
    ...(publish ? { publishWork: async work => { trail.push("publish"); published.push(work); return publish(work); } } : {}) };
  configureLendCentral({ mode: () => mode, transportFor: () => transport, outboxDir: directory, grant: {
    now: () => 2000, readLend: async () => read, context: async () => ({ contacts: [{ name: "peer-a", fp: entry.binding.fp }], projects: [] }) } });
  configureLendCentralRouting(routing);
  const db = openLendJournal(LEND_JOURNAL_PATH); databases.push(db);
  recordAsked(db, { orderId: "order", peer: "peer-a", fp: entry.binding.fp, family: "codex", preview: {} });
  advance(db, "order", "asked", "claimed", { leaseGen: 1,
    wire: { order: { orderId: "order", taskId: "local-task", head: order.head, step: order.step }, text: "trusted order" } });
  advance(db, "order", "claimed", "cloned", { dir: directory });
  advance(db, "order", "cloned", "started", { agent: worker.agentId, sessionId: "worker-session" });
  const identity: CallerIdentity = { agent: worker.agentId, sessionId: "worker-session", family: "codex", verified: true };
  const deliver = { v: 1, orderId: "order", head: "c".repeat(40), evidence: "evidence.md", summary: "worker raw summary", selfCheck: "local checks" };
  return { directory, order, identity, deliver, view, grant, read, trail, commands, published, lose: (v: boolean) => { lose = v; }, setMode: (v: typeof mode) => { mode = v; } };
}
const results = (f: { commands: V2Command[] }) => f.commands.filter(c => c.type === "lend.result");

for (const step of ["write", "fix"] as const) {
  test(`[验收线 4] ${step} delivery: publishWork runs before lend.result, with the order's own branch / base and the delivered head`, async () => {
    const f = fixture(async () => ({ ok: true, pr: 77 }), step);
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: true, status: "confirmed" });
    expect(f.trail).toEqual(["publish", "lend.result"]);
    expect(f.published).toEqual([{ orderId: f.order.orderId, taskId: "local-task", repository: f.order.repository, branch: "lend/task-abcd",
      base: "main", head: f.deliver.head, dir: f.directory }]);
    const c = results(f)[0]!;
    if (c.type !== "lend.result") throw new Error("wrong command");
    expect(c.payload.result).toMatchObject({ head: f.deliver.head, verdict: "delivered" });
  });
}

test("[验收线 4] publishWork refuses, throws or names no branch: lend.result is sent zero times and nothing is journaled for the center", async () => {
  const refuse: Publish = async () => ({ ok: false, error: "push rejected: non-fast-forward" });
  const crash: Publish = async () => { throw new Error("gh: could not open the PR"); };
  for (const publish of [refuse, crash]) {
    const f = fixture(publish);
    const out = await answerLendTool("deliver", f.identity, f.deliver);
    expect(out).toMatchObject({ ok: false, code: "publish_failed" });
    expect(f.trail).toEqual(["publish"]);
    expect(results(f)).toHaveLength(0);
    // A retry publishes again (the legacy publish is idempotent) and still reports nothing while it fails.
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "publish_failed" });
    expect(f.trail).toEqual(["publish", "publish"]);
    expect(results(f)).toHaveLength(0);
    configureLendCentral(null); configureLendCentralRouting(null);
    for (const db of databases.splice(0)) db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
  }
});

test("[验收线 4] publish succeeds after a failure: exactly one lend.result, sent after the successful publish; an existing PR number is kept", async () => {
  let ok = false;
  const f = fixture(async () => ok ? { ok: true, pr: 99 } : { ok: false, error: "network" }, "write", 41);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "publish_failed" });
  ok = true;
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: true, status: "confirmed" });
  expect(f.trail).toEqual(["publish", "publish", "lend.result"]);
  expect(results(f)).toHaveLength(1);
});

test("[验收线 4] a center outage after a successful publish leaves the result pending; the retry reconciles without a second publish or result body", async () => {
  const f = fixture(async () => ({ ok: true, pr: 77 }));
  f.lose(true);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "unavailable", status: "outbox" });
  f.lose(false);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "unavailable", status: "ready" });
  expect(f.trail).toEqual(["publish", "lend.result"]);
  // Another head under the journaled delivery is refused before anything is pushed for it.
  expect(await answerLendTool("deliver", f.identity, { ...f.deliver, head: "d".repeat(40) })).toMatchObject({ ok: false, code: "dedup_mismatch" });
  // The lease running out while the result is pending does not publish again either.
  f.view.now = f.view.lease!.expiresAt + 1;
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "lease_expired" });
  expect(f.trail).toEqual(["publish", "lend.result"]);
});

type Fixture = ReturnType<typeof fixture>;
const REFUSED: [string, string, (f: Fixture) => void][] = [
  ["the central lease has expired", "lease_expired", f => { f.view.now = f.view.lease!.expiresAt + 1; }],
  ["the order's leaseUntil has passed", "lease_expired", f => { f.view.order.leaseUntil = f.view.now; }],
  ["the center no longer holds the order as claimed", "stale_order", f => { f.view.order.status = "pooled"; f.view.lease = null; }],
  ["the home grant has expired", "authorization_expired", f => { f.grant.until = new Date(1500).toISOString(); }],
  ["the home grant was revoked", "authorization_expired", f => { f.read.file.lend = []; }],
  ["the delivered head is the order's unchanged head", "stale_order", f => { f.deliver.head = f.order.head; }],
];
for (const [name, code, arrange] of REFUSED) {
  test(`[验收线 4] ${name}: refused ${code} before the publish port runs — publish and lend.result both zero`, async () => {
    const f = fixture(async () => ({ ok: true, pr: 77 }));
    arrange(f);
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code });
    expect(f.trail).toEqual([]);
    expect(f.published).toHaveLength(0);
    expect(results(f)).toHaveLength(0);
  });
}

test("[验收线 4] the switch withdrawn before delivery: no publish and no lend.result; a review verdict never publishes", async () => {
  const f = fixture(async () => ({ ok: true, pr: 1 }));
  f.setMode("observe");
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "unavailable" });
  expect(f.trail).toEqual([]);
  configureLendCentral(null); configureLendCentralRouting(null);
  for (const db of databases.splice(0)) db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
  const r = fixture(async () => ({ ok: true, pr: 1 }), "review");
  writeFileSync(join(r.directory, "report.md"), "private local report");
  const verdict = { v: 1, orderId: "order", head: r.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" };
  expect(await answerLendTool("submit_verdict", r.identity, verdict)).toMatchObject({ status: "confirmed" });
  expect(r.trail).toEqual(["lend.result"]);
});
