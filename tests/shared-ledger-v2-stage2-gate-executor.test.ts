import { describe, expect, test } from "bun:test";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { beginRetire, bindSchedulerSession, recordSessionRetirement } from "../src/lib/scheduler-sessions.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setTask } from "../src/lib/ledger-write.js";
import { withExecutorScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { execution, firstFence, fixture, rejected, snapshot, type Fixture } from "./shared-ledger-v2-stage2-gate-helpers.test.js";

function submitted(f: Fixture) {
  f.workflow(); f.setMode(execution);
  f.scope(() => f.plan());
  f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "pending", to: "submitted" }));
}
describe("S2G executor bookkeeping", () => {
  test("real ensure and retirement commands write events with fence and release only their local locks", () => {
    const f = fixture();
    try {
      submitted(f);
      rejected(f, () => withExecutorScope(f.db, { featureId: "F", taskId: "T", fence: firstFence, claimFence: null }, () => {}), "conflict", "v2_unmapped");
      expect(f.db.query("SELECT scope FROM scheduler_resources WHERE intentId='ensure'").get()).toEqual({ scope: "intent" });
      f.scope(() => bindSchedulerSession(f.db, f.scheduler, f.bind), firstFence, firstFence);
      f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to: "done" }), firstFence, firstFence);
      expect(f.db.query("SELECT * FROM scheduler_resources WHERE intentId='ensure'").all()).toEqual([]);
      f.stage("verified");
      const retire = f.scope(() => beginRetire(f.db, f.scheduler, "T")).intent;
      for (const effect of ["archive", "kill"] as const) f.scope(() => recordSessionRetirement(f.db, f.scheduler,
        { taskId: "T", role: "author", intentId: retire.id, effect, receipt: `${effect} confirmed` }), firstFence, firstFence);
      f.scope(() => settleIntent(f.db, f.scheduler, { id: retire.id, from: "submitted", to: "done" }), firstFence, firstFence);
      const events = f.db.query("SELECT data FROM events WHERE actor='scheduler' ORDER BY seq").all() as { data: string }[];
      expect(events.length).toBe(8);
      for (const event of events) expect(JSON.parse(event.data).fence).toEqual(firstFence);
      expect(f.db.query("SELECT state FROM scheduler_sessions WHERE taskId='T'").get()).toEqual({ state: "retired" });
    } finally { f.close(); }
  });
  test("null fence, task writes and projected central intent changes roll back the entire scope", () => {
    const f = fixture();
    try {
      submitted(f);
      rejected(f, () => f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to: "done" }), null));
      rejected(f, () => f.scope(() => setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "local" } })));
      rejected(f, () => f.scope(() => f.db.query("UPDATE tasks SET title='raw bypass' WHERE id='T'").run()));
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
        VALUES ('center','T','p','write','dispatch',1,1,1,2,'submitted','center projection',1,1)`).run();
      rejected(f, () => f.scope(() => settleIntent(f.db, f.scheduler, { id: "center", from: "submitted", to: "done" })));
      rejected(f, () => f.scope(() => f.db.query("UPDATE scheduler_intents SET status='done' WHERE id='center'").run()));
      rejected(f, () => f.scope(() => {
        settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to: "done" });
        f.db.query("UPDATE tasks SET title='late bypass' WHERE id='T'").run();
      }));
      f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,scope,acquiredAt) VALUES ('p','center-lock','T','center','intent',1)").run();
      rejected(f, () => f.scope(() => f.db.query("DELETE FROM scheduler_resources WHERE resource='center-lock'").run()));
      rejected(f, () => f.scope(() => insertEvent(f.db, f.scheduler,
        { project: "p", target: "T", kind: "task", data: { op: "set" } }, true)));
    } finally { f.close(); }
  });
  for (const fence of [{ ...firstFence, epoch: 2, leaseId: "lease-2" }, { ...firstFence, leaseId: "replacement" }]) {
    test(`claim mismatch ${JSON.stringify(fence)}: bind / done / cancelled refuse; unknown carries both fences`, () => {
      const f = fixture();
      try {
        submitted(f);
        rejected(f, () => f.scope(() => bindSchedulerSession(f.db, f.scheduler, f.bind), fence, firstFence), "conflict", "stale_claim");
        for (const to of ["done", "cancelled"] as const) rejected(f,
          () => f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to }), fence, firstFence), "conflict", "stale_claim");
        rejected(f, () => f.scope(() => f.db.query("UPDATE scheduler_intents SET status='done' WHERE id='ensure'").run(), fence, firstFence), "conflict", "stale_claim");
        expect(f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to: "unknown" }), fence, firstFence).status).toBe("unknown");
        const event = f.db.query("SELECT data FROM events WHERE dedupKey='scheduler:ensure:unknown'").get() as { data: string };
        expect(JSON.parse(event.data)).toMatchObject({ fence, claimFence: firstFence });
        expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE intentId='ensure'").get()).toEqual({ n: 1 });
      } finally { f.close(); }
    });
  }
  test("stale retirement claim refuses effect bookkeeping and restores the session", () => {
    const f = fixture();
    try {
      submitted(f);
      f.scope(() => bindSchedulerSession(f.db, f.scheduler, f.bind), firstFence, firstFence);
      f.scope(() => settleIntent(f.db, f.scheduler, { id: "ensure", from: "submitted", to: "done" }), firstFence, firstFence);
      f.stage("verified");
      const intent = f.scope(() => beginRetire(f.db, f.scheduler, "T")).intent;
      rejected(f, () => f.scope(() => recordSessionRetirement(f.db, f.scheduler,
        { taskId: "T", role: "author", intentId: intent.id, effect: "archive", receipt: "archive" }), { ...firstFence, epoch: 2, leaseId: "new" }, firstFence), "conflict", "stale_claim");
    } finally { f.close(); }
  });
  test("throwing scopes clear their token and roll back earlier successful writes", () => {
    const f = fixture();
    try {
      f.workflow(); f.setMode(execution);
      const before = snapshot(f);
      expect(() => f.scope(() => { f.plan(); throw new Error("failure"); })).toThrow("failure");
      expect(snapshot(f)).toEqual(before);
      rejected(f, () => f.plan());
    } finally { f.close(); }
  });
});
