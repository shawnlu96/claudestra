/** Shared fixture for the T68g deploy tests: an auto card whose merge journal already reached `merged`. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { advanceMergeRun, beginMergeRun } from "../src/lib/scheduler-merge.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

export const HEAD = "c".repeat(40), MERGE = "d".repeat(40);
export const PR = "https://github.com/example/repo/pull/7";

export interface MergedCard { db: Database; dir: string; path: string; close(): void; intent: string }

function seed(db: Database): void {
  const intent = (id: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,'T9','p',?,?,1,?,2,1,?,2,?,'seed',100,100)`).run(id, node, action, id === "m9" ? 4 : 2, HEAD, status);
  intent("rv9", "adversarial_review", "ensure_session", "done");
  intent("m9", "merge_deploy", "merge", "submitted");
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T9','m9',100)").run();
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T9','reviewer','agent-rv','rv-session','codex','tmux','active','rv9',100,100)`).run();
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p','T9','review','',?)").run(JSON.stringify({
    round: 1, head: HEAD, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-session", reviewerFamily: "codex",
    path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 }));
}

export function mergedCard(): MergedCard {
  const dir = mkdtempSync(join(tmpdir(), "t68g-deploy-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const pm = { actor: "owner", now: 100 }, sch = { actor: "scheduler", now: 101 };
  createTask(db, pm, { project: "p", id: "T9", title: "deploy me", kind: "code", agent: "agent-author" });
  setWorkflow(db, pm, { taskId: "T9", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='feat/t9' WHERE id='T9'").run(HEAD, PR);
  seed(db);
  beginMergeRun(db, sch, "m9", ["ci"]);
  advanceMergeRun(db, sch, { intentId: "m9", from: "ready", to: "await_ci", rev: 1, receipt: "clean" });
  advanceMergeRun(db, sch, { intentId: "m9", from: "await_ci", to: "merging", rev: 2, receipt: "green" });
  advanceMergeRun(db, sch, { intentId: "m9", from: "merging", to: "merged", rev: 3, receipt: "merged", mergeSha: MERGE });
  return { db, dir, path, intent: "m9", close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

/** The ledger CLI in-process, as a given actor (the scheduler service's manager child in production). */
export const ledgerAs = (db: Database, actor: string, now = () => 200) => async (...args: string[]) =>
  runLedger(args.slice(1), { db, actor, projectIds: ["p"], loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now });
