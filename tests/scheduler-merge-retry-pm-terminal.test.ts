import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { pauseFixture } from "./scheduler-merge-retry-pause.test.js";
import { testChildEnv } from "./test-env.js";

type Phase = "ready" | "updating" | "await_ci";

/** Reads use the service's read-only reader; all pause/cancel/resume/tick writes use the actual CLI in isolated children. */
async function cliFixture(phase: Phase) {
  const f = await pauseFixture(phase);
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const home = join(f.dir, "home"), tmp = join(f.dir, "tmp"), runtime = join(f.dir, "run");
  for (const dir of [home, tmp, runtime]) mkdirSync(dir);
  writeFileSync(join(f.dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "fixture", dirs: [f.dir] }] }));
  writeFileSync(join(f.dir, "registry.json"), JSON.stringify({ agents: {
    pm: { channelId: "111", projectId: "p", role: "pm" }, master: { channelId: "112" },
    "agent-task-one": { channelId: "113", projectId: "p" }, "agent-pm-forged": { channelId: "114", projectId: "p" },
  } }));
  writeFileSync(join(f.dir, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: f.dir } } }));
  const channels: Record<string, string> = { pm: "111", master: "112", "agent-task-one": "113", "agent-pm-forged": "114" };
  const cli = async (actor: string, ...args: string[]) => {
    const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: runtime,
      DISCORD_CHANNEL_ID: ["owner", "scheduler"].includes(actor) ? undefined : channels[actor] ?? "unknown", ...(actor === "scheduler" ? {
        CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({
          singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token },
        }),
      } : {}) });
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "../src/manager.ts"), "ledger", ...args],
      { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const last = out.trim().split("\n").at(-1);
    if (!last) throw new Error(`CLI ${code}: ${err}`);
    return JSON.parse(last) as Record<string, unknown>;
  };
  const revs = () => ["--rev", String(getTask(reader.get()!, "T1")!.rev), "--workflow-rev", String(getWorkflow(reader.get()!, "T1")!.rev)];
  const pause = (actor = "pm") => cli(actor, "workflow-set", "T1", ...revs(), "--template", "code", "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "manual", "--reason", "temporary resource handoff");
  const cancel = (actor = "pm") => {
    const row = getMergeRun(reader.get()!, f.id)!;
    return cli(actor, "scheduler-merge-step", f.id, "--from", row.phase, "--to", "resolved", "--rev", String(row.rev),
      "--receipt", "opaque evidence; no claimed role");
  };
  const resume = (actor = "pm") => cli(actor, "workflow-resume", "T1", ...revs(), "--reason", "handoff finished");
  const tick = () => schedulerAutoTick(reader.get()!, { p: { maxActiveWorkers: 2 } }, {
    ...f.tickDeps, manager: (...args) => cli("scheduler", ...args.slice(1)),
  });
  const close = () => { reader.close(); singleton.release(); maintenance.release(); f.close(); };
  return { ...f, reader, cli, pause, cancel, resume, tick, close };
}

