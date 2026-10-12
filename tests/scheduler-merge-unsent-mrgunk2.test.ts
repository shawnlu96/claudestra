/** MRGUNK2: the central plan guard, PM resume, a PR gone elsewhere and the cancel wording, on a disposable ledger and fake GitHub. */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { advanceMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getMeta, listEvents } from "../src/lib/ledger-store.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { unsentRetryPlan } from "../src/lib/scheduler-merge-unsent-plan.js";
import { schedulerV2PlanFlags, schedulerV2PlanGuard } from "../src/lib/scheduler-v2-ledger-cmds-plan.js";
import { schedulerV2LedgerFlags } from "../src/lib/scheduler-v2-ledger-cmds-args.js";

let savedPolicy: string | null;
beforeEach(() => { savedPolicy = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; });
const T0 = Date.UTC(2026, 9, 12);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/mrgunk2" } } });
afterEach(() => {
  setSystemTime();
  if (savedPolicy === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else writeFileSync(RECOVERY_POLICY_PATH, savedPolicy);
});

async function fixture(value: "on" | "observe") {
  const f = autoFixture();
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeUnsentCancel: value } } } }));
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  await f.tick();
  expect((await f.review("pass", H1, [])).ok).toBe(true);
  await f.tick();
  f.db.query("UPDATE tasks SET pr=?, branch=? WHERE id='T1'").run("https://github.com/example/repo/pull/1", "task/T1");
  await f.tick();
  let pr: Partial<PrSnapshot> = {};
  const gh: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: f.task().headSHA!, branch: "task/T1", base: "main", draft: false,
      crossRepository: false, mergeState: "UNKNOWN", checks: [], mergeSha: null, ...pr }),
    freshness: async () => ({ behindBy: 0, mainHead: "b".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "unused" }),
    updateBranch: async () => { throw new Error("unused"); },
    merge: async () => { throw new Error("unused"); },
  };
  const intent = () => f.intents().filter((i) => i.action === "merge" && getIntent(f.db, i.id)?.taskId === "T1").at(-1)!.id;
  const run = () => getMergeRun(f.db, intent())!;
  const mergeTick = async (at: number) => {
    setSystemTime(new Date(at));
    await schedulerMergeTick(f.db, config, async (...args) => f.cliWith({ now: () => Date.now() }, "scheduler", ...args.slice(1)), () => gh);
  };
  await mergeTick(T0);
  const end = (receipt = "GitHub 合并状态 10 分钟仍未算出") => advanceMergeRun(f.db, { actor: "scheduler", now: Date.now() },
    { intentId: intent(), from: run().phase, to: "unknown", rev: run().rev, receipt });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const decide = () => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
  /** The central route's read-only guard on the exact flags the auto tick would send for a merge proposal. */
  const guard = (id = "central-merge") => {
    const seq = (f.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
    const args = ["ledger", "scheduler-plan", "T1", "--id", id, "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev),
      "--seq", String(seq), "--node", "merge_deploy", "--action", "merge", "--reason", "merge_deploy：合并", "--resources", "merge:p"];
    try { schedulerV2PlanGuard(f.db, f.task(), schedulerV2LedgerFlags(args, schedulerV2PlanFlags)); return "ok"; }
    catch (e) { return (e as Error).message; }
  };
  return { ...f, mergeTick, run, end, intent, events, gh, decide, guard, setPr: (p: Partial<PrSnapshot>) => { pr = p; } };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function withFixture(value: "on" | "observe", body: (f: F) => Promise<void>) {
  const f = await fixture(value);
  try { await body(f); } finally { f.close(); }
}
const cancellations = (f: F) => f.events().filter((e) => e.data.op === "merge_unsent_cancel");
const limitNotices = (f: F) => f.notices.filter((n) => n.includes("merge_bounce_limit"));
async function resume(f: F, actor = "pm") {
  return f.cli(actor, "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev),
    "--reason", "PM 已核对 GitHub，未发出合并，交回自动");
}

describe("MRGUNK2 central guard and planner agree", () => {
  test("[验收线 1] after an unsent cancellation the central guard admits the retry; at the limit both hand to PM", async () => {
    await withFixture("on", async (f) => {
      for (let i = 1; i <= 2; i++) {
        f.end();
        expect(f.decide()).toMatchObject({ kind: "intent", action: "merge" });
        expect(f.guard()).toBe("ok");
        expect(await f.tick()).toMatchObject({ step: "merge_queue" });
        await f.mergeTick(T0 + i);
      }
      f.end();
      expect(f.decide()).toMatchObject({ kind: "escalate", code: "merge_bounce_limit" });
      expect(f.guard()).toMatch(/自动重试禁用/);
    });
  });

  test("[验收线 1] the real auto tick's merge proposal passes the central guard it would meet on the central route", async () => {
    await withFixture("on", async (f) => {
      const seen: string[] = [], manager = f.tickDeps.manager;
      f.tickDeps.manager = async (...args) => {
        if (args[1] === "scheduler-plan" && args.includes("merge")) {
          try { schedulerV2PlanGuard(f.db, f.task(), schedulerV2LedgerFlags(args, schedulerV2PlanFlags)); seen.push("ok"); }
          catch (e) { seen.push((e as Error).message); }
        }
        return manager(...args);
      };
      f.end();
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(seen).toEqual(["ok"]);
    });
  });

  test("[验收线 1] a non-unsent cancellation is still refused by both", async () => {
    await withFixture("on", async (f) => {
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
      f.end("PM took over");
      f.db.query("UPDATE task_workflows SET mode='auto' WHERE taskId='T1'").run();
      expect(cancellations(f)).toHaveLength(0);
      expect(f.decide()).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
      expect(f.guard()).toMatch(/自动重试禁用/);
    });
  });
});

describe("MRGUNK2 PM resume restarts the streak", () => {
  test("[验收线 2] PM workflow-resume after the limit replans at once; three more unsent cancellations hand to PM again", async () => {
    await withFixture("on", async (f) => {
      for (let i = 1; i <= 3; i++) {
        f.end();
        const step = await f.tick();
        if (i < 3) { expect(step?.step).toBe("merge_queue"); await f.mergeTick(T0 + i); }
        else expect(step).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
      }
      await f.tick();
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(limitNotices(f)).toHaveLength(1);
      const head = f.task().headSHA;
      expect((await resume(f)).ok).toBe(true);
      expect(f.task().headSHA).toBe(head);
      expect(f.guard()).toBe("ok");
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
      expect(limitNotices(f)).toHaveLength(1);
      for (let i = 1; i <= 3; i++) {
        await f.mergeTick(T0 + 10 + i);
        f.end();
        const step = await f.tick();
        if (i < 3) expect(step?.step).toBe("merge_queue");
        else expect(step).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
      }
      await f.tick();
      expect(limitNotices(f)).toHaveLength(2);
    });
  });

  test("[验收线 2] only a PM resume counts: a scheduler or non-manual resume event leaves the limit in place", async () => {
    await withFixture("on", async (f) => {
      for (let i = 1; i <= 3; i++) { f.end(); if (i < 3) { await f.tick(); await f.mergeTick(T0 + i); } }
      const snap = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
      const last = getIntent(f.db, f.intent())!, tail = snap.events.at(-1)!;
      const resumeEvent = { ...tail, seq: tail.seq + 1, dedupKey: null, kind: "scheduler" as const, actor: "pm",
        data: { op: "workflow_resume", from: "manual", manual: true } };
      expect(unsentRetryPlan(snap.events, last, snap.task)).toBe("limit");
      expect(unsentRetryPlan([...snap.events, resumeEvent], last, snap.task)).toBe("retry");
      for (const twist of [{ actor: "scheduler" }, { data: { op: "workflow_resume", from: "manual", auto: true } },
        { data: { op: "workflow_resume", from: "manual", manual: true, imported: true } }]) {
        expect(unsentRetryPlan([...snap.events, { ...resumeEvent, ...twist }], last, snap.task)).toBe("limit");
      }
    });
  });
});

describe("MRGUNK2 a PR no longer open is PM's, not an unsent retry", () => {
  for (const pr of [{ state: "MERGED" as const }, { state: "CLOSED" as const }, { base: "release" }]) {
    test(`[验收线 3] ready reads ${JSON.stringify(pr)}: unknown + freeze, the receipt names the PR state`, async () => {
      for (const value of ["on", "observe"] as const) await withFixture(value, async (f) => {
        f.setPr(pr);
        await f.mergeTick(T0 + 1);
        expect(f.run().phase).toBe("unknown");
        expect(getIntent(f.db, f.intent())?.status).toBe("submitted");
        const shown = `${pr.state ?? "OPEN"}/${pr.base ?? "main"}`;
        expect(f.run().reason).toContain(shown);
        expect(getMeta(f.db, "p").queueFrozen).toMatchObject({ frozen: true, reason: expect.stringContaining(shown) });
        expect(cancellations(f)).toHaveLength(0);
        expect(f.events().filter((e) => e.data.mechanism === "mergeUnsentCancel")).toHaveLength(0);
      });
    });
  }

  test("[验收线 3] an open PR on main whose branch moved keeps MRGUNK1's unsent cancellation", async () => {
    await withFixture("on", async (f) => {
      f.setPr({ branch: "task/other" });
      await f.mergeTick(T0 + 1);
      expect(f.run().phase).toBe("resolved");
      expect(cancellations(f)).toHaveLength(1);
    });
  });
});

describe("MRGUNK2 the cancellation says who cancelled", () => {
  test("[验收线 4] an auto unsent cancellation never claims a PM switch to manual", async () => {
    await withFixture("on", async (f) => {
      f.end("read failed");
      const terminal = f.events().findLast((e) => e.data.op === "merge_phase" && e.data.outcome === "cancelled")!;
      for (const text of [getIntent(f.db, f.intent())!.receipt!, f.run().reason!, terminal.text]) {
        expect(text).not.toContain("PM 切手动");
        expect(text).toContain("auto 卡合并未发出，自动取消重排");
      }
    });
  });

  test("[验收线 4] a PM switch to manual keeps the original wording", async () => {
    await withFixture("on", async (f) => {
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
      f.end("PM took over");
      const terminal = f.events().findLast((e) => e.data.op === "merge_phase" && e.data.outcome === "cancelled")!;
      expect(getIntent(f.db, f.intent())!.receipt).toBe("merge cancelled（PM 切手动，未发出 merge）：PM took over");
      expect(f.run().reason).toBe("cancelled: PM 切手动，未发出 merge（PM took over）");
      expect(terminal.text).toBe("合并队列：PM 切手动，撤销未发出的合并（PM took over）");
    });
  });
});
