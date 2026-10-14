/**
 * CIRES1 fixture: a temp ledger driven through the real ledger CLI and the real merge tick against one fake GitHub. `parked()` is
 * the real path: the card's 4th bounce is a ci_fail on a head whose re-run CIF8 (or CIF1) had formally claimed, the claimed re-run
 * never showed up in time, the journal settled, the planner sent the card to manual for the bounce limit, and the re-run then went
 * green on the same head. The fake counts every `gh run rerun`. No network, no real gh.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "bun:test";
import { addKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { CI_MANUAL_RESUME } from "../src/lib/manual-recovery-ci.js";
import { setCiEvidenceGh, type CiEvidenceGh } from "../src/lib/manual-recovery-ci-read.js";
import { proveRecovery } from "../src/lib/manual-recovery-release.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { RERUN_SETTLE_MS, type CiRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { manualResumeManagerTick, recoveryArgs, recoveryFence, type RecoveryManager } from "../src/lib/scheduler-recovery-ports.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { autoFixture, H2, toBuild } from "./scheduler-auto-helpers.js";

export const PR = "https://github.com/example/repo/pull/9", BRANCH = "task/T1", RUN = "https://github.com/example/repo/actions/runs/77";
export const FLAKY = "tests/flaky-race.test.ts", SLOW = "tests/slow-outside.test.ts", H3 = "3".repeat(40);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const line = (l: string) => `ci\tRun tests\t2026-10-10T11:02:03.1234567Z ${l}`;
/** A red bun test step: one assertion failure per file (CIF8's kind of red). */
export const assertLog = (...files: string[]) => [
  ...files.flatMap((f) => [`##[group]${f}:`, "error: expect(received).toBe(expected)", "(fail) 竞态 > 断言 [0.40ms]", "##[endgroup]"]),
  " 1999 pass", ` ${files.length} fail`, "##[error]Process completed with exit code 1.",
].map(line).join("\n");
/** A red bun test step whose only failure is a timeout (CIF1's kind of red). */
export const timeoutLog = (file: string) => [`##[group]${file}:`, "(fail) 慢 > 等不到 [5001.11ms]", "  ^ this test timed out after 5000ms.", "##[endgroup]",
  " 1999 pass", " 1 fail", "##[error]Process completed with exit code 1."].map(line).join("\n");

let saved: Buffer | null = null;
/** Each test file calls this once: the policy file is the sandbox's, and no fake outlives its test. */
export function isolate(): void {
  beforeEach(() => {
    expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
    saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
    rmSync(RECOVERY_POLICY_PATH, { force: true });
  });
  afterEach(() => {
    setKnownFlakyModeSource(null);
    setCiEvidenceGh(null);
    if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
    else rmSync(RECOVERY_POLICY_PATH, { force: true });
  });
}

export interface Over {
  /** bounces already on the card before this merge run (3 = this one hits the limit) */
  prior?: number;
  /** how the red is authorized: CIF8's list, CIF1's timeout rule, or not at all (the bounce then carries no claim) */
  claim?: "flaky" | "timeout" | "none";
  /** the 4th bounce is a conflict instead of a red CI */
  conflict?: boolean;
  /** leave the entry to the caller instead of the planner's own escalation */
  entry?: false;
}

/** One GitHub for the merge driver and for the evidence read; tests flip its fields. */
function github(first: string) {
  const gh = { state: "OPEN" as PrSnapshot["state"], head: H2, mergeState: "UNSTABLE",
    checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] as { name: string; bucket: string; link?: string }[],
    attempt: 1, status: "completed", conclusion: "failure", firstLog: first, files: ["src/lib/x.ts"], broken: null as Error | null, mergeSha: null as string | null, calls: [] as string[] };
  const snap = (): PrSnapshot => ({ state: gh.state, head: gh.head, branch: BRANCH, base: "main", draft: false, crossRepository: false, mergeState: gh.mergeState,
    mergeSha: gh.mergeSha, checks: gh.checks as PrSnapshot["checks"] });
  const attempt = async () => ({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion, headSha: gh.head });
  const ciRerun: CiRerunGh = { runAttempt: attempt, failedLog: async () => gh.firstLog, prFiles: async () => gh.files, rerunFailed: async () => { gh.calls.push("rerun"); } };
  const external = { inspect: async () => { gh.calls.push("inspect"); return snap(); }, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => { gh.calls.push("update"); },
    merge: async () => { gh.calls.push("merge"); gh.state = "MERGED"; return (gh.mergeSha = "9".repeat(40)); }, ciRerun } as MergeExternal;
  const reach = <T>(what: string, value: () => T) => async (): Promise<T> => { gh.calls.push(`read:${what}`); if (gh.broken) throw gh.broken; return value(); };
  const evidence: CiEvidenceGh = { inspect: reach("pr", snap), runAttempt: reach("run", () => ({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion })),
    firstFailedLog: reach("log", () => gh.firstLog), prFiles: reach("files", () => gh.files) };
  /** The claimed re-run finished green and the PR's checks caught up. */
  const rerunGreen = () => { Object.assign(gh, { attempt: 2, status: "completed", conclusion: "success", mergeState: "CLEAN", checks: [{ name: "ci", bucket: "pass", link: `${RUN}/job/10` }] }); };
  return { gh, external, evidence, rerunGreen };
}

