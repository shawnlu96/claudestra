import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerLendCentralClient, type LendCentralTransport } from "../src/lib/ledger-lend-central.js";
import { LedgerLendCentralPresence } from "../src/lib/ledger-lend-central-presence.js";
import { LendCentralOutbox } from "../src/lib/ledger-lend-central-state.js";
import { type LendCentralBinding, type LendCentralGrantDeps, type LendCentralView } from "../src/lib/ledger-lend-central-checks.js";
import {
  parseActor, parseLendOrder, parseLendLease, parseTask, parseReceipt, v2ObjectDigest, V2ContractError,
  type V2Command, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import type { LendEntry, LendRead } from "../src/lib/lend-config.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lend-central-")); directories.push(directory);
  const order = parseLendOrder(fixtures.lendOrder.valid), lease = parseLendLease(fixtures.lendLease.valid);
  const task = parseTask({ ...parseTask(fixtures.task.valid), stage: "review", head: order.head });
  const binding: LendCentralBinding = { order, worker: order.worker!, executorInstanceId: "peer-a", peer: "peer-a",
    fp: "a".repeat(64), homeInstanceId: "local", actor: parseActor({ kind: "service", personId: "person", instanceId: "local",
      serviceId: "lend", representedPersonId: "owner", orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }) };
  let now = 2000;
  const entry: LendEntry = { peer: "peer-a", fp: binding.fp, families: { codex: 2 }, roles: ["review", "write"],
    repos: [order.repository], ordersPerDay: 10, grantedAt: new Date(1000).toISOString(), until: new Date(100000).toISOString() };
  const read: LendRead = { status: "ok", file: { version: 2, enabled: true, lend: [entry], borrow: [] } };
  const grant: LendCentralGrantDeps = { now: () => now, readLend: async () => read,
    context: async () => ({ contacts: [{ name: "peer-a", fp: binding.fp }], projects: [] }) };
  const log: string[] = [], commands: V2Command[] = [], receipts = new Map<string, V2Receipt>();
  const view: LendCentralView = { order, lease, task, now };
  let offline = false, lost = false, commitOnLoss = true;
  const unavailable = () => { if (offline) throw new V2ContractError("unavailable"); };
  const receiptFor = (c: V2Command) => parseReceipt({ ...parseReceipt(fixtures.receipt.valid), command: c.type,
    requestId: c.requestId, commandDigest: v2ObjectDigest(c), result: { entityId: order.orderId, rev: 1, specRev: order.specRev,
      version: null, epoch: c.epoch, operationId: c.type === "lend.result" ? c.payload.result.operationId : null } });
  const transport: LendCentralTransport = {
    receipt: async id => { log.push("receipt"); unavailable(); return receipts.get(id) ?? null; },
    view: async () => { log.push("view"); unavailable(); return structuredClone(view); },
    command: async c => {
      log.push("command"); unavailable(); commands.push(structuredClone(c));
      const r = receiptFor(c);
      if (!lost || commitOnLoss) receipts.set(c.requestId, r);
      if (lost) throw new V2ContractError("unavailable");
      return r;
    },
  };
  const wire = { v: 1, orderId: "order", gen: 1, verdict: { v: 1, orderId: "order", head: order.head,
    verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "local-report.md" }, report: "local report contents",
    session: { id: "worker-session", family: "codex" } };
  const shared = { summary: "approved summary", artifactIds: ["artifact"] };
  const client = () => new LedgerLendCentralClient(binding, transport, grant, new LendCentralOutbox(directory));
  return { directory, order, lease, task, binding, entry, read, grant, view, log, commands, receipts, wire, shared, client, transport, receiptFor,
    offline: (v: boolean) => { offline = v; }, loss: (v: boolean, commit = true) => { lost = v; commitOnLoss = commit; },
    clock: (v: number) => { now = v; view.now = v; } };
}
function beat(orderId = "order", gen = 1) {
  return { v: 1, orders: [{ orderId, gen, phase: "working", lastActivityAt: 2000, excerpt: "" }] };
}

