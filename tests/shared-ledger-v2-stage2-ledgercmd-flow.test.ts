import { describe, expect, test } from "bun:test";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { coded, FENCE, ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";

describe("stage2 scheduler flows over recording ports", () => {
  test("four cold-start ticks retain local intent/lock/session across sync, then dispatch once", async () => {
    const s = ledgercmdFixture(), scope = s.port.scope!, client = s.port.clientFor("p")!;
    let tick = 0;
    s.port.scope = fn => { if (tick === 1 && s.scopes.length === 1) throw coded("lease_lost"); return scope(fn); };
    s.port.clientFor = () => ({ command: async command => {
      if (tick === 3 && command.type === "intent.check") throw coded("unavailable");
      return client.command(command);
    } });
    const run = async () => {
      tick++;
      const result = await schedulerAutoTick(s.f.db, { p: { maxActiveWorkers: 2 } }, { ...s.f.tickDeps, manager: s.manager });
      expect(result.failed).toEqual([]);
      return result.cards[0];
    };
    expect((await run()).step).toBe("lost_race");
    const ensure = s.f.intents()[0];
    expect(ensure).toMatchObject({ action: "ensure_session", status: "pending" });
    const locks = s.f.db.query("SELECT * FROM scheduler_resources").all();
    await s.port.sync("p", "feature-one");
    expect(s.f.db.query("SELECT * FROM scheduler_resources").all()).toEqual(locks);
    expect((await run()).step).toBe("session");
    const sessions = s.f.db.query("SELECT * FROM scheduler_sessions").all(), local = s.intent(ensure.id);
    await s.port.sync("p", "feature-one");
    expect(s.f.db.query("SELECT * FROM scheduler_sessions").all()).toEqual(sessions);
    expect(s.intent(ensure.id)).toEqual(local);
    await run();
    expect(s.requests.filter(command => command.type === "intent.create")).toHaveLength(1);
    expect(s.f.sent).toHaveLength(0);
    await run();
    expect(s.f.sent).toHaveLength(1);
    expect(s.counters().managerCalls).toBe(0);
  });

  test("an epoch change during ensure refuses binding, records unknown and never dispatches", async () => {
    const s = ledgercmdFixture(), ensure = s.f.tickDeps.ensure;
    const deps = { ...s.f.tickDeps, manager: s.manager, ensure: async (...args: Parameters<typeof ensure>) => {
      const ready = await ensure(...args);
      s.setFence({ ...FENCE, epoch: 2 });
      return ready;
    } };
    for (let tick = 0; tick < 4; tick++) {
      const result = await schedulerAutoTick(s.f.db, { p: { maxActiveWorkers: 2 } }, deps);
      expect(result.failed).toEqual([]);
      await s.port.sync("p", "feature-one");
    }
    expect(s.f.intents()[0]).toMatchObject({ action: "ensure_session", status: "unknown" });
    expect(s.f.db.query("SELECT * FROM scheduler_sessions").all()).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
    expect(s.f.sent).toHaveLength(0);
    expect(s.f.ensured).toHaveLength(1);
  });
});

const HEAD = "a".repeat(40), MERGE = "b".repeat(40);
async function mergeFixture() {
  const s = ledgercmdFixture();
  await s.manager(...s.plan("review-create", "ensure_session", "adversarial_review"));
  await s.settle("review-create", "pending", "submitted");
  await s.manager("ledger", "scheduler-session-bind", "T1", "--role", "reviewer", "--intent", "review-create",
    "--agent", "agent-rv-t1", "--session", "s-rv", "--family", "codex", "--transport", "acp");
  await s.settle("review-create", "submitted", "done");
  s.f.db.query("UPDATE tasks SET stage='merge',round=1,rev=2,headSHA=?,branch='task/T1',pr=? WHERE id='T1'")
    .run(HEAD, "https://github.com/example/repo/pull/42");
  const review = { round: 1, head: HEAD, verdict: "pass", reviewer: "agent-rv-t1", reviewerSessionId: "s-rv", reviewerFamily: "codex",
    path: "reviews/T1-r1/report.md", findings: [], p0: 0, p1: 0, p2: 0 };
  s.f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (1000,'agent-rv-t1','p','T1','review','',?)")
    .run(JSON.stringify(review));
  s.seed("merge-one", "merge", "pending", "merge_deploy"); await s.port.sync("p", "feature-one");
  s.f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-one',1000)").run();
  let merges = 0, externalCalls = 0;
  const external: MergeExternal = {
    inspect: async () => { externalCalls++; return { state: merges ? "MERGED" : "OPEN", head: HEAD, branch: "task/T1", base: "main",
      draft: false, crossRepository: false, mergeState: "CLEAN", mergeSha: merges ? MERGE : null, checks: [{ name: "check", bucket: "pass" }] }; },
    freshness: async () => { externalCalls++; return { behindBy: 0, mainHead: MERGE }; },
    carryReview: async () => ({ ok: false, reason: "unchanged head" }), updateBranch: async () => { throw new Error("no update expected"); },
    merge: async () => { externalCalls++; merges++; return MERGE; },
  };
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: s.f.dir } } });
  const run = () => mergeTick(s.f.db, config, s.manager, () => external, () => {});
  return { ...s, run, externalCounts: () => ({ merges, externalCalls }) };
}