/** The real path up to the manual entry; see the file head. */
export async function parked(over: Over = {}) {
  const f = autoFixture();
  f.advance(Date.now()); // the gates' own reads use the wall clock
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  await f.review("pass", H2, []);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
  f.db.query("UPDATE tasks SET pr = ?, branch = ? WHERE id = 'T1'").run(PR, BRANCH);
  expect(await f.cli("scheduler", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await f.cli("scheduler", "scheduler-merge-begin", id, "--required-checks", "ci")).toMatchObject({ ok: true, run: { phase: "ready" } });
  const claim = over.claim ?? "flaky";
  setKnownFlakyModeSource(() => (claim === "flaky" ? "on" : "off"));
  const featureId = createFeature(f.db, f.at("owner"), { project: "p", slug: "rel", title: "rel" }).row.id;
  initDag(f.db, f.at("owner"), { id: featureId, rev: 1, nodes: [{ key: "FLAKY1", oneLine: "修时序竞态" }] });
  addKnownFlaky(f.db, f.at("owner"), { project: "p", file: FLAKY, featureId, node: "FLAKY1", reason: "时序竞态" });
  // earlier rounds' bounces (their own heads and runs are long gone); only their count matters to the limit
  const old = f.db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', 'p', 'T1', 'scheduler', ?, ?)");
  for (let n = 1; n <= (over.prior ?? 3); n++) {
    old.run(f.at("scheduler").now, `合并队列：退回 fix（conflict，第 ${n} 次）`, JSON.stringify({ op: "merge_conflict", intentId: `earlier-${n}`, cause: "conflict", count: n, escalated: false }));
  }
  const hub = github(claim === "timeout" ? timeoutLog(SLOW) : assertLog(FLAKY));
  setCiEvidenceGh(hub.evidence);
  const manager: RecoveryManager = (...a: string[]) => f.cli("scheduler", ...a.slice(1)) as Promise<Record<string, unknown>>;
  const mergeTick = () => schedulerMergeTick(f.db, config, manager, () => hub.external);
  if (over.conflict) hub.gh.mergeState = "DIRTY";
  await mergeTick(); // red CI: the claim (if any) is written, then `gh run rerun` goes out; or the bounce
  if (claim !== "none" && !over.conflict) {
    f.advance(RERUN_SETTLE_MS + 60_000); // GitHub still shows the old attempt: 重跑没有开始 → the ci_fail bounce
    await mergeTick();
  }
  if (over.entry !== false && (over.prior ?? 3) >= 3) expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
  if (!over.conflict) hub.rerunGreen();
  return Object.assign(f, hub, { merge: id, featureId, manager, mergeTick });
}
export type Ci = Awaited<ReturnType<typeof parked>>;

export const wf = (f: Ci) => getWorkflow(f.db, "T1")!;
export const events = (f: Ci) => listEvents(f.db, { project: "p", target: "T1" });
export const ev = (f: Ci, op: string) => events(f).filter((e) => e.data.op === op);
export const reruns = (f: Ci) => f.gh.calls.filter((c) => c === "rerun").length;
export const reads = (f: Ci) => f.gh.calls.filter((c) => c.startsWith("read:")).length;
/** Everything a recovery could move: intents, slots, journals, the workflow, the stage and the bounce history. */
export const state = (f: Ci) => ({
  intents: f.db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  merges: f.db.query("SELECT intentId, phase, mergeSha FROM scheduler_merges ORDER BY intentId").all(),
  deploys: f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'scheduler_deploys'").get() ? f.db.query("SELECT intentId, phase FROM scheduler_deploys").all() : [],
  workflow: f.db.query("SELECT mode, rev, specRev FROM task_workflows WHERE taskId = 'T1'").get(), stage: f.task().stage, round: f.task().round,
  bounces: ev(f, "merge_conflict").map((e) => [e.seq, e.data.count, e.data.cause]),
});
export const policy = async (f: Ci, mode: RecoveryMode, key?: string) => expect(await f.cli("pm", "scheduler-recovery", "p", mode,
  ...(key ? ["--key", key] : []), "--reason", `CIRES1 测试：${key ?? "项目"} ${mode}`)).toMatchObject({ ok: true });
export const turnOn = async (f: Ci) => { await policy(f, "on", "manualRecovery"); await policy(f, "on", "ciManualResume"); };
/** The leased writer, called directly (what the tick calls through the manager). */
export const recover = (f: Ci, mode: "on" | "observe") => f.cli("scheduler", "scheduler-manual-resume", "T1",
  ...recoveryArgs(recoveryFence(f.db, f.task())), "--mode", mode, "--mechanism", CI_MANUAL_RESUME, "--max-workers", "2");
/** The scheduler's manual-resume tick (MAN2, then the evidence mechanisms), this mechanism's rows only. */
export const ci = async (f: Ci, manager: RecoveryManager = f.manager) => (await manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } },
  { manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now })).filter((o) => "mechanism" in o && o.mechanism === CI_MANUAL_RESUME);
/** The proof as the CLI computes it: a fresh leased read, then the judge. */
export const prove = async (f: Ci) => {
  const m = (await import("../src/lib/manual-recovery-release.js")).manualRecoveryMechanism(CI_MANUAL_RESUME)!;
  let external = null;
  try { external = await m.readEvidence!(f.task()); } catch (e) { return { kind: "refused" as const, why: `读外部证据失败：${(e as Error).message}` }; }
  return proveRecovery(f.db, f.task(), wf(f), CI_MANUAL_RESUME, external);
};
export const observed = (f: Ci) => ev(f, "recovery_observe").filter((e) => e.data.mechanism === "ciManualResume");
export const run = async (over: Over, body: (f: Ci) => Promise<void>) => { const f = await parked(over); try { await body(f); } finally { f.close(); } };
