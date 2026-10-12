import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ledgerAs, mergedCard, MERGE } from "./deploy-test-kit.js";
import { advanceMergeRun, resolveMergeRun } from "../src/lib/scheduler-merge.js";
import { getIntent, getWorkflow, schedulerProjectView } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { statePath } from "../src/lib/paths.js";
import { getEventByDedup, getTask } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { memberStatusOf, mergeCandidates, mergeTrainTick } from "../src/lib/scheduler-merge-train-tick.js";
import type { TrainEvent, TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import { runManualCarry } from "../src/lib/review-main-carry-manual.js";
import { manualMergeAuth } from "../src/lib/review-main-carry-manual-merge.js";
import { manualResumeManagerTick } from "../src/lib/scheduler-recovery-ports.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { beginDeployRun, advanceDeployRun, getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.js";
import { withExecutorScope } from "../src/lib/shared-ledger-v2-write-gate.js";
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

  for (const association of ["featureId", "sharedFeatureId"] as const) {
    for (const mode of ["off", "observe", "on"] as const) {
      test(`[验收线 2] executor ${association} ${mode} lands merged and retains the old protocol`, () => {
        const f = landing(mode), errors = spyOn(console, "error").mockImplementation(() => {});
        try {
          f.db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f','p','central','active','owner',1,1)").run();
          if (association === "featureId") f.db.query("UPDATE tasks SET featureId='f' WHERE id='T9'").run();
          else f.db.query("UPDATE tasks SET extra=? WHERE id='T9'").run(JSON.stringify({ sharedFeatureId: "f" }));
          writeFileSync(join(f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: {
            f: { authorityMode: "execution", sharedPlanning: true,
              centerExecution: { centerId: "center", teamId: "team", projectId: "cp", centerFeatureId: "cf", epoch: 1 } },
          } }));
          const scopedPrediction = withExecutorScope(f.db, { featureId: "f", taskId: "T9",
            fence: { serviceGeneration: 1, epoch: 1, bootId: "boot-1" }, claimFence: null, leaseIdOf: () => "lease-1" }, () => {
            expect(f.merge().phase).toBe("merged");
            return predictMergeDeployDetach(f.db, f.intent);
          });
          expect(scopedPrediction).toEqual({ wouldRelease: false, reason: "skip 卡" });
          expect(predictMergeDeployDetach(f.db, f.intent)).toEqual(scopedPrediction);
          expect(f.db.query("SELECT phase FROM scheduler_merges WHERE intentId=?").get(f.intent)).toEqual({ phase: "merged" });
          expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
          expect(held(f)).toBe(1);
          expect(getDeployPending(f.db, f.intent)).toBeNull();
          const proof = getEventByDedup(f.db, `scheduler:${f.intent}:merge:merged`)!;
          expect(proof.data).toMatchObject({ op: "merge_phase", to: "merged", fence: { leaseId: "lease-1" } });
          if (mode === "off") expect(proof.data.mergeDeployObservation).toBeUndefined();
          else expect(proof.data.mergeDeployObservation).toMatchObject({ op: "merge_deploy_observe", protocolVersion: 1,
            intentId: f.intent, mode, wouldRelease: false, reason: "skip 卡" });
          expect(errors).not.toHaveBeenCalled();
        } finally { errors.mockRestore(); f.close(); }
      });
    }
  }

  for (const mode of ["observe", "on"] as const) {
    for (const target of ["", "T9"]) {
      test(`[验收线 4] ${mode} records its prediction despite a public observe key occupied at ${target || "project"}`, () => {
        const f = landing(mode, false);
        try {
          appendEvent(f.db, { actor: "owner", dedupKey: `merge-deploy-outbox:${f.intent}:observe:v1` },
            { project: "p", target, kind: "note", text: "occupied" });
          expect(f.merge().phase).toBe("merged");
          expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
          expect(held(f)).toBe(1);
          expect(getDeployPending(f.db, f.intent)).toBeNull();
          const predictions = f.db.query(`SELECT data FROM events WHERE json_extract(data,'$.op')='merge_deploy_observe'
            AND json_extract(data,'$.intentId')=?`).all(f.intent);
          expect(predictions).toHaveLength(1);
          expect(JSON.parse((predictions[0] as { data: string }).data)).toMatchObject({ wouldRelease: true });
        } finally { f.close(); }
      });
    }
  }

  test("[验收线 4] the public note writer cannot occupy the reserved observe key", () => {
    const f = landing("observe");
    try {
      expect(() => appendEvent(f.db, { actor: "owner", dedupKey: `scheduler:${f.intent}:merge_deploy_observe:v1` },
        { project: "p", target: "T9", kind: "note", text: "occupied" })).toThrow(/scheduler: 前缀/);
      f.merge();
      expect(getEventByDedup(f.db, `scheduler:${f.intent}:merge_deploy_observe:v1`)).toMatchObject({
        kind: "scheduler", data: { op: "merge_deploy_observe", wouldRelease: true },
      });
    } finally { f.close(); }
  });

  for (const failure of ["insert", "partial", "occupied"] as const) {
    test(`[验收线 4] observe ${failure} failure logs the prediction and preserves merged landing`, () => {
      const f = landing("observe"), errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        if (failure === "insert") f.db.exec(`CREATE TRIGGER observe_fail BEFORE INSERT ON events
          WHEN json_extract(NEW.data,'$.op')='merge_deploy_observe' BEGIN SELECT RAISE(ABORT, 'observe failed'); END`);
        else if (failure === "partial") f.db.exec(`CREATE TRIGGER observe_fail AFTER INSERT ON events
          WHEN json_extract(NEW.data,'$.op')='merge_deploy_observe' BEGIN SELECT RAISE(FAIL, 'partial observe failed'); END`);
        else f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (150,'owner','p','','note','occupied','{}',?)")
          .run(`scheduler:${f.intent}:merge_deploy_observe:v1`);
        expect(f.merge().phase).toBe("merged");
        expect(getIntent(f.db, f.intent)?.status).toBe("submitted");
        expect(held(f)).toBe(1);
        expect(getDeployPending(f.db, f.intent)).toBeNull();
        expect(getEventByDedup(f.db, `scheduler:${f.intent}:merge:merged`)).not.toBeNull();
        expect(f.db.query(`SELECT count(*) AS n FROM events WHERE json_extract(data,'$.op')='merge_deploy_observe'
          AND json_extract(data,'$.intentId')=?`).get(f.intent)).toEqual({ n: 0 });
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('"wouldRelease":true'));
      } finally { errors.mockRestore(); f.close(); }
    });
  }

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

  test("[验收线 3] on lets a live train finish a detached member without another ledger settlement", async () => {
    const f = landing(), head = "c".repeat(40), events: TrainEvent[] = [];
    let state: TrainState = { v: 1, id: "p-1", seq: 1, project: "p", repo: "example/repo", base: "b".repeat(40),
      phase: "settling", outcome: null, reason: null, members: [{ taskId: "T9", head, prRef: "https://github.com/example/repo/pull/7", files: [] }],
      cars: [], cleared: ["T9"], merged: [], bounced: [], serial: [], dropped: [], ciRuns: 1, startedAt: 200, updatedAt: 200, skip: [] };
    const store: TrainStore = { load: () => structuredClone(state), all: () => [structuredClone(state)],
      save: (s) => { state = structuredClone(s); }, event: (_p, e) => { events.push(e); }, nextSeq: () => 2 };
    const forbidden = async () => { throw new Error("already merged: no external effect expected"); };
    const gh: TrainGh = { mainHead: forbidden, prFiles: forbidden, prHead: forbidden, createBranch: forbidden, mergeInto: forbidden,
      openDraft: forbidden, checks: forbidden, failLog: forbidden, parents: forbidden, mergeMatchHead: forbidden,
      closePr: forbidden, deleteBranch: forbidden };
    setTrainModeSource(() => "on");
    try {
      f.merge();
      const before = f.db.query("SELECT count(*) AS n FROM events").get();
      expect(memberStatusOf(f.db, "T9", head)).toEqual({ kind: "merged", sha: MERGE });
      const deps = { now: () => 201, notifyPm: async () => {} };
      await mergeTrainTick(f.db, ["p"], deps, { gh, store }, () => ["ci"]);
      expect(state.phase).toBe("cleanup");
      expect(state.merged).toEqual([{ taskId: "T9", sha: MERGE }]);
      await mergeTrainTick(f.db, ["p"], deps, { gh, store }, () => ["ci"]);
      expect(state.phase).toBe("done");
      expect(events.filter((e) => e.kind === "merge")).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
      expect(getIntent(f.db, f.intent)?.status).toBe("done");
      expect(held(f)).toBe(0);
    } finally { setTrainModeSource(null); f.close(); }
  });

  test("[验收线 3] on coexists with PM manual carry and leaves the detached snapshot and settlement intact", async () => {
    const f = landing(), head = "c".repeat(40), newHead = "a".repeat(40), main = "e".repeat(40);
    const reports = statePath("ledger", "reviews"), report = join(reports, `${basename(f.dir)}.md`);
    mkdirSync(reports, { recursive: true });
    writeFileSync(report, `PASS ${head}\n`);
    try {
      const reviewSeq = insertEvent(f.db, { actor: "agent-rv", now: 199 }, { project: "p", target: "T9", kind: "review",
        data: { round: 1, head, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-session", reviewerFamily: "codex",
          path: report, findings: [], p0: 0, p1: 0, p2: 0 } }, false).seq;
      f.merge();
      const pending = getDeployPending(f.db, f.intent), task = getTask(f.db, "T9")!, workflow = getWorkflow(f.db, "T9")!;
      setWorkflow(f.db, { actor: "owner", now: 201 }, { taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev,
        mode: "manual", template: "code", templateVersion: 2, authorFamily: "claude", reason: "pm_takeover: PM 手动推进合并", fallback: "人工" });
      expect(manualMergeAuth(f.db, "owner", { taskId: task.id, pr: task.pr!, head }, 202).ok).toBe(true);
      const carried = await runManualCarry(f.db, { actor: "owner", now: 202 }, { taskId: task.id, oldHead: head, newHead,
        mainHead: main, specRev: task.specRev, round: task.round, reviewSeq, rev: getTask(f.db, task.id)!.rev }, {
        repoDir: "/repo", policy: () => ({ mode: "on", source: "config", manualAfterMs: null }),
        prove: async () => ({ ok: true, reason: "pure main carry", oldHead: head, newHead, mainHead: main, mainParent: main, diffHash: "f".repeat(64),
          chain: [{ previousHead: head, head: newHead, mainParent: main }] }),
      });
      expect(carried.status).toBe("carried");
      expect(getTask(f.db, task.id)?.headSHA).toBe(newHead);
      expect(getDeployPending(f.db, f.intent)).toEqual(pending);
      expect(getIntent(f.db, f.intent)?.status).toBe("done");
      expect(held(f)).toBe(0);
      expect(f.db.query("SELECT count(*) AS n FROM events WHERE json_extract(data,'$.op')='settle' AND json_extract(data,'$.id')=?")
        .get(f.intent)).toEqual({ n: 1 });
    } finally { rmSync(report); f.close(); }
  });

  test("[验收线 3] recovery ignores a detached merged intent and only settles an unknown legacy run", async () => {
    const f = landing();
    try {
      f.merge();
      const before = f.db.query("SELECT count(*) AS n FROM events").get();
      expect(() => resolveMergeRun(f.db, { actor: "owner", now: 201 },
        { intentId: f.intent, outcome: "done", receipt: "verified" })).toThrow(/只有 unknown/);
      const forbidden = async () => { throw new Error("already done: no recovery settlement expected"); };
      await manualResumeManagerTick(f.db, config.projects, { manager: forbidden, notifyPm: forbidden, now: () => 201,
        recoveryPolicy: () => ({ mode: "on", source: "config", manualAfterMs: null }) });
      expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
      expect(getIntent(f.db, f.intent)?.status).toBe("done");
      expect(getDeployPending(f.db, f.intent)).not.toBeNull();
    } finally { f.close(); }
    const legacy = landing();
    try {
      advanceMergeRun(legacy.db, sch, { intentId: legacy.intent, from: "merging", to: "unknown", rev: 3, receipt: "uncertain" });
      expect(held(legacy)).toBe(1);
      resolveMergeRun(legacy.db, { actor: "owner", now: 201 }, { intentId: legacy.intent, outcome: "done", receipt: "verified merge" });
      expect(getIntent(legacy.db, legacy.intent)?.status).toBe("done");
      expect(getDeployPending(legacy.db, legacy.intent)).toBeNull();
      expect(held(legacy)).toBe(0);
    } finally { legacy.close(); }
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
