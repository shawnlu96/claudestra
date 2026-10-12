/** S2F6 acceptance line 3: the production publish port (wiring-lend's publishWork over lend-drive's publishLendWork) wired into the
 * central delivery path: preflight → publish (push, then PR) → lend.result, each once; a failed publish sends lend.result zero times. */
import { afterEach, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerLendTool } from "../src/bridge/lend-tools.js";
import { configureLendCentral, configureLendCentralRouting, type LendCentralRoutingPort } from "../src/bridge/shared-ledger-v2-lend.js";
import type { LendCentralJournalEntry } from "../src/bridge/shared-ledger-v2-lend-journal.js";
import { lendBindings } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { writeLendCentralOrder } from "../src/lib/ledger-lend-central-home.js";
import type { LendCentralView } from "../src/lib/ledger-lend-central-checks.js";
import { LedgerLendCentralClient, type LendCentralTransport } from "../src/lib/ledger-lend-central.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { LendEntry, LendRead } from "../src/lib/lend-config.js";
import type { LendDeps } from "../src/lib/lend-drive.js";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import type { PrInput, PushTarget } from "../src/lib/lend-push.js";
import {
  parseActor, parseLendLease, parseLendOrder, parseReceipt, parseTask, v2ObjectDigest, type V2Command, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const directories: string[] = [], journals: ReturnType<typeof openLendJournal>[] = [];
afterEach(() => {
  configureLendCentral(null); configureLendCentralRouting(null); closeLedger(":memory:");
  for (const db of journals.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
});

type Answer = { ok: true } | { ok: false; reason: string; retry: boolean };
/** One claimed central write order held by a started lend worker; publishWork is the production port with spied push / PR. */
function fixture(pushed: () => Answer, opened: () => ({ ok: true; pr: number | null } | { ok: false; reason: string; retry: boolean })) {
  const directory = mkdtempSync(join(tmpdir(), "s2f6-publish-")); directories.push(directory);
  const worker = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "agent-lend-test" };
  const order = parseLendOrder({ ...parseLendOrder(fixtures.lendOrder.valid), worker, pr: null, step: "write", branch: "lend/task-abcd", base: "main" });
  const lease = parseLendLease({ ...parseLendLease(fixtures.lendLease.valid), worker });
  const task = parseTask({ ...parseTask(fixtures.task.valid), stage: "build", head: order.head });
  const entry: LendCentralJournalEntry = { localProjectId: "local-project", localTaskId: "local-task", binding: {
    order, worker, executorInstanceId: "peer-a", peer: "peer-a", fp: "a".repeat(64), homeInstanceId: "local",
    actor: parseActor({ kind: "service", personId: "person", instanceId: "local", serviceId: "lend", representedPersonId: "owner",
      orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }),
  } };
  const grant: LendEntry = { peer: "peer-a", fp: entry.binding.fp, families: { codex: 2 }, roles: ["review", "write"],
    repos: [order.repository], ordersPerDay: 10, grantedAt: new Date(1000).toISOString(), until: new Date(100000).toISOString() };
  const read: LendRead = { status: "ok", file: { version: 2, enabled: true, lend: [grant], borrow: [] } };
  const trail: string[] = [], commands: V2Command[] = [], receipts = new Map<string, V2Receipt>();
  const pushes: (PushTarget & { head: string })[] = [], prs: PrInput[] = [];
  const view: LendCentralView = { order: structuredClone(order), lease, task, now: 2000 };
  const transport: LendCentralTransport = {
    receipt: async id => receipts.get(id) ?? null,
    view: async () => structuredClone(view),
    command: async c => {
      trail.push(c.type); commands.push(structuredClone(c));
      const receipt = parseReceipt({ ...parseReceipt(fixtures.receipt.valid), requestId: c.requestId, command: c.type,
        commandDigest: v2ObjectDigest(c), result: { entityId: order.orderId, rev: 1, specRev: order.specRev, version: null, epoch: c.epoch,
          operationId: c.type === "lend.result" ? c.payload.result.operationId : null } });
      receipts.set(c.requestId, receipt);
      return receipt;
    },
  };
  // The home ledger row of this order (bindingFor's source; publishWork reads the order's view through it after a restart).
  const ledger = openLedger(":memory:");
  writeLendCentralOrder(ledger, order.orderId, { taskId: "local-task", project: "local-project", peer: "peer-a", family: "codex", step: "write",
    specRev: order.specRev, round: order.round, head: order.head, repo: order.repository, pr: null, wire: { orderId: order.orderId }, text: "t",
    sha256: "a".repeat(64), leaseMs: 60_000, createdBy: "scheduler", branch: "lend/task-abcd", base: "main" });
  const wiring = { transportFor: () => ({ lend: () => transport }) } as unknown as Stage2Wiring;
  const push: LendDeps["push"] = {
    probe: async () => ({ ok: true }),
    work: async t => { trail.push("push"); pushes.push(t); return pushed(); },
    pr: async p => { trail.push("pr"); prs.push(p); return opened(); },
  };
  const ports = lendBindings({ wiring, db: () => ledger, outboxDir: join(directory, "outbox"), push });
  const routing: LendCentralRoutingPort = { route: () => "central", bindingFor: id => id === order.orderId ? entry : null,
    sharedResult: () => ({ summary: "home approved summary", artifactIds: [] }), publishWork: ports.publishWork };
  configureLendCentral({ mode: () => "on", transportFor: () => transport, outboxDir: directory, grant: {
    now: () => 2000, readLend: async () => read, context: async () => ({ contacts: [{ name: "peer-a", fp: entry.binding.fp }], projects: [] }) } });
  configureLendCentralRouting(routing);
  const db = openLendJournal(LEND_JOURNAL_PATH); journals.push(db);
  recordAsked(db, { orderId: "order", peer: "peer-a", fp: entry.binding.fp, family: "codex", preview: {} });
  advance(db, "order", "asked", "claimed", { leaseGen: 1,
    wire: { order: { orderId: "order", taskId: "local-task", head: order.head, step: order.step }, text: "trusted order" } });
  advance(db, "order", "claimed", "cloned", { dir: directory });
  advance(db, "order", "cloned", "started", { agent: worker.agentId, sessionId: "worker-session" });
  const identity: CallerIdentity = { agent: worker.agentId, sessionId: "worker-session", family: "codex", verified: true };
  const deliver = { v: 1, orderId: "order", head: "c".repeat(40), evidence: "evidence.md", summary: "worker raw summary", selfCheck: "local checks" };
  const preflight = LedgerLendCentralClient.prototype.preflight;
  const spy = spyOn(LedgerLendCentralClient.prototype, "preflight").mockImplementation(async function (this: LedgerLendCentralClient, raw: unknown) {
    trail.push("preflight");
    return preflight.call(this, raw);
  });
  return { directory, order, identity, deliver, trail, commands, pushes, prs, restore: () => spy.mockRestore() };
}
const results = (f: { commands: V2Command[] }) => f.commands.filter(c => c.type === "lend.result");

test("[验收线 3] central write delivery: preflight, publish (push then PR) and lend.result once each, in that order", async () => {
  const f = fixture(() => ({ ok: true }), () => ({ ok: true, pr: 77 }));
  try {
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: true, status: "confirmed" });
    expect(f.trail).toEqual(["preflight", "push", "pr", "lend.result"]);
    // The publish names only the order's own branch / base / repository and the delivered head; the PR is opened on that branch.
    expect(f.pushes).toEqual([{ orderId: f.order.orderId, repo: f.order.repository, branch: "lend/task-abcd", base: "main", cloneDir: f.directory,
      orderHead: f.order.head, head: f.deliver.head }]);
    expect(f.prs).toMatchObject([{ orderId: f.order.orderId, repo: f.order.repository, branch: "lend/task-abcd", base: "main", pr: null }]);
    expect(results(f)).toHaveLength(1);
    expect(results(f)[0]!.type === "lend.result" && results(f)[0]!.payload.result).toMatchObject({ head: f.deliver.head, verdict: "delivered" });
  } finally { f.restore(); }
});

test("[验收线 3] the push or the PR fails: lend.result is sent zero times (a refused push never opens a PR)", async () => {
  for (const [name, push, pr, trail] of [
    ["push refused", () => ({ ok: false, reason: "non-fast-forward", retry: false }), () => ({ ok: true, pr: 77 }), ["preflight", "push"]],
    ["PR failed", () => ({ ok: true }), () => ({ ok: false, reason: "gh: rate limited", retry: true }), ["preflight", "push", "pr"]],
  ] as const) {
    const f = fixture(push as () => Answer, pr as () => ({ ok: false; reason: string; retry: boolean }));
    try {
      expect(await answerLendTool("deliver", f.identity, f.deliver), name).toMatchObject({ ok: false, code: "publish_failed" });
      expect(f.trail, name).toEqual([...trail]);
      expect(results(f), name).toHaveLength(0);
    } finally {
      f.restore();
      configureLendCentral(null); configureLendCentralRouting(null); closeLedger(":memory:");
      for (const db of journals.splice(0)) db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
    }
  }
});
