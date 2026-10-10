/**
 * i28-SECPOOL4 end to end on a real ledger: the merge driver's foreign_repo fallback (wired by the merge tick) and the deploy tick
 * skipping a foreign merged card. The deploy kit's card T9 is the private-repo card; T10 is a public card in the same queue.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { ForeignRepoError, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { parseSchedulerConfig, type SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { getMeta } from "../src/lib/ledger-store.js";
import { manualEntry } from "../src/lib/manual-reason.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { ledgerAs, mergedCard, MERGE } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), HEAD10 = "e".repeat(40), MERGE10 = "f".repeat(40);
const PRIVATE = "https://github.com/floka-ai/cloud/pull/12", PUBLIC = "https://github.com/shawnlu96/claudestra/pull/1027";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

afterEach(() => setForeignRepoLookupForTest({ project: null, origin: null }));

/** T9 (deploy kit) moved to the private repository and put back to `ready` before any merge was sent. */
function privateCard() {
  const c = mergedCard();
  c.db.query("UPDATE tasks SET pr=? WHERE id='T9'").run(PRIVATE);
  c.db.query("UPDATE scheduler_merges SET phase='ready', mergeSha=NULL, prRef=? WHERE intentId=?").run(PRIVATE, c.intent);
  return c;
}

/** A second auto card at merge on the public repository with its merge intent planned. */
function seedPublic(db: Database): void {
  const pm = { actor: "owner", now: 300 };
  createTask(db, pm, { project: "p", id: "T10", title: "public", kind: "code", agent: "agent-author" });
  setWorkflow(db, pm, { taskId: "T10", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='feat/t10' WHERE id='T10'").run(HEAD10, PUBLIC);
  const intent = (id: string, node: string, action: string, status: string, seq: number) => db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,'T10','p',?,?,1,?,2,1,?,2,?,'seed',300,300)`).run(id, node, action, seq, HEAD10, status);
  intent("rv10", "adversarial_review", "ensure_session", "done", 900);
  intent("m10", "merge_deploy", "merge", "submitted", 901);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T10','reviewer','agent-rv','rv-session-10','codex','tmux','active','rv10',300,300)`).run();
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (300,'agent-rv','p','T10','review','',?)").run(JSON.stringify({
    round: 1, head: HEAD10, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-session-10", reviewerFamily: "codex",
    path: "r10.md", findings: [], p0: 0, p1: 0, p2: 0 }));
}