describe("order-scoped central lending", () => {
  test("result only writes frozen lend.result, with full local evidence and approved shared content", async () => {
    const f = fixture();
    expect((await f.client().result(f.wire, f.shared)).status).toBe("confirmed");
    expect(f.log).toEqual(["receipt", "view", "command"]);
    expect(f.commands).toHaveLength(1);
    const c = f.commands[0]!;
    expect(c.type).toBe("lend.result");
    expect(JSON.stringify(c)).not.toContain("local report contents");
    expect(JSON.stringify(c)).not.toContain("local-report.md");
    expect(JSON.stringify(c)).toContain("approved summary");
    const stored = readFileSync(join(f.directory, readdirSync(f.directory).find(x => x.endsWith(".json"))!), "utf8");
    expect(stored).toContain("local report contents");
    expect(f.task.delivery.orderId).toBeNull();
  });
  test("worker cannot cross orders, claim another worker, batch others, or forge actor fields", async () => {
    const f = fixture(), client = f.client();
    await expect(client.result({ ...f.wire, orderId: "other", verdict: { ...f.wire.verdict, orderId: "other" } }, f.shared)).rejects.toThrow("forbidden");
    await expect(client.claim({ v: 1, orderId: "other", worker: "worker" })).rejects.toThrow("forbidden");
    await expect(client.claim({ v: 1, orderId: "order", worker: "other" })).rejects.toThrow("forbidden");
    await expect(client.beat({ v: 1, orders: [...beat().orders, ...beat("other").orders] }, "beat-1")).rejects.toThrow("forbidden");
    await expect(client.result({ ...f.wire, actor: "owner" }, f.shared)).rejects.toThrow("invalid_field");
    expect(f.log).toEqual([]);
    f.binding.actor.orderId = "other";
    expect(f.client).toThrow("forbidden");
  });
  test("binding copied from trusted journal and service actions enforced", async () => {
    const f = fixture(), client = f.client();
    f.binding.order = { ...f.order, orderId: "other" };
    expect((await client.result(f.wire, f.shared)).status).toBe("confirmed");
    const g = fixture(); g.binding.actor.actions = ["lend.renew"];
    await expect(g.client().result(g.wire, g.shared)).rejects.toThrow("forbidden");
    expect(g.commands).toHaveLength(0);
  });
  test("current owner grant is checked after online reads, including revoked or narrowed scope", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.read.file.enabled = false; },
      (f: ReturnType<typeof fixture>) => { f.entry.repos = []; },
      (f: ReturnType<typeof fixture>) => { f.entry.families = {}; },
      (f: ReturnType<typeof fixture>) => { f.entry.paused = { reason: "owner paused" }; },
      (f: ReturnType<typeof fixture>) => { f.entry.fp = "b".repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.entry.until = new Date(1500).toISOString(); },
    ]) {
      const f = fixture(), readView = f.transport.view;
      f.transport.view = async id => { const v = await readView(id); mutate(f); return v; };
      await expect(f.client().result(f.wire, f.shared)).rejects.toThrow("authorization_expired");
      expect(f.commands).toHaveLength(0);
      expect(f.read.file.lend[0]).toBe(f.entry);
    }
  });
  test("beat uses central renewal with the pinned generation and never touches processes", async () => {
    const f = fixture();
    await f.client().beat(beat(), "beat-1");
    expect(f.commands[0]?.type).toBe("lend.renew");
    await expect(f.client().beat(beat("order", 2), "beat-2")).rejects.toThrow("stale_lease_gen");
    const stopped = { ...beat(), orders: [{ ...beat().orders[0], ended: { reason: "revoked", clean: true } }] };
    await expect(f.client().beat(stopped, "beat-3")).rejects.toThrow("unknown_operation");
    f.offline(true);
    await expect(f.client().beat(beat(), "beat-4")).rejects.toThrow("unavailable");
    expect(f.commands).toHaveLength(1);
  });
  test("offline result persists locally; restart reconciles, then only explicit resubmit sends", async () => {
    const f = fixture(); f.offline(true);
    expect((await f.client().result(f.wire, f.shared)).status).toBe("outbox");
    expect(f.commands).toHaveLength(0);
    f.offline(false); f.log.length = 0;
    expect((await f.client().recover("result")).status).toBe("ready");
    expect(f.log).toEqual(["receipt", "view"]);
    expect((await f.client().result(f.wire, f.shared)).status).toBe("ready");
    expect(f.commands).toHaveLength(0);
    f.log.length = 0;
    expect((await f.client().recover("result", true)).status).toBe("confirmed");
    expect(f.log).toEqual(["receipt", "view", "command"]);
    expect((await f.client().recover("result", true)).status).toBe("confirmed");
    expect(f.commands).toHaveLength(1);
  });
  test("lost successful response finds the receipt even after lease/version moves; no second submission", async () => {
    const f = fixture(); f.loss(true);
    expect((await f.client().result(f.wire, f.shared)).status).toBe("outbox");
    f.view.order.status = "done"; f.view.task.specRev = 2; f.clock(200000);
    f.log.length = 0;
    expect((await f.client().recover("result", true)).status).toBe("confirmed");
    expect(f.log).toEqual(["receipt"]);
    expect(f.commands).toHaveLength(1);
  });
  test("lost uncommitted response uses identical command and operation id only after explicit recovery", async () => {
    const f = fixture(); f.loss(true, false);
    expect((await f.client().result(f.wire, f.shared)).status).toBe("outbox");
    const first = structuredClone(f.commands[0]); f.loss(false); f.clock(3000);
    expect((await f.client().recover("result")).status).toBe("ready");
    expect(f.commands).toHaveLength(1);
    expect((await f.client().recover("result", true)).status).toBe("confirmed");
    expect(f.commands[1]).toEqual(first);
  });
  test("concurrent duplicate result calls share durable receipt and send once", async () => {
    const f = fixture();
    const results = await Promise.all([f.client().result(f.wire, f.shared), f.client().result(f.wire, f.shared)]);
    expect(results.map(r => r.status)).toEqual(["confirmed", "confirmed"]);
    expect(f.commands).toHaveLength(1);
    await expect(f.client().result({ ...f.wire, report: "changed" }, f.shared)).rejects.toThrow("dedup_mismatch");
  });
  test("receipt spoofing and central authorization rejection never become confirmed", async () => {
    const f = fixture();
    f.transport.command = async c => ({ ...f.receiptFor(c), personId: "other" });
    await expect(f.client().result(f.wire, f.shared)).rejects.toThrow("dedup_mismatch");
    const g = fixture();
    g.transport.command = async () => { throw new V2ContractError("forbidden"); };
    await expect(g.client().result(g.wire, g.shared)).rejects.toThrow("forbidden");
    expect((await g.client().recover("result")).status).toBe("ready");
  });
  test("recovery checks lease, versions, holder, stage, home and fence before every explicit resubmit", async () => {
    const mutations: ((v: LendCentralView) => void)[] = [
      v => { v.lease!.expiresAt = 1500; v.lease!.renewedAt = 1000; },
      v => { v.order.leaseGen = 2; }, v => { v.order.head = "c".repeat(40); },
      v => { v.task.specRev++; }, v => { v.task.round++; }, v => { v.task.stage = "build"; },
      v => { v.order.epoch++; }, v => { v.order.bootId = "new-boot"; }, v => { v.order.serviceGeneration++; },
      v => { v.order.homeInstanceId = "peer-b"; }, v => { v.order.status = "cancelled"; },
      v => { v.lease!.worker = { kind: "peer_agent", instanceId: "peer-a", agentId: "other" }; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); f.offline(true); await f.client().result(f.wire, f.shared);
      f.offline(false); f.view.order = structuredClone(f.order); f.view.lease = structuredClone(f.lease); mutate(f.view);
      await expect(f.client().recover("result", true)).rejects.toBeInstanceOf(V2ContractError);
      expect(f.commands).toHaveLength(0);
    }
  });
  test("only the first claim response can advance the local driver toward startup", async () => {
    const f = fixture(); f.order.status = "pooled"; f.order.worker = null; f.order.executorInstanceId = null;
    f.view.lease = null;
    const req = { v: 1, orderId: "order", worker: "worker" };
    let startups = 0;
    for (const outcome of [await f.client().claim(req), await f.client().claim(req), await f.client().recover("claim", true)]) {
      if (outcome.status === "confirmed" && outcome.freshClaim) startups++;
    }
    expect(startups).toBe(1);
    expect(f.commands).toHaveLength(1);
  });
  test("claim reconciliation never starts a worker or repeats a successful claim", async () => {
    const f = fixture(); f.order.status = "pooled"; f.order.worker = null; f.order.executorInstanceId = null;
    f.view.lease = null; f.loss(true);
    const req = { v: 1, orderId: "order", worker: (f.binding.worker as { agentId: string }).agentId };
    expect((await f.client().claim(req)).status).toBe("outbox");
    f.order.status = "claimed"; f.order.worker = f.binding.worker; f.order.executorInstanceId = "peer-a";
    expect(await f.client().recover("claim", true)).toMatchObject({ status: "confirmed", freshClaim: false });
    expect(f.commands.map(c => c.type)).toEqual(["lend.claim"]);
    expect(Object.keys(f.transport)).toEqual(["receipt", "view", "command"]);
  });
  test("a missing previously confirmed central receipt blocks resubmission after restore", async () => {
    const f = fixture();
    await f.client().result(f.wire, f.shared);
    f.receipts.clear();
    await expect(f.client().recover("result", true)).rejects.toThrow("sequence_regressed");
    expect(f.commands).toHaveLength(1);
  });
  test("recovery cannot repin an old result to a newer spec revision", async () => {
    const f = fixture(); f.offline(true); await f.client().result(f.wire, f.shared);
    f.offline(false); f.order.specRev++; f.task.specRev++; f.log.length = 0;
    await expect(f.client().recover("result", true)).rejects.toThrow("stale_order");
    expect(f.log).toEqual([]);
    expect(f.commands).toHaveLength(0);
  });
  test("corrupt local outbox is preserved and never replaced by a fresh command", async () => {
    const f = fixture(); f.offline(true); await f.client().result(f.wire, f.shared);
    const path = join(f.directory, readdirSync(f.directory).find(x => x.endsWith(".json"))!);
    writeFileSync(path, "broken local state"); f.offline(false);
    await expect(f.client().recover("result", true)).rejects.toThrow("outbox corrupt");
    expect(readFileSync(path, "utf8")).toBe("broken local state");
    expect(f.commands).toHaveLength(0);
  });
  test("write result carries new head but pins the original order head and branch", async () => {
    const f = fixture(); f.order.step = "write"; f.order.branch = "lend/task-abcd"; f.order.base = "main"; f.task.stage = "build";
    const wire = { v: 1, orderId: "order", gen: 1, deliver: { v: 1, orderId: "order", head: "c".repeat(40),
      evidence: "local-evidence.md", summary: "local summary", selfCheck: "local checks" }, branch: "lend/task-abcd", pr: 1,
      session: { id: "worker-session", family: "codex" } };
    await expect(f.client().result({ ...wire, branch: "lend/other-abcd" }, f.shared)).rejects.toThrow("stale_order");
    expect((await f.client().result(wire, f.shared)).status).toBe("confirmed");
    const c = f.commands[0]!;
    if (c.type !== "lend.result") throw Error("wrong command");
    expect(c.payload.result.head).toBe(wire.deliver.head);
    expect(c.payload.result.expectedHead).toBe(f.order.head);
    expect(c.payload.result.verdict).toBe("delivered");
  });
});

