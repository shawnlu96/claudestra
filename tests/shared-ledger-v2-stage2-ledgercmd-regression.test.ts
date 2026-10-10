import { describe, expect, test } from "bun:test";
import { createTask } from "../src/lib/ledger-write.js";
import { ledgercmdFixture, ledgercmdReviewedMerge, seq } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";

describe("stage2 ledger command review regressions", () => {
  test.each(["scheduler-ui-ask", "scheduler-review-snapshot", "scheduler-model-outcome", "future-intent-command"])(
    "%s resolves an intent before deciding whether to hold", async command => {
      const s = ledgercmdFixture();
      s.seed("ui-one", "ask"); await s.port.sync("p", "feature-one");
      s.port.route = id => id === "T1" ? "central" : "local";
      const before = seq(s.f.db);
      expect(await s.manager("ledger", command, "ui-one")).toEqual({ ok: false, code: "v2_unmapped" });
      expect(s.counters().managerCalls).toBe(0);
      expect(s.requests).toHaveLength(0);
      expect(seq(s.f.db)).toBe(before);
      expect(s.observations).toEqual(["v2_unmapped"]);
    },
  );

  test("plan replay returns duplicate before checking advanced versions, and never creates again", async () => {
    const s = ledgercmdFixture(), args = s.plan("replay", "dispatch");
    expect(await s.manager(...args)).toMatchObject({ ok: true, duplicate: false });
    await s.port.sync("p", "feature-one");
    s.f.db.query("UPDATE tasks SET rev=rev+1 WHERE id='T1'").run();
    const before = seq(s.f.db), counters = s.counters();
    expect(await s.manager(...args)).toEqual({ ok: true, intent: s.intent("replay"), duplicate: true });
    expect(s.requests).toHaveLength(1);
    expect(s.counters()).toEqual(counters);
    expect(seq(s.f.db)).toBe(before);
  });

  test("replay uses the preserved proposal when center fields differ, even after locks are released", async () => {
    const s = ledgercmdFixture(), args = s.plan("replay", "dispatch", "restate", "task:s1,src/lib/x.ts");
    await s.manager(...args);
    await s.settle("replay", "pending", "submitted");
    await s.settle("replay", "submitted", "done");
    s.f.db.query("UPDATE scheduler_intents SET causalSeq=999,reason='center reason',recipient=NULL WHERE id='replay'").run();
    expect(s.f.db.query("SELECT * FROM scheduler_resources WHERE intentId='replay'").all()).toHaveLength(0);
    const before = seq(s.f.db), requests = s.requests.length;
    expect(await s.manager(...args)).toEqual({ ok: true, intent: s.intent("replay"), duplicate: true });
    expect(s.requests).toHaveLength(requests);
    expect(seq(s.f.db)).toBe(before);
  });

  test("missing original plan resources holds a replay without guessing from current locks", async () => {
    const s = ledgercmdFixture(), args = s.plan("legacy", "dispatch");
    s.seed("legacy", "dispatch", "pending", "restate"); await s.port.sync("p", "feature-one");
    expect(await s.manager(...args)).toEqual({ ok: false, code: "v2_unmapped" });
    expect(s.requests).toHaveLength(0);
    expect(s.counters().managerCalls).toBe(0);
  });

  test.each(["node", "action", "recipient", "reason", "seq", "rev", "resources"])(
    "plan replay refuses a changed %s with dedup_mismatch", async flag => {
      const s = ledgercmdFixture(), args = s.plan("replay", "dispatch");
      await s.manager(...args);
      const changed = [...args], index = changed.indexOf(`--${flag}`);
      const value = flag === "rev" || flag === "seq" ? "999" : flag === "action" ? "review" : "different";
      if (index >= 0) changed[index + 1] = value;
      else changed.push(`--${flag}`, value);
      expect(await s.manager(...changed)).toEqual({ ok: false, code: "dedup_mismatch" });
      expect(s.requests).toHaveLength(1);
      expect(s.counters().managerCalls).toBe(0);
    },
  );

  test.each(["freeze", "dependency", "worker-slots"])("%s refuses a central plan without writes", async guard => {
    const s = ledgercmdFixture();
    if (guard === "freeze") s.f.db.query("INSERT INTO meta (project,key,value) VALUES ('p','queueFrozen',?)")
      .run(JSON.stringify({ frozen: true, reason: "test", since: 1000 }));
    if (guard === "dependency") {
      createTask(s.f.db, { actor: "owner", now: 2000 }, { project: "p", id: "upstream", title: "upstream", kind: "code" });
      s.f.db.query("INSERT INTO task_deps (project,fromTask,toTask,kind,createdBy,createdAt,updatedAt) " +
        "VALUES ('p','upstream','T1','blocks','owner',1000,1000)").run();
    }
    const before = seq(s.f.db), rows = s.f.db.query("SELECT * FROM scheduler_resources").all();
    const resources = guard === "worker-slots" ? "slot:p:0,slot:p:1" : "task:s1";
    expect(await s.manager(...s.plan("guarded", "dispatch", "restate", resources))).toEqual({ ok: false, code: "conflict" });
    expect(s.requests).toHaveLength(0);
    expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
    expect(seq(s.f.db)).toBe(before);
    expect(s.f.db.query("SELECT * FROM scheduler_resources").all()).toEqual(rows);
  });

  test("an authorized merge without the current review is refused before intent.create", async () => {
    const s = ledgercmdFixture();
    s.f.db.query("UPDATE tasks SET stage='merge',round=1,headSHA=? WHERE id='T1'").run("a".repeat(40));
    s.f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1000,'fake-projection','p','T1','scheduler','',?,?)")
      .run(JSON.stringify({ authorizationAskId: "owner-ask", authorizationDigest: "a".repeat(64) }), "scheduler:merge-new");
    const before = seq(s.f.db);
    expect(await s.manager(...s.plan("merge-new", "merge", "merge_deploy"))).toEqual({ ok: false, code: "conflict" });
    expect(s.requests).toHaveLength(0);
    expect(seq(s.f.db)).toBe(before);
  });

  test.each(["cancelled", "receipt", "family", "head", "node"])("merge %s guard runs before center creation", async guard => {
    const s = ledgercmdFixture();
    await ledgercmdReviewedMerge(s, guard !== "receipt");
    if (guard === "cancelled") { s.seed("cancelled-merge", "merge", "cancelled", "merge_deploy"); await s.port.sync("p", "feature-one"); }
    if (guard === "family") s.f.db.query("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'").run();
    if (guard === "head") s.f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run("b".repeat(40));
    s.f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1000,'fake-projection','p','T1','scheduler','',?,?)")
      .run(JSON.stringify({ authorizationAskId: "owner-ask", authorizationDigest: "a".repeat(64) }), "scheduler:merge-new");
    const before = seq(s.f.db);
    expect(await s.manager(...s.plan("merge-new", "merge", guard === "node" ? "restate" : "merge_deploy")))
      .toEqual({ ok: false, code: guard === "node" ? "invalid" : "conflict" });
    expect(s.requests).toHaveLength(0);
    expect(seq(s.f.db)).toBe(before);
  });

  test("a frozen queue still admits review on a review-stage card", async () => {
    const s = ledgercmdFixture();
    s.f.db.query("UPDATE tasks SET stage='review' WHERE id='T1'").run();
    s.f.db.query("INSERT INTO meta (project,key,value) VALUES ('p','queueFrozen',?)")
      .run(JSON.stringify({ frozen: true, reason: "test", since: 1000 }));
    expect(await s.manager(...s.plan("review", "review", "adversarial_review"))).toMatchObject({ ok: true });
    expect(s.requests).toHaveLength(1);
  });

  test("a card's existing worker slot participates in the single-slot guard", async () => {
    const s = ledgercmdFixture();
    s.seed("prior", "dispatch", "done"); await s.port.sync("p", "feature-one");
    s.f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope) VALUES ('p','slot:p:0','T1','prior',1000,'card')").run();
    expect(await s.manager(...s.plan("second", "dispatch", "restate", "slot:p:1"))).toEqual({ ok: false, code: "conflict" });
    expect(s.requests).toHaveLength(0);
    expect(s.f.db.query("SELECT resource FROM scheduler_resources WHERE intentId='prior'").get()).toEqual({ resource: "slot:p:0" });
  });
});
