import { describe, expect, test } from "bun:test";
import { getMeta } from "../src/lib/ledger-store.js";
import { advanceDeployRun, beginDeployRun, deployInFlight, getDeployRun } from "../src/lib/scheduler-deploy.js";
import { mergeQueueBusy } from "../src/lib/scheduler-update-gate.js";
import { schedulerCanVerify } from "../src/lib/scheduler-verify-gate.js";
import { ledgerAs, mergedCard, MERGE } from "./deploy-test-kit.js";

const sch = { actor: "scheduler", now: 150 };
const LABEL = `com.claudestra.scheduler.deploy.${"e".repeat(32)}`;

function running() {
  const f = mergedCard();
  beginDeployRun(f.db, sch, f.intent);
  advanceDeployRun(f.db, sch, { intentId: f.intent, from: "claimed", to: "running", rev: 1, label: LABEL });
  return f;
}

describe("T68g deploy journal", () => {
  test("claim needs a merged run on the current head; only the scheduler starts it", () => {
    const f = mergedCard();
    try {
      expect(() => beginDeployRun(f.db, { actor: "owner", now: 150 }, f.intent)).toThrow(/调度服务/);
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T9'").run();
      expect(() => beginDeployRun(f.db, sch, f.intent)).toThrow(/暂停/);
      f.db.query("UPDATE task_workflows SET mode='auto' WHERE taskId='T9'").run();
      expect(beginDeployRun(f.db, sch, f.intent).run).toMatchObject({ phase: "claimed", mergeSha: MERGE });
      expect(beginDeployRun(f.db, sch, f.intent).duplicate).toBe(true);
    } finally { f.close(); }
  });

  test("P1: a claimed / running deploy holds off updates; a deploy unknown (job checked gone) does not", () => {
    const f = running();
    try {
      expect(deployInFlight(f.db)).toBe(true);
      expect(mergeQueueBusy(f.db)).toBe(true);
      advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "unknown", rev: 2, outcome: "unknown", liveness: "dead", receipt: "no result" });
      expect(mergeQueueBusy(f.db)).toBe(false);
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true); // the queue waits for the PM, updates do not
    } finally { f.close(); }
  });

  test("P1: leaving running needs a checked dead job, enforced by the writer and by the table itself", () => {
    const f = running();
    try {
      expect(() => advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "unknown", rev: 2, outcome: "failed", receipt: "x" }))
        .toThrow(/liveness dead/);
      expect(() => advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "deployed", rev: 2, outcome: "failed", liveness: "dead", receipt: "x" }))
        .toThrow(/success/);
      expect(() => f.db.query("UPDATE scheduler_deploys SET phase='unknown', liveness=NULL").run()).toThrow(/CHECK/);
    } finally { f.close(); }
  });

  test("deployed moves the card to live, records the deploy and frees the merge slot", () => {
    const f = running();
    try {
      advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "deployed", rev: 2, outcome: "success", liveness: "dead", receipt: "ok" });
      expect(f.db.query("SELECT stage FROM tasks WHERE id='T9'").get()).toEqual({ stage: "live" });
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='m9'").get()).toEqual({ status: "done" });
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='m9'").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT json_extract(data,'$.version') AS v FROM events WHERE kind='deploy'").get()).toEqual({ v: MERGE });
      expect(mergeQueueBusy(f.db)).toBe(false);
    } finally { f.close(); }
  });

  test("P1: a deploy unknown has an exit: the PM resolves it through scheduler-merge-resolve, the scheduler cannot", async () => {
    const f = running();
    try {
      advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "unknown", rev: 2, outcome: "failed", liveness: "dead", receipt: "web 构建失败" });
      const resolve = ["ledger", "scheduler-merge-resolve", f.intent, "--outcome", "cancelled", "--receipt", "看过 result.json，手动部署了"];
      expect(await ledgerAs(f.db, "scheduler")(...resolve)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await ledgerAs(f.db, "owner")(...resolve)).toMatchObject({ ok: true, run: { phase: "resolved" } });
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='m9'").get()).toEqual({ status: "cancelled" });
      expect(f.db.query("SELECT mode FROM task_workflows WHERE taskId='T9'").get()).toEqual({ mode: "manual" });
      expect(getDeployRun(f.db, f.intent)?.phase).toBe("resolved");
    } finally { f.close(); }
  });

  test("scheduler verify: only its own deployed card, never a waiver", async () => {
    const f = running();
    try {
      expect(schedulerCanVerify(f.db, "T9")).toBe(false);
      expect(await ledgerAs(f.db, "scheduler")("ledger", "verify", "T9", "--dry-run")).toMatchObject({ ok: false, code: "forbidden" });
      advanceDeployRun(f.db, sch, { intentId: f.intent, from: "running", to: "deployed", rev: 2, outcome: "success", liveness: "dead", receipt: "ok" });
      expect(schedulerCanVerify(f.db, "T9")).toBe(true);
      expect(await ledgerAs(f.db, "scheduler")("ledger", "verify", "T9", "--waive", "web-relay", "--text", "不需要"))
        .toMatchObject({ ok: false, code: "forbidden" });
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T9'").run();
      expect(schedulerCanVerify(f.db, "T9")).toBe(false);
    } finally { f.close(); }
  });
});
