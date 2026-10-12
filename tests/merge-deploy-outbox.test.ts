import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerAs, mergedCard, MERGE } from "./deploy-test-kit.js";
import { advanceMergeRun } from "../src/lib/scheduler-merge.js";
import { getIntent, schedulerProjectView } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, getTask } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { mergeCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { beginDeployRun, advanceDeployRun, getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.js";
import {
  configureMergeDeployOutbox, DEPLOY_PENDING_CONSUMER, MERGE_DEPLOY_PRODUCER,
  getDeployPending, predictMergeDeployDetach, mergeDeployDetachGate, registerMergedDeploy, settleMergedDeploy, type MergeDeployOutboxPorts,
} from "../src/lib/merge-deploy-outbox.js";

const config = { enabled: true, autoDispatch: true, pollMs: 5000, projects: {
  p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo",
    deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } },
} };
const sch = { actor: "scheduler", now: 200 };

function landing(mode: "off" | "observe" | "on" = "on", consumer = true) {
  const f = mergedCard();
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) SELECT 'm10',taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt FROM scheduler_intents WHERE id='m9'`).run();
  f.db.query("UPDATE scheduler_resources SET intentId='m10' WHERE intentId='m9'").run();
  f.db.query("UPDATE scheduler_merges SET intentId='m10' WHERE intentId='m9'").run();
  f.db.query("UPDATE scheduler_intents SET status='done' WHERE id='m9'").run();
  f.intent = 'm10';
  f.db.query("UPDATE scheduler_merges SET phase='merging', rev=3, mergeSha=NULL WHERE intentId='m10'").run();
  const wire = (injected: Partial<MergeDeployOutboxPorts> = {}) => configureMergeDeployOutbox(f.db, {
    policy: () => ({ mode, source: "config", manualAfterMs: null }),
    config: () => config,
    consumer: () => consumer ? DEPLOY_PENDING_CONSUMER : null,
    ...injected,
  });
  wire();
  const merge = () => advanceMergeRun(f.db, sch, {
    intentId: f.intent, from: "merging", to: "merged", rev: 3, mergeSha: MERGE, receipt: "merged",
  });
  return { ...f, merge, wire };
}

const held = (f: ReturnType<typeof landing>) =>
  f.db.query("SELECT resource FROM scheduler_resources WHERE intentId='m10'").all().length;

describe("merge deployment outbox", () => {
  test("[验收线 1] pending precedes settlement and slot release in the merged transaction", () => {
    const f = landing();
    try {
      f.merge();
      expect(getDeployPending(f.db, f.intent)).toMatchObject({ intentId: "m10", task: "T9", project: "p",
        repository: "example/repo", mergeSha: MERGE, reviewedHead: "c".repeat(40), queueVersion: 4, protocolVersion: 1 });
      expect(getIntent(f.db, f.intent)?.status).toBe("done");
      expect(held(f)).toBe(0);
      const ops = f.db.query("SELECT json_extract(data,'$.op') AS op FROM events ORDER BY seq").all() as { op: string }[];
      expect(ops.findIndex((e) => e.op === "deploy_pending")).toBeLessThan(ops.findIndex((e) => e.op === "settle"));
    } finally { f.close(); }
  });

  for (const point of ["merged-row", "merged-event", "pending", "settle", "release", "settled-event"]) {
    test(`[验收线 1] crash at ${point} rolls back merged, pending, settlement and release`, () => {
      const f = landing();
      try {
        const site = point === "merged-row" ? "BEFORE UPDATE ON scheduler_merges WHEN NEW.phase='merged'"
          : point === "merged-event" ? "BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.to')='merged'"
          : point === "pending" ? "BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.op')='deploy_pending'"
          : point === "settle" ? "BEFORE UPDATE ON scheduler_intents WHEN NEW.status='done'"
          : point === "release" ? "BEFORE DELETE ON scheduler_resources"
          : "BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.op')='settle'";
        f.db.exec(`CREATE TRIGGER crash ${site} BEGIN SELECT RAISE(ABORT, 'crash'); END`);
        expect(f.merge).toThrow("crash");
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(held(f)).toBe(1);
        expect(f.db.query("SELECT phase FROM scheduler_merges WHERE intentId='m10'").get()).toEqual({ phase: "merging" });
      } finally { f.close(); }
    });
  }

  test("[验收线 2] repeated receipt cannot write another pending or release", () => {
    const f = landing();
    try {
      f.merge();
      const before = f.db.query("SELECT count(*) AS n FROM events").get();
      expect(f.merge).toThrow(/合并步骤/);
      expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
    } finally { f.close(); }
  });

  test("[验收线 2] producer advertises v1 and recovery key is registered once", () => {
    expect(MERGE_DEPLOY_PRODUCER.protocolVersion).toBe(1);
    expect(RECOVERY_KEYS.filter((k: string) => k === "mergeDeployDetach")).toHaveLength(1);
  });

  for (const mode of ["off", "observe", "on"] as const) {
    test(`[验收线 4] ${mode} without consumer retains old submitted intent and slot`, () => {
      const f = landing(mode, false);
      try {
        f.merge();
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(held(f)).toBe(1);
        const notes = f.db.query("SELECT data FROM events WHERE json_extract(data,'$.op')='merge_deploy_observe' AND json_extract(data,'$.intentId')=?").all(f.intent);
        expect(notes).toHaveLength(mode === "off" ? 0 : 1);
      } finally { f.close(); }
    });
  }

  test("[验收线 4] observe with both capabilities predicts release without mutation", () => {
    const f = landing("observe");
    try {
      f.merge();
      expect(predictMergeDeployDetach(f.db, f.intent).wouldRelease).toBe(true);
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(held(f)).toBe(1);
      const r = f.db.query(`SELECT json_extract(data,'$.wouldRelease') AS release FROM events
        WHERE json_extract(data,'$.op')='merge_deploy_observe' AND json_extract(data,'$.intentId')=?`).get(f.intent);
      expect(r).toEqual({ release: 1 });
    } finally { f.close(); }
  });

  test("[验收线 4] DEPLOY1 alone records a nonzero release prediction while on retains the old slot", () => {
    const f = landing("on", false);
    try {
      f.merge();
      expect(predictMergeDeployDetach(f.db, f.intent).wouldRelease).toBe(true);
      expect(mergeDeployDetachGate(f.db, "p")).toEqual({ mode: "on", consumerReady: false, enabled: false });
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  for (const mode of ["observe", "on"] as const) {
    test(`[验收线 4] ${mode} with an unreadable consumer registry preserves merged and the old slot`, () => {
      const f = landing(mode);
      try {
        f.wire({ consumer: () => { throw new Error("registry unavailable"); } });
        expect(f.merge().phase).toBe("merged");
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(held(f)).toBe(1);
      } finally { f.close(); }
    });
  }

  test("[验收线 1] a conflicting pending dedup key aborts landing without releasing resources", () => {
    const f = landing();
    try {
      // Simulate store corruption; the public note writer itself refuses this reserved namespace.
      f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (150,'owner','p','T9','note','occupied','{}',?)")
        .run(`scheduler:${f.intent}:deploy_pending:v1`);
      expect(f.merge).toThrow(/不相符/);
      expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 2] the generic note writer cannot forge a pending record", () => {
    const f = landing();
    try {
      expect(() => appendEvent(f.db, { actor: "owner", dedupKey: `scheduler:${f.intent}:deploy_pending:v1` },
        { project: "p", target: "T9", kind: "note", data: { op: "deploy_pending" } })).toThrow(/scheduler: 前缀/);
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 1] a writer that returns without persisting pending cannot release the slot", () => {
    const f = landing("off");
    try {
      f.merge();
      f.wire({ policy: () => ({ mode: "on", source: "config", manualAfterMs: null }) });
      const noWrite = () => getEventByDedup(f.db, `scheduler:${f.intent}:merge:merged`)!;
      expect(() => f.db.transaction(() => registerMergedDeploy(f.db, sch, f.intent, noWrite)).immediate()).toThrow(/未持久登记/);
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 3] manual workflow and PM deployment never detach", () => {
    const f = landing("observe");
    try {
      f.merge();
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T9'").run();
      expect(predictMergeDeployDetach(f.db, f.intent)).toMatchObject({ wouldRelease: false, reason: "流程或规格不匹配" });
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 3] on with a PM deploy policy preserves legacy settlement", () => {
    const f = landing();
    try {
      f.wire({ config: () => ({ ...config, projects: { p: { ...config.projects.p, deploy: undefined } } }) });
      f.merge();
      expect(predictMergeDeployDetach(f.db, f.intent)).toMatchObject({ wouldRelease: false, reason: "由 PM 部署或仓库 owner 合并" });
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  for (const invalid of ["missing-sha", "unknown", "head-mismatch", "consumer-version", "consumer-name", "skip"]) {
    test(`[验收线 2] ${invalid} cannot use the new protocol`, () => {
      const f = landing();
      try {
        if (invalid === "consumer-version") f.wire({ consumer: () => ({ ...DEPLOY_PENDING_CONSUMER, protocolVersion: 2 }) });
        if (invalid === "consumer-name") f.wire({ consumer: () => ({ capability: "other", protocolVersion: 1 }) });
        if (invalid === "head-mismatch") f.db.query("UPDATE tasks SET headSHA=? WHERE id='T9'").run("a".repeat(40));
        if (invalid === "skip") {
          f.db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f','p','skip','active','owner',1,1)").run();
          f.db.query("UPDATE tasks SET featureId='f' WHERE id='T9'").run();
          writeFileSync(join(f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: {
            f: { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "b", kind: "execute" } },
          } }));
        }
        if (invalid === "unknown") advanceMergeRun(f.db, sch, { intentId: f.intent, from: "merging", to: "unknown", rev: 3, receipt: "uncertain" });
        else if (invalid === "missing-sha") expect(() => advanceMergeRun(f.db, sch,
          { intentId: f.intent, from: "merging", to: "merged", rev: 3, receipt: "merged" })).toThrow(/完整 SHA/);
        else if (invalid === "head-mismatch" || invalid === "skip") expect(f.merge).toThrow(/head|禁止本机写入/);
        else f.merge();
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(held(f)).toBe(1);
        const incompatible = invalid.startsWith("consumer-");
        expect(predictMergeDeployDetach(f.db, f.intent).wouldRelease).toBe(incompatible);
        if (incompatible) expect(mergeDeployDetachGate(f.db, "p").enabled).toBe(false);
      } finally { f.close(); }
    });
  }

  test("[验收线 1] committed pending survives reopening, policy changes and append-only protection", () => {
    const f = landing();
    try {
      f.merge();
      const first = getDeployPending(f.db, f.intent)!;
      config.projects.p.deploy.restartLabels.push("changed");
      try { expect(getDeployPending(f.db, f.intent)?.deploymentPolicy.target.restartLabels).toEqual(["x.fake"]); }
      finally { config.projects.p.deploy.restartLabels.pop(); }
      f.wire({ policy: () => ({ mode: "off", source: "config", manualAfterMs: null }) });
      expect(getDeployPending(f.db, f.intent)).toEqual(first);
      expect(() => f.db.query("DELETE FROM events WHERE json_extract(data,'$.op')='deploy_pending'").run()).toThrow(/append-only/);
      const reopened = new Database(f.path, { readonly: true });
      try {
        expect(getDeployPending(reopened, f.intent)).toEqual(first);
        expect(getIntent(reopened, f.intent)?.status).toBe("done");
        expect(reopened.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId=?").get(f.intent)).toEqual({ n: 0 });
      } finally { reopened.close(); }
    } finally { f.close(); }
  });

  for (const phase of ["claimed", "running"] as const) {
    test(`[验收线 4] existing ${phase} deploy retains its intent and slot with on`, () => {
      const f = mergedCard();
      try {
        beginDeployRun(f.db, sch, f.intent);
        if (phase === "running") advanceDeployRun(f.db, sch, { intentId: f.intent, from: "claimed", to: "running", rev: 1,
          label: "com.claudestra.scheduler.deploy.fake" });
        configureMergeDeployOutbox(f.db, { policy: () => ({ mode: "on", source: "config", manualAfterMs: null }),
          config: () => config, consumer: () => DEPLOY_PENDING_CONSUMER });
        expect(predictMergeDeployDetach(f.db, f.intent)).toMatchObject({ wouldRelease: false, reason: "已有旧部署日志" });
        f.db.transaction(() => registerMergedDeploy(f.db, sch, f.intent)).immediate();
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(getDeployRun(f.db, f.intent)?.phase).toBe(phase);
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId=?").get(f.intent)).toEqual({ n: 1 });
      } finally { f.close(); }
    });
  }

  test("[验收线 2] only a fresh merged transaction may detach; arbitrary calls and old rows do nothing", () => {
    const f = landing("observe");
    try {
      f.merge();
      f.wire({ policy: () => ({ mode: "on", source: "config", manualAfterMs: null }) });
      expect(() => registerMergedDeploy(f.db, sch, f.intent)).toThrow(/同事务/);
      f.db.transaction(() => registerMergedDeploy(f.db, { ...sch, now: 201 }, f.intent)).immediate();
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 4] an off-era merged row cannot be replayed without its landing clock", () => {
    const f = landing("off");
    try {
      f.merge();
      f.wire({ policy: () => ({ mode: "on", source: "config", manualAfterMs: null }) });
      f.db.transaction(() => registerMergedDeploy(f.db, { actor: "scheduler" }, f.intent)).immediate();
      expect(getDeployPending(f.db, f.intent)).toBeNull();
      expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
      expect(held(f)).toBe(1);
    } finally { f.close(); }
  });

  test("[验收线 3] detached merge stays in merge and cannot be planned or selected for another merge", async () => {
    const f = landing();
    try {
      f.merge();
      const view = schedulerProjectView(f.db, "p").tasks.find((t) => t.taskId === "T9");
      expect(view).toMatchObject({ stage: "merge", resources: [], latestIntent: { status: "done" } });
      const snapshot = observeSnapshot(f.db, getTask(f.db, "T9")!, { registry: [], maxWorkers: 2 });
      expect(planScheduler(snapshot).kind).toBe("wait");
      expect(mergeCandidates(f.db, "p", { now: 201 })).toEqual([]);
      const forbidden = async () => { throw new Error("must not issue legacy work"); };
      expect(await mergeTick(f.db, config, forbidden, () => { throw new Error("must not merge"); }, () => {})).toBe(0);
      const jobs: DeployJobs = { label: () => "fake", observe: forbidden, submit: forbidden, remove: forbidden };
      await deployTick(f.db, config, { manager: forbidden, jobs, assertActive: () => {}, now: () => 201 });
      await settleMergedDeploy(f.db, f.db.query("SELECT * FROM scheduler_merges WHERE intentId=?").get(f.intent) as
        ReturnType<typeof advanceMergeRun>, forbidden);
      expect(getDeployRun(f.db, f.intent)).toBeNull();
      expect(getDeployPending(f.db, f.intent)).not.toBeNull();
    } finally { f.close(); }
  });

  for (const mode of ["off", "observe"] as const) {
    test(`[验收线 3] ${mode} retains automatic and PM settlement through the legacy service`, async () => {
      const f = landing(mode);
      try {
        f.merge();
        const manager = ledgerAs(f.db, "scheduler");
        await mergeTick(f.db, config, manager, () => { throw new Error("already merged"); }, () => {});
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        const noDeploy = { ...config, projects: { p: { ...config.projects.p, deploy: undefined } } };
        await mergeTick(f.db, noDeploy, manager, () => { throw new Error("already merged"); }, () => {});
        expect(getIntent(f.db, f.intent)?.status).toBe("done");
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(held(f)).toBe(0);
      } finally { f.close(); }
    });
  }
});