/** gh as the project's repoDir (shawnlu96/claudestra) sees it: the private PR is refused with the marker, the public one is green. */
function external(merged: { done: boolean }): MergeExternal {
  const open: PrSnapshot = { state: "OPEN", head: HEAD10, branch: "feat/t10", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: null, checks: [{ name: "ci", bucket: "pass" }] };
  return {
    inspect: async (pr) => {
      if (pr === PRIVATE) throw new ForeignRepoError("floka-ai/cloud", "shawnlu96/claudestra");
      return merged.done ? { ...open, state: "MERGED", mergeSha: MERGE10 } : open;
    },
    freshness: async () => ({ behindBy: 0, mainHead: "9".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { throw new Error("不该更新"); },
    merge: async (pr) => { if (pr !== PUBLIC) throw new Error("私仓不该合并"); merged.done = true; return MERGE10; },
  };
}

/** The scheduler's ledger CLI, with every scheduler-fallback-manual call logged (and optionally refused). */
function managerOf(db: Database, refuse = false) {
  const fallbacks: string[][] = [], ledger = ledgerAs(db, "scheduler");
  const manager = async (...args: string[]) => {
    if (args[1] === "scheduler-fallback-manual") {
      fallbacks.push(args.slice(2));
      if (refuse) return { ok: false, code: "conflict", error: "fallback 被拒" };
    }
    return ledger(...args);
  };
  return { manager, fallbacks };
}

const intentStatus = (db: Database, id: string) => (db.query("SELECT status FROM scheduler_intents WHERE id=?").get(id) as { status: string }).status;
const mode = (db: Database, id: string) => (db.query("SELECT mode FROM task_workflows WHERE taskId=?").get(id) as { mode: string }).mode;

describe("i28-SECPOOL4 merge driver fallback", () => {
  test("P1-3: a foreign run ends cancelled through foreign_repo manual, once; no unknown, no freeze, the public card merges next", async () => {
    const c = privateCard();
    try {
      const m = managerOf(c.db), merged = { done: false };
      await schedulerMergeTick(c.db, config, m.manager, () => external(merged));
      expect(m.fallbacks).toHaveLength(1);
      expect(m.fallbacks[0]!.slice(0, 2)).toEqual(["T9", "--reason"]);
      expect(m.fallbacks[0]![2]).toStartWith("foreign_repo：卡在 floka-ai/cloud，不是项目自动合并的仓库");
      expect(m.fallbacks[0]!.slice(3)).toEqual(["--intent", c.intent]);
      expect(getMergeRun(c.db, c.intent)?.phase).toBe("resolved");
      expect(intentStatus(c.db, c.intent)).toBe("cancelled");
      expect(mode(c.db, "T9")).toBe("manual");
      expect(manualEntry(listEvents(c.db, { project: "p", target: "T9" }))?.code).toBe("foreign_repo");
      expect(getMeta(c.db, "p").queueFrozen.frozen).toBe(false);
      expect(c.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(c.intent)).toBeNull(); // merge slot freed
      // the next card's merge intent takes the freed slot (as the planner plans it) and the queue carries on
      seedPublic(c.db);
      c.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T10','m10',400)").run();
      await schedulerMergeTick(c.db, config, m.manager, () => external(merged));
      await schedulerMergeTick(c.db, config, m.manager, () => external(merged));
      expect(getMergeRun(c.db, "m10")).toMatchObject({ phase: "merged", mergeSha: MERGE10 });
      expect(intentStatus(c.db, "m10")).toBe("done");
      expect(m.fallbacks).toHaveLength(1); // the cancelled private run is not driven again
      expect(getMeta(c.db, "p").queueFrozen.frozen).toBe(false);
    } finally { c.close(); }
  });

  test("a refused hand-over is not swallowed: the driver's catch ends it as the plain unknown it was before", async () => {
    const c = privateCard();
    try {
      const m = managerOf(c.db, true);
      await schedulerMergeTick(c.db, config, m.manager, () => external({ done: false }));
      expect(m.fallbacks).toHaveLength(1);
      expect(getMergeRun(c.db, c.intent)).toMatchObject({ phase: "unknown", reason: expect.stringContaining("fallback 被拒") });
      expect(mode(c.db, "T9")).toBe("auto");
    } finally { c.close(); }
  });

  test("without the hook driveMerge behaves exactly as before: unknown with the old receipt", async () => {
    const c = privateCard();
    try {
      const ledger = ledgerAs(c.db, "scheduler");
      const advance = async (from: string, to: string, rev: number, receipt?: string) => {
        const r = await ledger("ledger", "scheduler-merge-step", c.intent, "--from", from, "--to", to, "--rev", String(rev), ...(receipt ? ["--receipt", receipt] : []));
        if (r.ok !== true) throw new Error(String(r.error));
        return r.run as MergeRun;
      };
      const after = await driveMerge(getMergeRun(c.db, c.intent)!, external({ done: false }), advance as never);
      expect(after).toMatchObject({ phase: "unknown", reason: "外部步骤失败：repoDir 仓库与 PR 仓库不一致" });
    } finally { c.close(); }
  });
});

describe("i28-SECPOOL4 deploy tick", () => {
  const deploying: SchedulerConfig = { ...config, projects: { p: { ...config.projects.p!, deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };
  function jobs() {
    const log: string[] = [];
    const j: DeployJobs = { label: () => "com.claudestra.scheduler.deploy.x", submit: async () => { log.push("submit"); return "x"; },
      observe: async () => null, remove: async () => true };
    return { j, log };
  }
  const deps = (db: Database, j: DeployJobs) => ({ manager: ledgerAs(db, "scheduler"), jobs: j, assertActive: () => {}, now: () => 1000 });
  const notes = (db: Database) => (db.query(`SELECT json_extract(data,'$.receipt') AS text FROM events WHERE target='T9' AND kind='scheduler'
    AND json_extract(data,'$.op')='settle' AND json_extract(data,'$.receipt') LIKE '%不是项目仓库%'`).all() as { text: string }[]);

  test("P1-4: a merged card outside the project repository is not claimed or submitted, and noted once", async () => {
    setForeignRepoLookupForTest({ origin: () => "shawnlu96/claudestra" });
    const c = mergedCard(), { j, log } = jobs(); // its PR is example/repo
    try {
      await deployTick(c.db, deploying, deps(c.db, j));
      await deployTick(c.db, deploying, deps(c.db, j));
      expect(getDeployRun(c.db, c.intent)).toBeNull();
      expect(log).toEqual([]);
      expect(notes(c.db)).toHaveLength(1);
      expect(notes(c.db)[0]!.text).toContain("不是项目仓库，不走自动部署");
      expect(intentStatus(c.db, c.intent)).toBe("done"); // the merge slot is not kept
      expect(notes(c.db)[0]!.text).toContain("example/repo");
      // a later merged intent of the same card: settled too, but the note is not written again
      c.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        SELECT 'm9b',taskId,project,node,action,causalSeq,eventSeq+1,taskRev,specRev,head,templateVersion,'submitted',reason,createdAt,updatedAt FROM scheduler_intents WHERE id='m9'`).run();
      c.db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,mergeSha,createdAt,updatedAt)
        SELECT 'm9b',taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,mergeSha,createdAt,updatedAt FROM scheduler_merges WHERE intentId='m9'`).run();
      await deployTick(c.db, deploying, deps(c.db, j));
      expect(intentStatus(c.db, "m9b")).toBe("done");
      expect(getDeployRun(c.db, "m9b")).toBeNull();
      expect(notes(c.db)).toHaveLength(1);
    } finally { c.close(); }
  });

  test("the project's own repository deploys as before", async () => {
    setForeignRepoLookupForTest({ origin: () => "example/repo" });
    const c = mergedCard(), { j, log } = jobs();
    try {
      await deployTick(c.db, deploying, deps(c.db, j));
      expect(getDeployRun(c.db, c.intent)?.phase).toBe("running");
      expect(log).toEqual(["submit"]);
      expect(notes(c.db)).toHaveLength(0);
      expect(MERGE).toHaveLength(40);
    } finally { c.close(); }
  });
});
