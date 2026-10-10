import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as asks from "../src/bridge/shared-ledger-v2-asks.js";
import { sharedLedgerV2Bridge } from "../src/bridge/shared-ledger-v2-wiring.js";
import { requireSharedExecEntry, sharedExecCommand, sharedExecEntryPort } from "../src/bridge/shared-ledger-v2-entry.js";
import { lendCentralRoutingEnabled } from "../src/bridge/shared-ledger-v2-lend.js";
import { LendCentralJournal } from "../src/bridge/shared-ledger-v2-lend-journal.js";
import type { Principal } from "../src/lib/principals.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { sharedExecRun, SHARED_EXEC_CMDS } from "../src/manager/ledger-shared-exec-cmds.js";
import { schedulerV2MergePort } from "../src/lib/scheduler-v2-merge-context.js";
import { schedulerV2PassManager, schedulerV2Route } from "../src/lib/scheduler-v2-pass.js";
import { withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import { withSchedulerV2Retire } from "../src/lib/scheduler-v2-retire.js";
import { initSchedulerV2, schedulerV2Wiring } from "../src/lib/scheduler-v2-wiring.js";
import { SharedLedgerExecClient } from "../src/lib/shared-ledger-exec-client.js";
import { parseCommand, parseActor, parseLendOrder, parseLendLease, parseTask, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import type { Stage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { PROJECT, SCOPE, wiringFixture } from "./shared-ledger-v2-stage2-wiring-fixture.test.js";

// The fixture's hooks bind only to its first importer; a lazily started daemon wiring from another file must not leak in here.
beforeEach(async () => { await schedulerV2Wiring()?.stop(); sharedLedgerV2Bridge()?.stop(); });

const principal = (id: string): Principal => ({ id, role: "owner", agents: ["*"], createdAt: "2026-01-01" });
const noLeases = { current: () => null, stop: async () => {} };
const command = (): V2Command => parseCommand({ teamId: SCOPE.teamId, projectId: SCOPE.projectId, serviceGeneration: 1, epoch: 1, bootId: "boot", requestId: "req-1",
  type: "lease.release", payload: { taskId: "T", reason: "synthetic" } });

describe("S2F acceptance 1: credentials", () => {
  test("no credential: every configure gets null and execution entries answer unavailable", async () => {
    const f = await wiringFixture({ credentials: false });
    const configured = spyOn(asks, "configureSharedAsks");
    try {
      const bridge = f.bridge();
      const scheduler = initSchedulerV2({ dir: f.dir, db: () => f.db, instanceId: () => "home" });
      expect(configured.mock.calls.map((c) => c[0])).toEqual([null]);
      expect(sharedExecEntryPort()).toBeNull();
      expect(lendCentralRoutingEnabled()).toBe(false);
      expect(schedulerV2MergePort()).toBeNull();
      const m = async () => ({ ok: true });
      expect(schedulerV2PassManager(m)).toBe(m);
      const deps = { manager: m } as never;
      expect(withSchedulerV2Intents(deps)).toBe(deps);
      expect(withSchedulerV2Retire(f.db, deps)).toBe(deps);
      expect(() => requireSharedExecEntry(PROJECT, true)).toThrow("unavailable");
      await expect(sharedExecCommand(principal("owner:self"), PROJECT, command())).rejects.toThrow("unavailable");
      expect(bridge.route("T")).toBe("skip");
      expect(scheduler.route("L")).toBe("local");
      expect(scheduler.leases.current("f")).toBeNull();
    } finally { configured.mockRestore(); }
  });

  test("credentials: S2A and S2E share a client for the same Principal + project, never across Principals", async () => {
    const f = await wiringFixture();
    const configured = spyOn(asks, "configureSharedAsks");
    try {
      f.bridge();
      const asksPort = configured.mock.calls[0]![0]!;
      const entry = sharedExecEntryPort()!;
      const own = asksPort.clientFor(PROJECT);
      expect(own).toBeInstanceOf(SharedLedgerExecClient);
      expect(entry.clientFor(principal("owner:self"), PROJECT)).toBe(own);
      const member = entry.clientFor(principal("token:member"), PROJECT);
      expect(member).toBeInstanceOf(SharedLedgerExecClient);
      expect(member).not.toBe(own);
      expect(entry.clientFor(principal("token:member"), PROJECT)).toBe(member);
      // A Principal with no credential of its own never borrows another's client.
      expect(entry.clientFor(principal("token:stranger"), PROJECT)).toBeNull();
      expect(entry.scopeFor!(principal("owner:self"), PROJECT)).toEqual({ teamId: SCOPE.teamId, projectId: SCOPE.projectId });
      expect(asksPort.featureOfTask("T")).toEqual({ localFeatureId: "f", projectId: PROJECT, centerFeatureId: "center-feature", epoch: 1 });
      expect(asksPort.featureOfTask("L")).toBeNull();
    } finally { configured.mockRestore(); }
  });

  test("a project without a binding has no client even with credentials", async () => {
    const f = await wiringFixture({ bound: false });
    f.bridge();
    expect(sharedExecEntryPort()!.clientFor(principal("owner:self"), PROJECT)).toBeNull();
  });
});

function cli(db: import("bun:sqlite").Database, actor: string, args: string[]) {
  const spec = SHARED_EXEC_CMDS["shared-exec"]!;
  const pos: string[] = [], flags: Record<string, string> = {}, bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    if (spec.bools?.includes(name)) bools.add(name); else flags[name] = args[++i]!;
  }
  return new LedgerCli({ db, actor, projectIds: [PROJECT], now: Date.now, loadRegistry: async () => ({ agents: {} }) as never,
    saveRegistry: async () => {} }, { pos: ["shared-exec", ...pos], flags, bools });
}

describe("S2F acceptance 2: ledger shared-exec", () => {
  test("switch prints effective mode and release entries; release is owner-only; revoke turns the next route skip", async () => {
    const f = await wiringFixture();
    const run = (actor: string, ...args: string[]) => sharedExecRun(cli(f.db, actor, args), { dir: f.dir });
    expect(await run("owner", "switch", PROJECT)).toMatchObject({ effective: "off", recorded: "off", release: null });
    await expect(run("owner", "switch", PROJECT, "on")).rejects.toThrow("valid release");
    await expect(run("agent-x", "release", PROJECT, "--kind", "drill", "--ask", "ask-1", "--expires-at", String(Date.now() + 3600_000)))
      .rejects.toThrow("只认 owner");
    await expect(run("agent-x", "switch", PROJECT, "on")).rejects.toThrow("只认 owner");
    const granted = await run("owner", "release", PROJECT, "--kind", "drill", "--ask", "ask-1", "--expires-at", String(Date.now() + 3600_000));
    expect(granted).toMatchObject({ release: { kind: "drill", askId: "ask-1", state: "有效" } });
    expect(await run("owner", "switch", PROJECT, "on")).toMatchObject({ effective: "on", recorded: "on" });

    const bridge = f.bridge();
    expect(bridge.route("T")).toBe("central");
    expect(bridge.route("L")).toBe("local");
    await expect(run("agent-x", "release", PROJECT, "--revoke")).rejects.toThrow("只认 owner");
    expect(await run("owner", "release", PROJECT, "--revoke")).toMatchObject({ effective: "observe", recorded: "on", release: null });
    expect(bridge.route("T")).toBe("skip"); // same process, very next check
    // An expired entry is labelled, and reads as observe.
    const later = await sharedExecRun(cli(f.db, "owner", ["release", PROJECT, "--kind", "drill", "--ask", "ask-2",
      "--expires-at", String(Date.now() + 1000)]), { dir: f.dir });
    expect(later).toMatchObject({ effective: "on" });
    expect(await sharedExecRun(cli(f.db, "owner", ["switch", PROJECT]), { dir: f.dir, now: () => Date.now() + 5000 }))
      .toMatchObject({ effective: "observe", release: { state: "已过期" } });
    await expect(run("owner", "switch", PROJECT, "bogus")).rejects.toThrow("用法");
  });

  test("recover reads receipt, lease and version first and submits nothing without --resubmit", async () => {
    const f = await wiringFixture();
    const worker = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "agent-lend" };
    const order = parseLendOrder({ ...parseLendOrder(fixtures.lendOrder.valid), worker });
    const view = { order, lease: parseLendLease({ ...parseLendLease(fixtures.lendLease.valid), worker }),
      task: parseTask({ ...parseTask(fixtures.task.valid), head: order.head }), now: 2000 };
    const calls: string[] = [];
    const transport = { lend: () => ({
      receipt: async () => { calls.push("receipt"); return null; },
      view: async () => { calls.push("view"); return structuredClone(view); },
      command: async () => { calls.push("command"); throw new Error("must not submit"); },
    }), receipt: async () => { calls.push("receipt"); return { status: "unknown" }; } } as unknown as Stage2Transport;
    const wiring = new Stage2Wiring({ dir: f.dir, connect: () => ({ transport, personId: "person-owner", instanceId: "home" }) });
    // A journal-pinned binding (the only kind S2L reaches the center with) for the execution card.
    const outbox = join(f.dir, "shared-ledger-v2-lend");
    mkdirSync(outbox, { recursive: true });
    await new LendCentralJournal(outbox).pin({ localProjectId: PROJECT, localTaskId: "T", binding: { order, worker,
      executorInstanceId: "peer-a", peer: "peer-a", fp: "a".repeat(64), homeInstanceId: "local",
      actor: parseActor({ kind: "service", personId: "person", instanceId: "local", serviceId: "lend", representedPersonId: "owner",
        orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }) } });
    await sharedExecRun(cli(f.db, "owner", ["release", PROJECT, "--kind", "drill", "--ask", "ask-1",
      "--expires-at", String(Date.now() + 3600_000)]), { dir: f.dir });
    await sharedExecRun(cli(f.db, "owner", ["switch", PROJECT, "on"]), { dir: f.dir });
    const out = await sharedExecRun(cli(f.db, "owner", ["recover", PROJECT, "--order", order.orderId, "--kind", "result"]), { dir: f.dir, wiring });
    expect(out).toMatchObject({ ok: true, orderId: order.orderId, view: { order: { orderId: order.orderId } } });
    expect(calls[0]).toBe("view");
    expect(calls).not.toContain("command");
    await expect(sharedExecRun(cli(f.db, "owner", ["recover", PROJECT, "--order", order.orderId]), { dir: f.dir, wiring })).rejects.toThrow("用法");
    expect(await sharedExecRun(cli(f.db, "owner", ["receipt", PROJECT, "--request", "req-1", "--digest", "d".repeat(64)]), { dir: f.dir, wiring }))
      .toMatchObject({ ok: true, receipt: { status: "unknown" } });
  });

  test("observe-log lists recorded decisions per project", async () => {
    const f = await wiringFixture();
    const wiring = new Stage2Wiring({ dir: f.dir });
    wiring.observe({ project: PROJECT, taskId: "T", code: "observe" });
    wiring.observe({ project: "other", taskId: "X", code: "observe" });
    expect(await sharedExecRun(cli(f.db, "agent-x", ["observe-log", PROJECT]), { dir: f.dir }))
      .toMatchObject({ ok: true, entries: [{ project: PROJECT, taskId: "T" }] });
  });

  test("routes and schedulerV2Route agree in the scheduler wiring", async () => {
    const f = await wiringFixture();
    const w = initSchedulerV2({ dir: f.dir, db: () => f.db, instanceId: () => "home", leases: noLeases });
    expect(w.route("T")).toBe(schedulerV2Route("T", f.db));
    expect(w.route("T")).toBe("skip");
  });
});