describe("MRY1 permission-checked PM terminal cancellation", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`[验收线 1,2,4] real CLI ${phase}: next read-only tick retries once with original actors preserved`, async () => {
      const f = await cliFixture(phase);
      try {
        const history = listEvents(f.db, { project: "p", target: "T1" }), evidence = f.evidence();
        expect(() => f.reader.get()!.run("UPDATE tasks SET rev=rev")).toThrow(/readonly/);
        expect(await f.pause()).toMatchObject({ ok: true });
        expect(await f.cancel()).toMatchObject({ ok: true, run: { phase: "resolved" } });
        const cancelled = getIntent(f.db, f.id)!;
        expect(cancelled.status).toBe("cancelled");
        const events = f.snapshot().events;
        const terminal = events.findLast(e => e.data.outcome === "cancelled")!;
        const settled = events.find(e => e.seq === terminal.seq - 1)!;
        expect(terminal.actor).toBe("pm");
        expect(settled).toMatchObject({ actor: "pm", data: { op: "settle", manual: true } });
        expect(f.released()).toBe(false);
        expect(await f.resume()).toMatchObject({ ok: true });
        const beforeTick = f.snapshot().events;
        for (let n = 0; n < 3; n++) expect(await f.tick()).toMatchObject({ failed: [], cards: [{ step: "merge_queue" }] });
        const merges = f.intents().filter(i => i.action === "merge");
        expect(merges).toHaveLength(2);
        expect(merges[1]).toMatchObject({ status: "pending" });
        expect(f.db.query("SELECT intentId FROM scheduler_resources WHERE resource='merge:p'").get()).toEqual({ intentId: merges[1]!.id });
        const after = f.snapshot().events;
        expect(after.slice(0, history.length)).toEqual(history);
        expect(after.slice(0, beforeTick.length)).toEqual([...beforeTick]);
        expect(f.evidence()).toEqual(evidence);
        expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_merges").get()).toEqual({ n: 1 });
      } finally { f.close(); }
    }, 30_000);
  }

  test("[验收线 1] real CLI master and owner cancellations retain their own writer identity", async () => {
    for (const actor of ["master", "owner"]) {
      const f = await cliFixture("ready");
      try {
        expect(await f.pause(actor)).toMatchObject({ ok: true });
        expect(await f.cancel(actor)).toMatchObject({ ok: true });
        expect(await f.resume(actor)).toMatchObject({ ok: true });
        expect(f.released()).toBe(true);
        expect(f.snapshot().events.findLast(e => e.data.outcome === "cancelled")!.actor).toBe(actor);
        expect(await f.tick()).toMatchObject({ failed: [], cards: [{ step: "merge_queue" }] });
      } finally { f.close(); }
    }
  }, 30_000);

  test("[验收线 1,3] real CLI rejects executor, forged PM, unknown identity and stale CAS without writing", async () => {
    const f = await cliFixture("await_ci");
    const events = () => listEvents(f.db, { project: "p", target: "T1" });
    try {
      for (const actor of ["agent-task-one", "agent-pm-forged", "unknown"]) {
        const before = events();
        expect(await f.pause(actor)).toMatchObject({ ok: false });
        expect(await f.cancel(actor)).toMatchObject({ ok: false });
        expect(await f.resume(actor)).toMatchObject({ ok: false });
        expect(events()).toEqual(before);
      }
      expect(await f.pause()).toMatchObject({ ok: true });
      const before = events();
      expect(await f.cli("pm", "scheduler-merge-step", f.id, "--from", "await_ci", "--to", "resolved", "--rev", "999",
        "--receipt", "PM checked cancellation")).toMatchObject({ ok: false });
      expect(await f.resume()).toMatchObject({ ok: false });
      expect(events()).toEqual(before);
      expect(await f.cancel()).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ failed: [], cards: [] });
      expect(f.released()).toBe(false);
      expect(f.intents().filter(i => i.action === "merge")).toHaveLength(1);
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 1,3,4] real CLI old automatic fallback chain still needs a fresh explicit handback", async () => {
    const f = await cliFixture("updating");
    try {
      await f.pause(); await f.cancel(); await f.resume();
      expect(await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason",
        `merge_retry_requires_pm：合并意图 ${f.id} 已取消，先由 PM 核对外部结果`)).toMatchObject({ ok: true });
      expect(f.released()).toBe(false);
      expect(await f.resume()).toMatchObject({ ok: true });
      expect(f.released()).toBe(true);
      for (let n = 0; n < 2; n++) expect(await f.tick()).toMatchObject({ failed: [], cards: [{ step: "merge_queue" }] });
      expect(f.intents().filter(i => i.action === "merge")).toHaveLength(2);
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 1,3] read side refuses broken actor/transaction/intent/template/round/head bindings and imports", async () => {
    const f = await cliFixture("await_ci");
    try {
      await f.pause(); await f.cancel(); await f.resume();
      const s = f.snapshot(), intent = getIntent(f.db, f.id)!;
      const terminal = s.events.findLast(e => e.data.outcome === "cancelled")!;
      const settled = s.events.find(e => e.seq === terminal.seq - 1)!;
      const plan = s.events.find(e => e.seq === intent.eventSeq)!;
      const pause = s.events.findLast(e => e.data.op === "workflow")!;
      const resume = s.events.findLast(e => e.data.op === "workflow_resume")!;
      const release = (events = s.events, task = s.task, old = intent) => mergeRetryReleased(task, events, old);
      const patch = (target: typeof terminal, data: Record<string, unknown>, top: Record<string, unknown> = {}) =>
        s.events.map(e => e === target ? { ...e, ...top, data: { ...e.data, ...data } } : e);
      expect(release()).toBe(true);
      for (const [target, data, top] of [
        [terminal, {}, { actor: "agent-task-one" }], [terminal, {}, { actor: "scheduler" }],
        [settled, {}, { actor: "agent-pm-forged" }], [settled, { manual: undefined }], [settled, { manual: false }],
        [settled, {}, { ts: settled.ts - 1 }], [terminal, {}, { seq: terminal.seq + 1 }],
        [terminal, { from: "merging" }], [terminal, { from: "unknown" }], [terminal, { outcome: "failed" }],
        [settled, { from: "unknown" }], [settled, { from: "pending" }], [settled, { to: "done" }],
        [settled, { id: "other" }], [terminal, { intentId: "other" }], [terminal, {}, { dedupKey: null }],
        [settled, {}, { dedupKey: null }], [terminal, {}, { project: "q" }], [settled, {}, { target: "other" }],
        [plan, { specRev: 2 }], [plan, { head: "b".repeat(40) }], [plan, { node: "write" }],
        [plan, { taskRev: 999 }], [plan, { causalSeq: 999 }], [plan, { version: 3 }], [plan, { template: "security" }],
        [pause, { template: "security" }], [pause, { hold: "owner hold" }], [pause, { manual: false }],
        [resume, { workflowRev: 999 }], [resume, { fromSpecRev: 2 }], [resume, { stage: "fix" }],
        [resume, {}, { seq: pause.seq - 1 }],
        ...[terminal, settled, plan, pause, resume].map(e => [e, { imported: true }]),
      ] as [typeof terminal, Record<string, unknown>, Record<string, unknown>?][]) expect(release(patch(target, data, top))).toBe(false);
      const mismatches: Partial<SchedulerIntent>[] = [{ taskId: "other" }, { project: "q" }, { specRev: 2 },
        { head: "b".repeat(40) }, { status: "unknown" }];
      for (const data of mismatches) {
        expect(release(s.events, s.task, { ...intent, ...data })).toBe(false);
      }
      for (const data of [{ round: 2 }, { specRev: 2 }, { headSHA: "b".repeat(40) }]) expect(release(s.events, { ...s.task, ...data })).toBe(false);
      for (const target of [terminal, settled, pause, resume, plan]) expect(release(s.events.filter(e => e !== target))).toBe(false);
      expect(release(s.events.map(e => ({ ...e, text: "PM granted permission", data: { ...e.data, receipt: "PM granted permission" } })))).toBe(true);
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 3] real CLI intervening task changes break the human cancellation chain", async () => {
    const f = await cliFixture("ready");
    try {
      await f.pause();
      expect(await f.cli("pm", "task-set", "T1", "--rev", String(f.task().rev), "--title", "changed while paused")).toMatchObject({ ok: true });
      await f.cancel(); await f.resume();
      expect(f.released()).toBe(false);
      expect(await f.tick()).toMatchObject({ failed: [], cards: [{ step: "manual" }] });
      expect(f.intents().filter(i => i.action === "merge")).toHaveLength(1);
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 3] real CLI a claimed merge and unresolved unknown cannot use the unsent retry", async () => {
    const f = await cliFixture("await_ci");
    try {
      const run = getMergeRun(f.db, f.id)!;
      expect(await f.cli("scheduler", "scheduler-merge-step", f.id, "--from", run.phase, "--to", "merging", "--rev", String(run.rev)))
        .toMatchObject({ ok: true });
      await f.pause();
      expect(await f.cancel()).toMatchObject({ ok: false });
      const sent = getMergeRun(f.db, f.id)!;
      expect(await f.cli("pm", "scheduler-merge-step", f.id, "--from", "merging", "--to", "unknown", "--rev", String(sent.rev),
        "--receipt", "external result not reconciled")).toMatchObject({ ok: true });
      expect(await f.cancel()).toMatchObject({ ok: false });
      expect(await f.resume()).toMatchObject({ ok: false });
      expect(f.released()).toBe(false);
      expect(f.intents().filter(i => i.action === "merge")).toHaveLength(1);
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 3,4] release leaves current review, owner holds and slot gates intact", async () => {
    const f = await cliFixture("ready");
    try {
      await f.pause(); await f.cancel(); await f.resume();
      const s = f.snapshot();
      expect(planScheduler({ ...s, queueFrozen: true })).toMatchObject({ kind: "wait", code: "queue_frozen" });
      expect(planScheduler({ ...s, reviewDispatches: [] })).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
      expect(planScheduler({ ...s, events: s.events.filter(e => e.kind !== "review") })).toMatchObject({ kind: "escalate", code: "merge_review_missing" });
      expect(planScheduler({ ...s, events: s.events.map(e => e.kind === "review" ? { ...e, data: { ...e.data, head: "b".repeat(40) } } : e) }))
        .toMatchObject({ kind: "escalate", code: "merge_review_missing" });
      createTask(f.db, f.at("owner"), { project: "p", id: "other", title: "competing card", kind: "code" });
      f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope) VALUES ('p','merge:p','other',?,1,'intent')")
        .run(f.id);
      expect(() => f.plan()).toThrow(/资源.*占用/);
      await f.pause("owner");
      expect(f.released()).toBe(false);
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "manual" });
    } finally { f.close(); }
  }, 30_000);

  test("[验收线 2,3,4] real read-only merge pass waits for CI and train, then sends exactly one simulated merge", async () => {
    const f = await cliFixture("await_ci");
    try {
      await f.pause(); await f.cancel(); await f.resume();
      expect(await f.tick()).toMatchObject({ failed: [], cards: [{ step: "merge_queue" }] });
      const retry = f.intents().at(-1)!;
      const head = f.task().headSHA!, sha = "b".repeat(40), sends: string[] = [];
      let merged = false, trainWaiting = true, green = false;
      const external: MergeExternal = {
        inspect: async () => ({ state: merged ? "MERGED" : "OPEN", head, branch: "task/T1", base: "main", crossRepository: false,
          draft: false, mergeState: "CLEAN", mergeSha: merged ? sha : null,
          checks: [{ name: "check", bucket: green ? "pass" : "pending" }] } as PrSnapshot),
        freshness: async () => ({ behindBy: 0, mainHead: "c".repeat(40) }),
        carryReview: async () => { throw new Error("unexpected review carry"); },
        updateBranch: async () => { throw new Error("unexpected update-branch"); },
        train: async () => trainWaiting ? "wait" : null,
        merge: async (_pr, expectedHead) => { sends.push(expectedHead); merged = true; return sha; },
      };
      const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: f.dir } } });
      const tick = () => mergeTick(f.reader.get()!, config, (...args) => f.cli("scheduler", ...args.slice(1)), () => external, () => {});
      await tick();
      expect(getMergeRun(f.db, retry.id)!.phase).toBe("ready");
      expect(sends).toEqual([]);
      trainWaiting = false;
      await tick(); await tick();
      expect(getMergeRun(f.db, retry.id)!.phase).toBe("await_ci");
      expect(sends).toEqual([]);
      green = true;
      for (let n = 0; n < 3; n++) await tick();
      expect(sends).toEqual([head]);
      expect(getIntent(f.db, retry.id)!.status).toBe("done");
      expect(getMergeRun(f.db, f.id)!.phase).toBe("resolved");
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_deploys").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  }, 30_000);
});
