/**
 * PMHAND1 12 (verifyAfterResolve): a deploy run PM / owner resolved as `done`, card live on the merge's reviewed head and the run's
 * spec → on: the deploy tick runs the same verify (dry-run first, only a pass recorded, nothing waived); observe: one note; off: as
 * before. Resolved as cancelled / failed, a moved head or a new spec → no verify. Synthetic ledger (tests/deploy-test-kit.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { listEvents } from "../src/lib/ledger-store.js";
import { recordVerify } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { getDeployRun, resolveDeployRun } from "../src/lib/scheduler-deploy.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import type { MergeResolution } from "../src/lib/scheduler-merge.js";
import { schedulerCanVerify } from "../src/lib/scheduler-verify-gate.js";
import { ledgerAs, mergedCard, type MergedCard } from "./deploy-test-kit.js";

const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };
afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const policy = (mode: "on" | "observe" | "off" | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { verifyAfterResolve: mode } } } }));

function jobs() {
  const s = { view: null as Awaited<ReturnType<DeployJobs["observe"]>> };
  const j: DeployJobs = { label: () => LABEL, observe: async () => s.view, remove: async () => true,
    submit: async () => { s.view = { label: LABEL, liveness: "alive", result: null, deadline: 10_000 }; return LABEL; } };
  return { s, j };
}

/** The scheduler's manager child: `ledger verify` goes through the real write path and its scheduler gate (facts collection skipped). */
function deps(db: Database, j: DeployJobs, verify: string[],
  o: { now?: number; dry?: "pass" | "fail"; formal?: "pass" | "fail"; duringDry?: () => void } = {}) {
  const now = () => o.now ?? 1000, ledger = ledgerAs(db, "scheduler", now);
  const manager = async (...args: string[]) => {
    if (args[1] !== "verify") return ledger(...args);
    verify.push(args.slice(2).join(" "));
    if (args.includes("--dry-run")) { o.duringDry?.(); return { ok: true, result: o.dry ?? "pass" }; }
    if (!schedulerCanVerify(db, args[2]!, args[4])) return { ok: false, code: "forbidden", error: "调度服务只可核对自己部署过的本卡" };
    const result = o.formal ?? "pass"; // the formal run collects the facts again: it may turn red after a green dry-run
    const r = recordVerify(db, { actor: "scheduler", now: now(), dedupKey: args[4] }, { taskId: args[2]!, result,
      data: { checks: [{ id: "pr-merged", status: result }], incomplete: false } });
    if (r.duplicate) return { ok: r.event.data.result === "pass", task: r.row, duplicate: true };
    return result === "pass" ? { ok: true, moved: true, task: r.row } : { ok: false, code: "unverified", error: "检查单没过", task: r.row };
  };
  return { manager, jobs: j, assertActive: () => {}, now };
}