describe("stage2 merge bookkeeping over recording ports", () => {
  test.each(["epoch", "bootId", "serviceGeneration"])("merge bookkeeping rejects a changed %s claim before external calls", async field => {
    const s = await mergeFixture();
    await s.settle("merge-one", "pending", "submitted");
    s.setFence({ ...FENCE, [field]: field === "bootId" ? "boot-two" : 2 });
    expect(await s.manager("ledger", "scheduler-merge-begin", "merge-one", "--required-checks", "check"))
      .toEqual({ ok: false, code: "stale_claim" });
    expect(getMergeRun(s.f.db, "merge-one")).toBeNull();
    await s.run();
    expect(s.intent("merge-one")?.status).toBe("unknown");
    expect(s.externalCounts()).toEqual({ merges: 0, externalCalls: 0 });
  });

  test("merge-step refuses a changed claim even after a journal exists", async () => {
    const s = await mergeFixture();
    await s.settle("merge-one", "pending", "submitted");
    await s.manager("ledger", "scheduler-merge-begin", "merge-one", "--required-checks", "check");
    const before = getMergeRun(s.f.db, "merge-one");
    s.setFence({ ...FENCE, epoch: 2 });
    expect(await s.manager("ledger", "scheduler-merge-step", "merge-one", "--from", "ready", "--to", "await_ci", "--rev", "1"))
      .toEqual({ ok: false, code: "stale_claim" });
    expect(getMergeRun(s.f.db, "merge-one")).toEqual(before);
  });

  test.each(["missing", "null"])("a %s projected claim holds merge bookkeeping", async kind => {
    const s = await mergeFixture();
    await s.settle("merge-one", "pending", "submitted");
    if (kind === "missing") delete s.port.claimFence;
    else s.port.claimFence = () => null;
    const scopes = s.scopes.length;
    expect(await s.manager("ledger", "scheduler-merge-begin", "merge-one", "--required-checks", "check"))
      .toEqual({ ok: false, code: "v2_unmapped" });
    expect(getMergeRun(s.f.db, "merge-one")).toBeNull();
    expect(s.scopes).toHaveLength(scopes);
    expect(s.externalCounts()).toEqual({ merges: 0, externalCalls: 0 });
    expect(s.requests.map(command => command.type)).toEqual(["intent.check"]);
  });

  test("real mergeTick claims centrally, journals locally, merges once and reports centrally", async () => {
    const s = await mergeFixture();
    for (let tick = 0; tick < 5 && s.intent("merge-one")?.status !== "done"; tick++) await s.run();
    expect(getMergeRun(s.f.db, "merge-one")).toMatchObject({ phase: "merged", mergeSha: MERGE });
    expect(s.intent("merge-one")).toMatchObject({ status: "done" });
    expect(s.requests.map(command => command.type)).toEqual(["intent.check", "operation.result"]);
    expect(s.externalCounts().merges).toBe(1);
    expect(s.counters().managerCalls).toBe(0);
    const events = s.f.db.query("SELECT data FROM events WHERE target='T1' AND json_extract(data, '$.op')='merge_phase'").all() as { data: string }[];
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) expect(JSON.parse(event.data).fence).toEqual(FENCE);
    for (const ref of s.scopes.filter(ref => (ref as { claimFence: unknown }).claimFence !== null)) {
      expect((ref as { claimFence: unknown }).claimFence).toEqual(FENCE);
    }
  });

  test("lost fence stops before merge-begin and touches no external port", async () => {
    const s = await mergeFixture();
    s.setFence(null);
    await expect(s.run()).rejects.toThrow();
    expect(getMergeRun(s.f.db, "merge-one")).toBeNull();
    expect(s.externalCounts()).toEqual({ merges: 0, externalCalls: 0 });
    expect(s.requests).toHaveLength(0);
  });
});
