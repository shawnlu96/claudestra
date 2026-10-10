import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import * as ledgerWrite from "../src/lib/ledger-write.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { withSchedulerV2LedgerCmds, type SchedulerV2ExecutorCall } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { configureSchedulerV2Intents, schedulerV2EnsureClaimFence, withSchedulerV2Intents,
  type SchedulerV2IntentPort } from "../src/lib/scheduler-v2-intent.js";
import { withExecutorScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { FENCE, ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

const execution = { authorityMode: "execution", sharedPlanning: true,
  centerExecution: { centerId: "center", teamId: "team", projectId: "center-project", centerFeatureId: "center-feature", epoch: 1 } };

/**
 * Real schedulerAutoTick over a synthetic ledger: S2I wraps the fixture's original ports, its wrapManager is the real S2Q
 * (withSchedulerV2LedgerCmds) against the recording center, and `settled` re-reads the fixture's projection (S2F's job).
 * The executor token is the fixture's recording scope; with `gate` it is the real S2G withExecutorScope, which only the
 * "fence null" case can use today: S2G stamps leaseId into the event fence and the existing S2Q claim-fence parse rejects it,
 * so a real S2G bind / settle still fails (invalid_field). That round trip is S2F's acceptance, not claimed here.
 */
function flow(opts: { gate?: boolean; manager?: (m: AutoTickDeps["manager"]) => AutoTickDeps["manager"] } = {}) {
  const s = ledgercmdFixture(), db = s.f.db;
  if (opts.gate) {
    writeFileSync(join(s.f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-one": execution } }));
    s.port.scope = (fn) => {
      const { ref } = (fn as SchedulerV2ExecutorCall<unknown>).executor;
      s.scopes.push(ref);
      return withExecutorScope(db, { ...ref, leaseIdOf: () => "lease-1" }, fn);
    };
  }
  let realCalls = 0;
  const center = intentCenter(s.port.clientFor("p")!);
  const port: SchedulerV2IntentPort = {
    route: (id) => s.port.route(id),
    wrapManager: (m) => {
      const s2q = withSchedulerV2LedgerCmds(async (...args) => { realCalls++; return m(...args); }, s.port);
      return opts.manager ? opts.manager(s2q) : s2q;
    },
    fence: () => s.port.fence("feature-one"),
    claimFence: (taskId, role) => schedulerV2EnsureClaimFence(db, taskId, role),
    central: (taskId, intentId) => center.bound(taskId, intentId, s.f.task().headSHA, "dispatch"),
    settled: async (_taskId, intentId, to) => {
      await s.port.sync("p", "feature-one");
      const intent = getIntent(db, intentId);
      return { ok: intent?.status === to, intent };
    },
  };
  configureSchedulerV2Intents(port);
  const deps = withSchedulerV2Intents(s.f.tickDeps);
  const tick = async () => {
    const r = await schedulerAutoTick(db, { p: { maxActiveWorkers: 2 } }, deps);
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const ensureIntent = () => s.f.intents().find((i) => i.action === "ensure_session")!;
  const sessions = () => db.query("SELECT * FROM scheduler_sessions").all() as Record<string, unknown>[];
  const locks = (id: string) => db.query("SELECT * FROM scheduler_resources WHERE intentId = ?").all(id);
  return { ...s, db, deps, tick, ensureIntent, sessions, locks, realCalls: () => realCalls, center };
}

describe("S2I ensure over real schedulerAutoTick + S2Q + recording executor scope (real S2G only where it passes today)", () => {
  test("valid fence: ensure once, zero center requests, lock and session through the token, lock gone after done", async () => {
    let seenDuring: unknown[] = [];
    const s = flow(), ensure = s.f.tickDeps.ensure;
    s.f.tickDeps.ensure = async (...args) => { seenDuring = s.locks(s.ensureIntent().id); return ensure(...args); };
    const deps = withSchedulerV2Intents(s.f.tickDeps);
    const r = await schedulerAutoTick(s.db, { p: { maxActiveWorkers: 2 } }, deps);
    expect(r.failed).toEqual([]);
    expect(r.cards[0]).toMatchObject({ step: "session" });
    expect(s.f.ensured).toHaveLength(1);
    expect(s.requests).toHaveLength(0); // no intent.create / intent.check for a home-local action
    expect(s.center.calls).toHaveLength(0);
    expect(seenDuring).toHaveLength(1);
    const intent = s.ensureIntent();
    expect(intent.status).toBe("done");
    expect(s.locks(intent.id)).toEqual([]);
    expect(s.sessions()).toHaveLength(1);
    expect(s.sessions()[0]).toMatchObject({ taskId: "T1", role: "author", createIntentId: intent.id, state: "active" });
    const events = s.db.query("SELECT data FROM events WHERE actor='scheduler' AND kind='scheduler'").all() as { data: string }[];
    expect(events.length).toBeGreaterThanOrEqual(4); // plan, claim, bind, done
    for (const e of events) expect(JSON.parse(e.data).fence).toMatchObject(FENCE);
    expect(s.realCalls()).toBe(0);
  });

  test("fence null after the claim (real S2G gate): ensure never runs, wait; the cancel is refused and the intent stays submitted", async () => {
    let lose = false;
    const s = flow({ gate: true, manager: (m) => async (...args) => {
      const r = await m(...args);
      if (args[1] === "scheduler-settle" && args.includes("submitted") && args[args.indexOf("--to") + 1] === "submitted" && r.ok === true) lose = true;
      return r;
    } });
    const fence = s.port.fence;
    s.port.fence = (id) => lose ? null : fence(id);
    expect(await s.tick()).toMatchObject({ step: "waiting", detail: "lease" });
    expect(s.f.ensured).toHaveLength(0);
    expect(s.ensureIntent().status).toBe("submitted");
    expect(s.sessions()).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
  });

  test("fence replaced by a new epoch during ensure: unknown, no bind, no rebuild on the next tick", async () => {
    const s = flow(), ensure = s.f.tickDeps.ensure;
    s.f.tickDeps.ensure = async (...args) => { const got = await ensure(...args); s.setFence({ ...FENCE, epoch: 2 }); return got; };
    const deps = withSchedulerV2Intents(s.f.tickDeps);
    const run = async () => (await schedulerAutoTick(s.db, { p: { maxActiveWorkers: 2 } }, deps)).cards[0];
    expect(await run()).toMatchObject({ step: "held" });
    expect(s.ensureIntent().status).toBe("unknown"); // the new term may only mark the old claim unknown
    expect(s.sessions()).toHaveLength(0);
    const unknown = s.db.query("SELECT data FROM events WHERE dedupKey = ?").get(`scheduler:${s.ensureIntent().id}:unknown`) as { data: string };
    expect(JSON.parse(unknown.data)).toMatchObject({ fence: { epoch: 2 }, claimFence: { epoch: 1 } });
    expect(await run()).toMatchObject({ step: "held" });
    expect(s.f.ensured).toHaveLength(1);
    expect(s.requests).toHaveLength(0);
    expect(s.f.sent).toHaveLength(0);
  });
});

describe("S2I central dispatch and stage over real schedulerAutoTick + S2Q", () => {
  test("dispatch: S2Q creates the intent; S2I checks the center before the send and reports once; one send", async () => {
    const s = flow();
    expect(await s.tick()).toMatchObject({ step: "session" });
    const before = s.requests.length;
    let last: unknown;
    for (let i = 0; i < 3 && s.f.sent.length === 0; i++) last = await s.tick();
    expect(s.f.sent).toHaveLength(1);
    expect(last).toMatchObject({ step: "sent" });
    // Counted on the whole shared transport (X8 and S2Q together): exactly one result for the operation, none from the settle.
    const results = s.requests.filter((c) => c.type === "operation.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.type === "operation.result" && results[0]!.payload.result).toMatchObject({ state: "succeeded" });
    expect(s.requests.slice(before).map((c) => c.type)).toEqual(["intent.create", "intent.check",
      "authorization.check", "intent.check", "authorization.check", "intent.check", "operation.result"]);
    const sentIntent = s.f.intents().find((i) => i.action === "dispatch")!;
    expect(sentIntent.status).toBe("done"); // projected back from X8's report, not settled locally
    expect(await s.tick()).not.toMatchObject({ step: "sent" });
    expect(s.f.sent).toHaveLength(1);
    expect(s.requests.filter((c) => c.type === "operation.result")).toHaveLength(1);
    expect(s.requests[before]?.type).toBe("intent.create"); // S2Q's scheduler-plan mapping builds the central intent
    // S2I's own requests: fresh checks immediately before the send, X8's recheck after it, one result report.
    expect(s.center.calls.map((c) => c.type)).toEqual(["authorization.check", "intent.check", "authorization.check", "intent.check", "operation.result"]);
    const result = s.center.calls.at(-1)!;
    expect(result.type === "operation.result" && result.payload.result).toMatchObject({ state: "succeeded", ...FENCE });
    const sendAt = s.requests.findIndex((c) => c.type === "authorization.check");
    expect(s.requests.slice(before, sendAt).map((c) => c.type)).toEqual(["intent.create", "intent.check"]); // S2Q claim
    expect(s.realCalls()).toBe(0);
  });

  test("transport refusal on a central card: one unknown result, the intent is held unknown, later ticks never wait as sent", async () => {
    const s = flow();
    expect(await s.tick()).toMatchObject({ step: "session" });
    s.f.setSend("refuse");
    let last: unknown;
    for (let i = 0; i < 3 && !s.requests.some((c) => c.type === "operation.result"); i++) last = await s.tick();
    expect(s.f.sent).toHaveLength(0);
    expect(last).toMatchObject({ step: "held" });
    const results = s.requests.filter((c) => c.type === "operation.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.type === "operation.result" && results[0]!.payload.result.state).toBe("unknown");
    const dispatch = s.f.intents().find((i) => i.action === "dispatch")!;
    expect(dispatch.status).toBe("unknown");
    for (let i = 0; i < 3; i++) expect(await s.tick()).not.toMatchObject({ step: "waiting" });
    expect(s.f.sent).toHaveLength(0);
    expect(s.requests.filter((c) => c.type === "operation.result" || c.type === "intent.cancel")).toHaveLength(1);
    expect(s.realCalls()).toBe(0);
  });

  test("local card switched to skip between the claim and the send: zero sends, zero center requests", async () => {
    let flip = false;
    const s = flow({ manager: (m) => async (...args) => {
      const r = await m(...args);
      if (flip && args[1] === "scheduler-settle" && args[args.indexOf("--to") + 1] === "submitted" && r.ok === true) s.setRoute("skip");
      return r;
    } });
    s.setRoute("local");
    expect(await s.tick()).toMatchObject({ step: "session" });
    flip = true;
    expect(await s.tick()).not.toMatchObject({ step: "sent" });
    expect(s.f.sent).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
    expect(s.center.calls).toHaveLength(0);
  });

  test("stage on an execution card goes to the center as task.stage; local applyMove is never called", async () => {
    const s = flow(), client = s.port.clientFor;
    s.setRoute("local");
    const real = s.realCalls;
    s.port.clientFor = () => null; // the local phase must not reach the center either
    expect(await s.tick()).toMatchObject({ step: "session" });
    expect(await s.tick()).toMatchObject({ step: "sent" });
    await s.f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
    await s.f.cli("pm", "restate-approve", "T1");
    expect(s.requests).toHaveLength(0);
    const localCalls = real();
    s.setRoute("central");
    s.port.clientFor = client;
    const move = spyOn(ledgerWrite, "applyMove");
    try {
      expect(await s.tick()).toMatchObject({ step: "stage" });
      expect(s.requests.map((c) => c.type)).toEqual(["intent.create", "task.stage"]);
      expect(s.requests[1]).toMatchObject({ payload: { from: "restate", to: "build" } });
      expect(s.f.task().stage).toBe("build"); // projected back by sync, not by a local move
      expect(move).toHaveBeenCalledTimes(0);
      expect(s.realCalls()).toBe(localCalls);
    } finally { move.mockRestore(); }
  });
});