/** Merged → deploy failed → unknown → resolved by the owner as `outcome`; the PM then put the card in live by hand. */
async function resolvedCard(outcome: MergeResolution): Promise<MergedCard> {
  const f = mergedCard(), { s, j } = jobs();
  await deployTick(f.db, config, deps(f.db, j, []));
  s.view = { label: LABEL, liveness: "dead", result: { ok: false, summary: "重启超时" }, deadline: 10_000 };
  await deployTick(f.db, config, deps(f.db, j, []));
  expect(getDeployRun(f.db, f.intent)?.phase).toBe("unknown");
  resolveDeployRun(f.db, { actor: "owner", now: 300 }, { intentId: f.intent, outcome, receipt: "上机核过，服务已是新版本" });
  f.db.query("UPDATE tasks SET stage='live', rev=rev+1 WHERE id='T9'").run();
  f.db.query("UPDATE meta SET value=? WHERE project='p' AND key='queueFrozen'").run(JSON.stringify({ frozen: false }));
  return f;
}
const stage = (f: MergedCard) => (f.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage;
const notes = (f: MergedCard, op: string) => listEvents(f.db, { project: "p", target: "T9" }).filter((e) => e.data.op === op);

describe("[验收线 5] verifyAfterResolve", () => {
  test("on: resolved-done, same head and spec, live → dry-run then the recorded verify, one resolve_verify sample", async () => {
    policy("on");
    const f = await resolvedCard("done"), verify: string[] = [];
    try {
      expect(schedulerCanVerify(f.db, "T9")).toBe(true);
      await deployTick(f.db, config, deps(f.db, jobs().j, verify));
      expect(verify).toEqual(["T9 --dry-run", "T9 --dedup deploy-verify:m9:1000"]);
      expect(stage(f)).toBe("verified");
      expect(notes(f, "pm_handback").map((e) => e.data.type)).toEqual(["resolve_verify"]);
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 10_000_000 }));
      expect(verify).toHaveLength(2); // verified: not a candidate any more
    } finally { f.close(); }
  });

  test("on: a failing dry-run records nothing (never a failure), and is retried later", async () => {
    policy("on");
    const f = await resolvedCard("done"), verify: string[] = [];
    try {
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 5_000_000, dry: "fail" }));
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 5_000_001, dry: "fail" }));
      expect(verify).toEqual(["T9 --dry-run"]);
      expect(stage(f)).toBe("live");
      expect(listEvents(f.db, { project: "p", target: "T9" }).filter((e) => e.kind === "verify")).toEqual([]);
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 6_000_000 }));
      expect(stage(f)).toBe("verified");
    } finally { f.close(); }
  });

  test("on: a check red after a green dry-run takes no key a later try needs; the next try verifies", async () => {
    policy("on");
    const f = await resolvedCard("done"), verify: string[] = [];
    try {
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 5_000_000, formal: "fail" }));
      expect(verify).toEqual(["T9 --dry-run", "T9 --dedup deploy-verify:m9:5000000"]);
      expect(stage(f)).toBe("live");
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 5_000_001 }));
      expect(verify).toHaveLength(2); // not due yet
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 6_000_000 }));
      expect(verify.slice(2)).toEqual(["T9 --dry-run", "T9 --dedup deploy-verify:m9:6000000"]);
      expect(stage(f)).toBe("verified");
      expect(notes(f, "pm_handback").map((e) => e.data.type)).toEqual(["resolve_verify"]);
    } finally { f.close(); }
  });

  test("on: resolved as cancelled / failed, a moved head, a new spec → no verify, gate closed", async () => {
    policy("on");
    for (const c of ["cancelled", "failed", "head", "spec"] as const) {
      const f = await resolvedCard(c === "cancelled" || c === "failed" ? c : "done"), verify: string[] = [];
      try {
        if (c === "head") f.db.query("UPDATE tasks SET headSHA=? WHERE id='T9'").run("e".repeat(40));
        if (c === "spec") {
          f.db.query("UPDATE tasks SET specRev=2 WHERE id='T9'").run();
          f.db.query("UPDATE task_workflows SET specRev=2 WHERE taskId='T9'").run();
        }
        expect(schedulerCanVerify(f.db, "T9")).toBe(false);
        await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 7_000_000 }));
        expect({ c, verify, stage: stage(f) }).toEqual({ c, verify: [], stage: "live" });
      } finally { f.close(); }
    }
  });

  test("observe (also the unconfigured default): one observation note, no verify call", async () => {
    for (const [i, mode] of (["observe", null] as const).entries()) {
      policy(mode);
      const f = await resolvedCard("done"), verify: string[] = [], at = 20_000_000 * (i + 1); // tries are paced per run id across ledgers
      try {
        await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: at }));
        await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: at + 1_000_000 }));
        expect(verify).toEqual([]);
        expect(stage(f)).toBe("live");
        expect(notes(f, "recovery_observe").map((e) => e.data.mechanism)).toEqual(["verifyAfterResolve"]);
        expect(notes(f, "pm_handback")).toEqual([]);
      } finally { f.close(); }
    }
  });

  test("off: nothing at all, as before the card", async () => {
    policy("off");
    const f = await resolvedCard("done"), verify: string[] = [];
    try {
      await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 90_000_000 }));
      expect(verify).toEqual([]);
      expect(notes(f, "recovery_observe")).toEqual([]);
      expect(stage(f)).toBe("live");
    } finally { f.close(); }
  });

  test("on: the key switched to off / observe while the dry-run ran → no recorded verify (observe: one note)", async () => {
    for (const [i, to] of (["off", "observe"] as const).entries()) {
      policy("on");
      const f = await resolvedCard("done"), verify: string[] = [];
      try {
        await deployTick(f.db, config, deps(f.db, jobs().j, verify, { now: 200_000_000 * (i + 1), duringDry: () => policy(to) }));
        expect({ to, verify, stage: stage(f) }).toEqual({ to, verify: ["T9 --dry-run"], stage: "live" });
        expect(listEvents(f.db, { project: "p", target: "T9" }).filter((e) => e.kind === "verify")).toEqual([]);
        expect(notes(f, "recovery_observe").map((e) => e.data.mechanism)).toEqual(to === "observe" ? ["verifyAfterResolve"] : []);
      } finally { f.close(); }
    }
  });
});
