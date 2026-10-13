/**
 * MERGEFAST3: the auto tick drives the merges its merge cards just planned before it walks the other cards
 * (lib/scheduler-auto-tick.ts `afterMerges`, wired to schedulerPass's mergeNow). Before, a merge planned in the tick waited
 * for every other card of the pass (1.5 min on 10-13) and then for the next pass's mergeTick.
 */
import { describe, expect, test } from "bun:test";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const PATH = ["spec", "restate", "build", "review", "merge"];
/** M1 at merge with a merge intent whose outcome is unknown: mergeFirst walks it first and it is held. */
function mergeCard(f: F) {
  createTask(f.db, f.at("owner"), { project: "p", id: "M1", title: "M1", kind: "code" });
  setWorkflow(f.db, f.at("owner"), { taskId: "M1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  for (let i = 1; i < PATH.length; i++) moveStage(f.db, f.at("owner"), { taskId: "M1", from: PATH[i - 1] as never, to: PATH[i] as never });
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,receipt,createdAt,updatedAt)
    VALUES ('mm1','M1','p','merge','merge',1,1,1,1,?,2,'unknown','seed','外部结果不明',300,300)`).run("c".repeat(40));
}
const t1Started = (f: F) => f.ensured.length > 0 || (f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'T1'").get() as { n: number }).n > 0;

async function tick(f: F, hook: () => Promise<void>) {
  const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps, undefined, hook);
  return { failed: r.failed, cards: r.cards.map((c) => c.taskId) };
}

describe("MERGEFAST3 the auto tick drives just-planned merges before the other cards", () => {
  test("merge cards first, then the hook once, then the rest: T1 has not started when the merge is driven", async () => {
    const f = autoFixture();
    try {
      mergeCard(f);
      const seen: boolean[] = [];
      const r = await tick(f, async () => { seen.push(t1Started(f)); });
      expect([r.failed, r.cards, seen, t1Started(f)]).toEqual([[], ["M1", "T1"], [false], true]);
    } finally { f.close(); }
  });
  test("no merge card: the hook still runs once, before the first card; only merge cards: once, after them", async () => {
    const a = autoFixture(), b = autoFixture();
    try {
      const seen: boolean[] = [];
      expect((await tick(a, async () => { seen.push(t1Started(a)); })).cards).toEqual(["T1"]);
      expect([seen, t1Started(a)]).toEqual([[false], true]);
      mergeCard(b);
      b.db.query("DELETE FROM task_workflows WHERE taskId = 'T1'").run();
      let calls = 0;
      expect((await tick(b, async () => { calls++; })).cards).toEqual(["M1"]);
      expect(calls).toBe(1);
    } finally { a.close(); b.close(); }
  });
  test("a failing drive is reported as merge-again and the other cards still run", async () => {
    const f = autoFixture();
    try {
      mergeCard(f);
      const r = await tick(f, async () => { throw new Error("gh down"); });
      expect([r.failed, r.cards, t1Started(f)]).toEqual([[{ taskId: "merge-again", error: "gh down" }], ["M1", "T1"], true]);
    } finally { f.close(); }
  });
});
