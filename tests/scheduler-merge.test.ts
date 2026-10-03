import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getMeta, closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, mergeRunDrift } from "../src/lib/scheduler-merge.js";
import { acquireMaintenance } from "../src/lib/scheduler-maintenance.js";
import { mergeQueueBusy } from "../src/lib/scheduler-update-gate.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const H = "a".repeat(40), M = "b".repeat(40);
const review = { round: 1, head: H, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "review-session",
  reviewerFamily: "codex", path: "reviews/T1-r1/report.md", findings: [], p0: 0, p1: 0, p2: 0 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t68-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: "T1", title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2,
    mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'")
    .run(H, "https://github.com/example/repo/pull/42");
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p','T1','review','',?)")
    .run(JSON.stringify(review));
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('merge-one','T1','p','merge_deploy','merge',3,4,2,1,?,2,'submitted','ready',100,100)`).run(H);
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-one',100)").run();
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('review-create','T1','p','adversarial_review','ensure_session',1,2,1,1,?,2,'done','reviewer',100,100)`).run(H);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','review-session','codex','acp','active','review-create',100,100)`).run();
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, ctx, close, path, dir };
}

describe("T68 durable merge queue", () => {
  test("scheduler actor can write a merge journal but can no longer run ledger verify", async () => {
    const f = fixture();
    try {
      beginMergeRun(f.db, { actor: "scheduler", now: 101 }, "merge-one", ["check"]);
      expect(f.db.query("SELECT actor FROM events WHERE kind='scheduler' ORDER BY seq DESC LIMIT 1").get()).toEqual({ actor: "scheduler" });
      f.db.query("UPDATE tasks SET stage='live' WHERE id='T1'").run();
      const deps = { db: f.db, actor: "scheduler", projectIds: ["p"], loadRegistry: async () => ({} as Registry),
        saveRegistry: async () => {}, now: () => 101 };
      expect(await runLedger(["verify", "T1", "--dedup", "scheduler:merge-one:verify"], deps)).toMatchObject({ ok: false, code: "forbidden" });
    } finally { f.close(); }
  });
  test("requires submitted intent, same reviewed head and project merge lock", () => {
    const f = fixture();
    try {
      expect(beginMergeRun(f.db, f.ctx, "merge-one", ["check", "Guard"]).run).toMatchObject({ phase: "ready", reviewedHead: H });
      expect(beginMergeRun(f.db, f.ctx, "merge-one", ["check", "Guard"]).duplicate).toBe(true);
      f.db.query("DELETE FROM scheduler_merges").run();
      f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(M);
      expect(() => beginMergeRun(f.db, f.ctx, "merge-one", ["check", "Guard"])).toThrow(/head 不一致/);
    } finally { f.close(); }
  });
  test("PM pauses or changes head after journal creation: external queue stops", () => {
    const f = fixture();
    try {
      const run = beginMergeRun(f.db, f.ctx, "merge-one", ["check"]).run;
      expect(mergeRunDrift(f.db, run)).toBeNull();
      f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(M);
      expect(mergeRunDrift(f.db, run)).toMatch(/head/);
      f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(H);
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
      expect(mergeRunDrift(f.db, run)).toMatch(/暂停/);
    } finally { f.close(); }
  });
  test("update-branch changing head returns to review and releases the project merge slot atomically", () => {
    const f = fixture();
    try {
      beginMergeRun(f.db, f.ctx, "merge-one", ["check"]);
      advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "ready", to: "updating", rev: 1 });
      const run = advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "updating", to: "await_review", rev: 2,
        receipt: "branch updated", newHead: M });
      expect(run.phase).toBe("await_review");
      expect(f.db.query("SELECT stage,round,headSHA FROM tasks WHERE id='T1'").get()).toEqual({ stage: "review", round: 2, headSHA: M });
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge-one'").get()).toEqual({ status: "cancelled" });
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='merge-one'").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });

  test("CAS journals every external boundary and freezes unknown results", () => {
    const f = fixture();
    try {
      beginMergeRun(f.db, f.ctx, "merge-one", ["check"]);
      const step = (from: Parameters<typeof advanceMergeRun>[2]["from"], to: Parameters<typeof advanceMergeRun>[2]["to"], rev: number,
        receipt?: string, mergeSha?: string) => advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from, to, rev, receipt, mergeSha });
      expect(step("ready", "await_ci", 1, "head stayed aaaa").rev).toBe(2);
      expect(() => step("ready", "await_ci", 1, "again")).toThrow(/不能从/);
      expect(step("await_ci", "merging", 2).phase).toBe("merging");
      expect(() => step("merging", "merged", 3, "merged", "short")).toThrow(/完整 SHA/);
      expect(step("merging", "unknown", 3, "gh timeout; PR state unconfirmed").phase).toBe("unknown");
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true);
      expect(() => step("unknown", "merging", 4)).toThrow(/不能从/);
    } finally { f.close(); }
  });

  test("merged is terminal: the task waits in merge for the PM to deploy, the tick settles the intent and frees the slot", async () => {
    const f = fixture();
    try {
      beginMergeRun(f.db, f.ctx, "merge-one", ["check"]);
      const step = (from: Parameters<typeof advanceMergeRun>[2]["from"], to: Parameters<typeof advanceMergeRun>[2]["to"], rev: number,
        receipt?: string, mergeSha?: string) => advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from, to, rev, receipt, mergeSha });
      step("ready", "await_ci", 1, "checks all green");
      step("await_ci", "merging", 2);
      expect(step("merging", "merged", 3, "PR merged", M)).toMatchObject({ phase: "merged", mergeSha: M });
      expect(() => step("merged", "unknown", 4, "late doubt")).toThrow(/不能从/);
      expect(f.db.query("SELECT stage FROM tasks WHERE id='T1'").get()).toEqual({ stage: "merge" });
      expect(mergeQueueBusy(f.db)).toBe(false);
      const calls: string[][] = [];
      const manager = async (...args: string[]) => {
        calls.push(args);
        return runLedger(args.slice(1), { db: f.db, actor: "scheduler", projectIds: ["p"], loadRegistry: async () => ({} as Registry),
          saveRegistry: async () => {}, now: () => 300 }) as Promise<Record<string, unknown>>;
      };
      const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });
      const noExternal = () => { throw new Error("merged must not touch GitHub or deploy"); };
      expect(await schedulerMergeTick(f.db, config, manager, noExternal)).toBe(1);
      expect(calls.map((a) => a[1])).toEqual(["scheduler-settle"]);
      expect(f.db.query("SELECT status, receipt FROM scheduler_intents WHERE id='merge-one'").get())
        .toEqual({ status: "done", receipt: `merge:${M}; 待 PM 部署` });
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='merge-one'").get()).toEqual({ n: 0 });
      expect(await schedulerMergeTick(f.db, config, manager, noExternal)).toBe(0);
    } finally { f.close(); }
  });
  test("real CI names flow from scheduler.json through merge-begin CLI, the journal and the driver to merged", async () => {
    const f = fixture();
    try {
      const names = ["typecheck + test + guard", "web typecheck + lint", "desktop typecheck + cargo test"];
      const configPath = join(f.dir, "scheduler.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: names, repoDir: "/tmp/p" } } }));
      const config = readSchedulerConfig(configPath);
      const manager = async (...args: string[]) => runLedger(args.slice(1), { db: f.db, actor: "scheduler", projectIds: ["p"],
        loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 300 }) as Promise<Record<string, unknown>>;
      let snapshot: PrSnapshot = { state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
        mergeState: "CLEAN", mergeSha: null, checks: names.map((name) => ({ name, bucket: "pass" as const })) };
      const external: MergeExternal = {
        inspect: async () => snapshot,
        freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }), // i28-M9: never behind main here
        carryReview: async () => ({ ok: false, reason: "不沿用" }),
        updateBranch: async () => { throw new Error("clean PR must not be updated"); },
        merge: async () => { snapshot = { ...snapshot, state: "MERGED", mergeSha: M }; return M; },
      };
      for (let i = 0; i < 4 && getMergeRun(f.db, "merge-one")?.phase !== "merged"; i++) {
        expect(await schedulerMergeTick(f.db, config, manager, () => external)).toBe(1);
      }
      expect(getMergeRun(f.db, "merge-one")).toMatchObject({ phase: "merged", mergeSha: M, requiredChecks: names.join(",") });
      // i28-MT1f2: settled in the pass that merged it (no deploy configured), so the slot is free for the next card's plan
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge-one'").get()).toEqual({ status: "done" });
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='merge-one'").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
  test("preflight rejection records unknown intent instead of retrying it each poll", async () => {
    const f = fixture();
    try {
      const calls: string[][] = [];
      const manager = async (...args: string[]) => {
        calls.push(args);
        return args[1] === "scheduler-merge-begin" ? { ok: false, code: "invalid", error: "review missing" } : { ok: true };
      };
      const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });
      expect(await schedulerMergeTick(f.db, config, manager)).toBe(1);
      expect(calls.map((args) => args[1])).toEqual(["scheduler-merge-begin", "scheduler-settle"]);
      expect(calls[1]).toContain("unknown");
    } finally { f.close(); }
  });
  test("unknown freezes the queue and holds off update until a human manager resolves it with a receipt", async () => {
    const f = fixture();
    const reader = new LedgerReader(f.path), lock = { path: join(f.dir, "mutex"), marker: join(f.dir, "update.json"), reader };
    try {
      beginMergeRun(f.db, f.ctx, "merge-one", ["check"]);
      advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "ready", to: "await_ci", rev: 1, receipt: "clean" });
      advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "await_ci", to: "merging", rev: 2 });
      expect(mergeQueueBusy(f.db)).toBe(true);
      advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "merging", to: "unknown", rev: 3, receipt: "gh timeout" });
      expect(mergeQueueBusy(f.db)).toBe(true);
      expect(await acquireMaintenance("update", lock)).toBeNull();
      const cli = (actor: string, ...args: string[]) => runLedger(["scheduler-merge-resolve", "merge-one", ...args], {
        db: f.db, actor, projectIds: ["p"], loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 200 });
      expect(await cli("scheduler", "--outcome", "failed", "--receipt", "PR still open")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await cli("agent-author", "--outcome", "failed", "--receipt", "PR still open")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await cli("owner", "--outcome", "failed")).toMatchObject({ ok: false });
      expect(await cli("owner", "--outcome", "merged", "--receipt", "x")).toMatchObject({ ok: false, code: "invalid" });
      const ok = await cli("owner", "--outcome", "failed", "--receipt", "gh pr view 42: OPEN, head aaaa, not merged");
      expect(ok).toMatchObject({ ok: true, run: { phase: "resolved", reason: "failed: gh pr view 42: OPEN, head aaaa, not merged" } });
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge-one'").get()).toEqual({ status: "cancelled" });
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='merge-one'").get()).toEqual({ n: 0 });
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true);
      const ev = f.db.query("SELECT actor, data FROM events WHERE dedupKey='scheduler:merge-one:merge:resolved'").get() as { actor: string; data: string };
      expect(ev.actor).toBe("owner");
      expect(JSON.parse(ev.data)).toMatchObject({ op: "merge_resolve", outcome: "failed", manual: true, queueFrozen: true });
      expect(await cli("owner", "--outcome", "done", "--receipt", "again")).toMatchObject({ ok: false, code: "conflict" });
      expect(mergeQueueBusy(f.db)).toBe(false);
      const update = await acquireMaintenance("update", lock);
      expect(update).not.toBeNull(); update!.release();
    } finally { reader.close(); f.close(); }
  });
  test("resolving as done settles the merge intent done", async () => {
    const f = fixture();
    try {
      beginMergeRun(f.db, f.ctx, "merge-one", ["check"]);
      advanceMergeRun(f.db, f.ctx, { intentId: "merge-one", from: "ready", to: "unknown", rev: 1, receipt: "mergeState=BLOCKED" });
      const r = await runLedger(["scheduler-merge-resolve", "merge-one", "--outcome", "done", "--receipt", "gh pr view 42: MERGED abc"], {
        db: f.db, actor: "owner", projectIds: ["p"], loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 200 });
      expect(r).toMatchObject({ ok: true, run: { phase: "resolved" } });
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge-one'").get()).toEqual({ status: "done" });
      expect(f.db.query("SELECT mode FROM task_workflows WHERE taskId='T1'").get()).toEqual({ mode: "manual" });
    } finally { f.close(); }
  });
});
