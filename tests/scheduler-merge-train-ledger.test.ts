/** i28-MT1 merge train ledger reads: who may ride, what became of a member, and the tick wiring. Local ledger only. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { guardedCommand, memberStatusOf, mergeTrainPass, mergeTrainTick, trainCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { trainGh } from "../src/lib/scheduler-merge-train-gh.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";

const head = (i: number) => String(i).repeat(40).slice(0, 40);

function fixture(cards: { id: string; template?: "code" | "ui"; mode?: "auto" | "manual" }[]) {
  const dir = mkdtempSync(join(tmpdir(), "mt1-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  cards.forEach((c, i) => {
    createTask(db, ctx, { project: "p", id: c.id, title: c.id, kind: "code", agent: "agent-author" });
    setWorkflow(db, ctx, { taskId: c.id, taskRev: 1, template: c.template ?? "code", templateVersion: 2, mode: c.mode ?? "auto",
      authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?")
      .run(head(i + 1), `https://github.com/example/repo/pull/${i + 1}`, `task/${c.id}`, 100 + i, c.id);
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(c.id, JSON.stringify({
      round: 1, head: head(i + 1), verdict: "pass", reviewer: "agent-review", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
      findings: [], p0: 0, p1: 0, p2: 0 }));
  });
  const intent = (id: string, taskId: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,
    eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,?,'p','merge_deploy','merge',3,4,2,1,?,2,?,'r',100,100)`)
    .run(id, taskId, head(1), status);
  const run = (intentId: string, taskId: string, phase: string, reviewed: string, mergeSha: string | null = null) => db.query(`INSERT INTO scheduler_merges
    (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,mergeSha,createdAt,updatedAt)
    VALUES (?,?,'p','u','b',?,'check',?,?,100,100)`).run(intentId, taskId, reviewed, phase, mergeSha);
  return { db, intent, run, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

describe("i28-MT1 merge train ledger reads", () => {
  test("candidates: auto, non-ui, passing review, waiting for the slot or holding it in ready / updating", () => {
    const f = fixture([{ id: "T1" }, { id: "T2" }, { id: "T3", template: "ui" }, { id: "T4", mode: "manual" }, { id: "T5" }, { id: "T6" }, { id: "T7" }]);
    try {
      f.intent("m2", "T2", "submitted"); f.run("m2", "T2", "ready", head(2));
      f.intent("m5", "T5", "submitted"); f.run("m5", "T5", "await_ci", head(5));
      f.intent("m6", "T6", "unknown");
      f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) SELECT 101,actor,project,target,kind,text,
        json_set(data,'$.verdict','block') FROM events WHERE target='T7' AND kind='review'`).run();
      expect(trainCandidates(f.db, "p").map((c) => c.taskId)).toEqual(["T1", "T2"]);
      f.db.query("INSERT INTO meta (project,key,value) VALUES ('p','queueFrozen',?)").run(JSON.stringify({ frozen: true, reason: "x", since: 1 }));
      expect(trainCandidates(f.db, "p")).toEqual([]);
    } finally { f.close(); }
  });

  test("member status: merged by its own run at this head, gone when head / stage / mode moved", () => {
    const f = fixture([{ id: "T1" }, { id: "T2" }]);
    try {
      expect(memberStatusOf(f.db, "T1", head(1))).toEqual({ kind: "waiting" });
      f.intent("m1", "T1", "submitted"); f.run("m1", "T1", "merged", head(1), "d".repeat(40));
      expect(memberStatusOf(f.db, "T1", head(1))).toEqual({ kind: "merged", sha: "d".repeat(40) });
      expect(memberStatusOf(f.db, "T2", head(9))).toMatchObject({ kind: "gone", moved: true });
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T2'").run();
      expect(memberStatusOf(f.db, "T2", head(2))).toMatchObject({ kind: "gone" });
      f.db.query("UPDATE tasks SET stage='fix' WHERE id='T2'").run();
      expect(memberStatusOf(f.db, "T2", head(2))).toMatchObject({ kind: "gone", why: "阶段 fix" });
      expect(memberStatusOf(f.db, "T2", head(9))).toMatchObject({ kind: "gone", moved: true }); // review r2: left merge AND moved = moved
    } finally { f.close(); }
  });

  test("tick forms one train from the ledger queue, then only steps it (no second train while one is live)", async () => {
    const f = fixture([{ id: "T1" }, { id: "T2" }]);
    try {
      let state: TrainState | null = null;
      const store: TrainStore = { load: () => state, all: () => (state ? [state] : []), save: (s) => { state = structuredClone(s); },
        event: () => {}, nextSeq: () => 1 };
      const calls: string[] = [];
      const gh = { mainHead: async () => "f".repeat(40), prFiles: async (pr: string) => [pr], prHead: async (pr: string) => head(Number(pr.split("/").pop())),
        createBranch: async (_r: string, b: string) => { calls.push(b); }, mergeInto: async () => "merged" as const,
        openDraft: async () => 1, checks: async () => [{ name: "check", bucket: "pending" as const }] } as unknown as TrainGh;
      const deps = { notifyPm: async () => {}, now: () => 1 };
      await mergeTrainTick(f.db, ["p"], deps, { gh, store }, () => ["check"]);
      expect(state!.members.map((m) => m.taskId)).toEqual(["T1", "T2"]);
      await mergeTrainTick(f.db, ["p"], deps, { gh, store }, () => ["check"]);
      await mergeTrainTick(f.db, ["p"], deps, { gh, store }, () => ["check"]);
      expect(calls).toEqual([`train/${state!.id}`]);
      expect(state!.seq).toBe(1);
      await mergeTrainTick(f.db, ["p"], deps, null, () => ["check"]); // no context (a test process default): nothing happens
    } finally { f.close(); }
  });

  test("review P1 lease-stop: a stop raised by the PM notice ends the tick, and the pass entry's gh runner refuses after a lost lease", async () => {
    const f = fixture([{ id: "T1" }, { id: "T2" }]);
    try {
      let state: TrainState | null = null;
      const store: TrainStore = { load: () => state, all: () => (state ? [state] : []), save: (s) => { state = structuredClone(s); },
        event: () => {}, nextSeq: () => 1 };
      const calls: string[] = [];
      const gh = { mainHead: async () => { calls.push("main"); return "f".repeat(40); }, prFiles: async (pr: string) => [pr] } as unknown as TrainGh;
      const deps = { notifyPm: async () => { throw new SchedulerStopped("lease lost"); }, now: () => 1 };
      await expect(mergeTrainTick(f.db, ["p", "q"], deps, { gh, store }, () => ["check"])).rejects.toBeInstanceOf(SchedulerStopped);
      expect(calls).toEqual(["main"]); // no further gh call after the stop

      let held = true;
      const active = () => { if (!held) throw new SchedulerStopped("lease lost"); };
      const spawned: string[][] = [];
      const run = guardedCommand(active, async (argv) => { spawned.push(argv); held = false; return { code: 0, stdout: "f".repeat(40), stderr: "", timedOut: false } as never; });
      await expect(trainGh(run).mainHead("example/repo")).rejects.toBeInstanceOf(SchedulerStopped); // lost during the call
      await expect(trainGh(run).mainHead("example/repo")).rejects.toBeInstanceOf(SchedulerStopped); // refused before the spawn
      expect(spawned).toHaveLength(1);
      held = false;
      await expect(mergeTrainPass(f.db, ["p"], active, { gh, store })).resolves.toBeUndefined(); // no required checks in a test config
    } finally { f.close(); }
  });
});