describe("trusted bridge presence proxy", () => {
  function presence() {
    const f = fixture(), forwards: unknown[] = [];
    f.order.status = "pooled"; f.order.worker = null; f.order.executorInstanceId = null;
    const p = new LedgerLendCentralPresence({ teamId: "team", projectId: "project", homeInstanceId: "local",
      executorInstanceId: "peer-a", peer: "peer-a", fp: f.binding.fp }, {
      hello: async req => { forwards.push(req); return { accepted: true }; },
      offer: async req => { forwards.push(req); return { accepted: ["order"] }; }, order: async () => f.order,
    }, f.grant);
    const hello = { v: 1, proto: 2, boot: "boot-local", seq: 1, grant: { until: 100000, roles: ["review", "write"],
      repos: [f.order.repository], ordersPerDay: 10, ordersLeftToday: 10 },
      slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null };
    const offer = { v: 1, proto: 2, orders: [{ orderId: "order", taskId: "task", step: "review", family: "codex",
      repo: f.order.repository, pr: 1, head: f.order.head, round: 0, specRev: 1, offeredAt: 1000 }] };
    return { ...f, p, forwards, hello, offer };
  }
  test("hello/offer retain existing wire shapes and cannot start work", async () => {
    const f = presence();
    await f.p.hello(f.hello); await f.p.offer(f.offer);
    expect(f.forwards).toEqual([f.hello, f.offer]);
    expect(f.commands).toHaveLength(0);
  });
  test("center advertisements cannot expand owner slot, repository, lifetime or daily grants", async () => {
    const f = presence();
    await expect(f.p.hello({ ...f.hello, slots: { ...f.hello.slots, codex: { total: 3, busy: 0 } } })).rejects.toThrow("authorization_mismatch");
    for (const g of [{ repos: ["team/other"] }, { until: 200000 }, { ordersPerDay: 20 }, { ordersLeftToday: 20 }]) {
      await expect(f.p.hello({ ...f.hello, grant: { ...f.hello.grant, ...g } })).rejects.toThrow("authorization_mismatch");
    }
    await expect(f.p.hello({ ...f.hello, launch: "process" })).rejects.toThrow("invalid_field");
    expect(f.forwards).toHaveLength(0);
  });
  test("offers match central order, project and local grant; revoked grants allow zero-capacity hello only", async () => {
    const f = presence();
    await expect(f.p.offer({ ...f.offer, orders: [{ ...f.offer.orders[0], specRev: 2 }] })).rejects.toThrow("stale_order");
    f.order.projectId = "other";
    await expect(f.p.offer(f.offer)).rejects.toThrow("forbidden");
    f.order.projectId = "project"; f.read.file.enabled = false;
    await expect(f.p.offer(f.offer)).rejects.toThrow("authorization_expired");
    await expect(f.p.hello(f.hello)).rejects.toThrow("authorization_expired");
    await f.p.hello({ ...f.hello, grant: null, slots: { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } } });
    expect(f.forwards).toHaveLength(1);
  });
});
