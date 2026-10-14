/**
 * MAINCIW2: main CI still running only waits, a confirmed failure pauses, missing evidence pauses conservatively (pure evaluate + plan,
 * synthetic GitHub data, injected clock). Rule "run" is what mainCiPause=on uses; "legacy" (observe / the CLI) is the original reading.
 */
import { describe, expect, test } from "bun:test";
import { evaluateMainCi, MAIN_CI_RUN_CREATE_MS, MAIN_CI_RUN_MAX_MS, type MainCiTarget } from "../src/lib/scheduler-main-ci.js";
import { mainCiEvidence, planMainCi, type MainCiPlanInput } from "../src/lib/scheduler-main-ci-plan.js";

const T0 = Date.parse("2026-10-14T00:00:00Z"), MIN = 60_000;
const MAIN = "a".repeat(40), NEXT = "b".repeat(40);
const target: MainCiTarget = { project: "p", repo: "example/repo", requiredChecks: ["tests", "web"] };
const iso = (t: number) => new Date(t).toISOString();
type Check = { status: string; conclusion: string | null } | null;
type Run = { id?: number; attempt?: number; status: string; conclusion?: string | null; created?: number; event?: string };
const pushRun = (r: Run, sha = MAIN) => ({ id: r.id ?? 7, run_attempt: r.attempt ?? 1, event: r.event ?? "push", head_sha: sha, status: r.status,
  conclusion: r.conclusion ?? null, created_at: iso(r.created ?? T0), check_suite_id: 70 });

function health(o: { tests?: Check; web?: Check; runs?: Run[] | null; commit?: number | null; at: number; sha?: string }) {
  const sha = o.sha ?? MAIN, main = { project: "p", repo: "example/repo", ref: "refs/heads/main", sha };
  const checks = ([["tests", o.tests], ["web", o.web]] as const).filter(([, c]) => c !== null)
    .map(([name, c], i) => ({ id: i + 1, name, head_sha: sha, ...(c ?? { status: "completed", conclusion: "success" }) }));
  const envelope: Record<string, unknown> = { ...main, total_count: checks.length, check_runs: checks, commit_status: { sha, total_count: 0, statuses: [] } };
  if (o.runs !== null) envelope.push_runs = { runs: (o.runs ?? []).map((r) => pushRun(r, sha)), commit_time: o.commit === null ? null : iso(o.commit ?? T0) };
  return evaluateMainCi(target, { before: main, after: main, checks: envelope, observedAt: o.at });
}
const plan = (h: ReturnType<typeof health>, rule: "run" | "legacy" = "run", over: Partial<MainCiPlanInput> = {}) => planMainCi({
  target, health: h, now: h.observedAt, maxAgeMs: 10 * MIN, currentMainSha: h.mainSha, readFailureSince: null, uncertainty: null,
  candidate: { project: "p", repo: "example/repo", taskId: "T1", head: "c".repeat(40) }, projectPms: [], approvals: [], notificationClaims: [], rule, ...over });
const go = { formTrain: "normal-gates", updateBranch: "normal-gates", rerun: "normal-gates", merge: "normal-gates", bounce: "normal-gates" } as const;
const paused = { formTrain: "pause", updateBranch: "pause", rerun: "pause", merge: "pause", bounce: "pause" } as const;
const PENDING = { status: "in_progress", conclusion: null }, QUEUED = { status: "queued", conclusion: null };

describe("[验收线 1] a running main push run only waits", () => {
  test.each(["queued", "in_progress"])("push run %s, required checks missing / pending: main_ci_pending, every gate normal", (status) => {
    const h = health({ tests: PENDING, web: null, runs: [{ status }], at: T0 + 20 * MIN });
    expect(h.state).toBe("unknown"); // the original health is untouched
    expect(h.ci).toMatchObject({ verdict: "pending", why: "run_active", runs: [{ id: 7, attempt: 1, status }] });
    expect(plan(h)).toMatchObject({ reason: "main_ci_pending", actions: go, notification: null, cancelExistingCi: false,
      ci: { rule: "run", verdict: "pending", runs: [{ id: 7, attempt: 1, status, conclusion: null }] } });
    // 先红: the original rule (and observe / off) still pauses the same input
    expect(plan(h, "legacy")).toMatchObject({ reason: "main_unhealthy", actions: paused });
  });

  test("no push run yet, inside 15 minutes of the commit: waiting; the waiting state sends no PM notice", () => {
    const h = health({ tests: null, web: null, runs: [], commit: T0, at: T0 + MAIN_CI_RUN_CREATE_MS - 1 });
    expect(h.ci).toMatchObject({ verdict: "pending", why: "run_not_created_yet" });
    const p = plan(h, "run", { uncertainty: { project: "p", repo: "example/repo", mainSha: MAIN, since: T0 - 60 * MIN } });
    expect(p).toMatchObject({ reason: "main_ci_pending", actions: go, notification: null });
    expect(plan(h, "legacy", { uncertainty: { project: "p", repo: "example/repo", mainSha: MAIN, since: T0 - 60 * MIN } }).notification)
      .toMatchObject({ kind: "checks_unavailable" });
  });
});

describe("[验收线 2] only a confirmed failure is a fault pause", () => {
  test("a completed failure next to a pending check and a running run is a failure, never waiting", () => {
    const h = health({ tests: { status: "completed", conclusion: "failure" }, web: PENDING, runs: [{ status: "in_progress" }], at: T0 + 5 * MIN });
    expect(h.ci).toMatchObject({ verdict: "unhealthy", why: "check_failed" });
    expect(plan(h)).toMatchObject({ reason: "main_unhealthy", actions: paused, notification: { kind: "main_red" } });
  });
  test.each(["failure", "timed_out", "skipped", "action_required"])("completed %s with the run completed: main_unhealthy, same as the original", (c) => {
    const h = health({ tests: { status: "completed", conclusion: c }, runs: [{ status: "completed", conclusion: "failure" }], at: T0 + 20 * MIN });
    const run = plan(h), legacy = plan(h, "legacy");
    expect(run).toMatchObject({ reason: "main_unhealthy", actions: paused });
    const { ci: _a, ...r } = run, { ci: _b, ...l } = legacy;
    expect(r).toEqual(l);
  });
});

describe("[验收线 3] evidence gaps pause conservatively (injected clock, no sleep)", () => {
  const cases: [string, Parameters<typeof health>[0], string][] = [
    ["no push run 15 minutes after the commit", { tests: null, web: null, runs: [], commit: T0, at: T0 + MAIN_CI_RUN_CREATE_MS }, "run_not_created"],
    ["run older than 60 minutes still running", { tests: PENDING, runs: [{ status: "in_progress", created: T0 }], at: T0 + MAIN_CI_RUN_MAX_MS + 1 }, "run_overdue"],
    ["queued run older than 60 minutes", { tests: QUEUED, runs: [{ status: "queued", created: T0 }], at: T0 + MAIN_CI_RUN_MAX_MS + 1 }, "run_overdue"],
    ["run completed, a required check missing", { web: null, runs: [{ status: "completed", conclusion: "success" }], at: T0 + 20 * MIN }, "run_completed_checks_missing"],
    ["the only run cancelled, checks cancelled, no new attempt", { tests: { status: "completed", conclusion: "cancelled" },
      runs: [{ status: "completed", conclusion: "cancelled" }], at: T0 + 20 * MIN }, "run_cancelled"],
    ["the only run cancelled before a required check started", { web: null, runs: [{ status: "completed", conclusion: "cancelled" }], at: T0 + 20 * MIN }, "run_cancelled"],
  ];
  test.each(cases)("%s: main_ci_evidence_missing, paused, never green", (_name, o, why) => {
    const h = health(o);
    expect(h.ci).toMatchObject({ verdict: "evidence_missing", why });
    expect(plan(h)).toMatchObject({ reason: "main_ci_evidence_missing", actions: paused });
  });
  test("clock boundaries: 60 minutes exactly still waits, 15 minutes minus 1 ms still waits", () => {
    expect(health({ tests: PENDING, runs: [{ status: "in_progress", created: T0 }], at: T0 + MAIN_CI_RUN_MAX_MS }).ci?.verdict).toBe("pending");
    expect(health({ tests: null, web: null, runs: [], commit: T0, at: T0 + MAIN_CI_RUN_CREATE_MS - 1 }).ci?.verdict).toBe("pending");
  });
  test("a cancelled attempt rerun (attempt 2 running): waiting again", () => {
    expect(health({ tests: PENDING, runs: [{ status: "in_progress", attempt: 2, created: T0 }], at: T0 + 30 * MIN }).ci)
      .toMatchObject({ verdict: "pending", runs: [{ attempt: 2 }] });
  });
  test("commit time unreadable with no push run: a read failure, paused as before (main_unhealthy)", () => {
    const h = health({ tests: null, web: null, runs: [], commit: null, at: T0 + MIN });
    expect(h.ci).toMatchObject({ verdict: "unhealthy", why: "commit_time_unavailable" });
    expect(plan(h)).toMatchObject({ reason: "main_unhealthy", actions: paused });
  });
  test("non-push runs never count as the push run", () => {
    expect(health({ tests: PENDING, runs: [{ status: "in_progress", event: "pull_request" }], commit: T0, at: T0 + 16 * MIN }).ci)
      .toMatchObject({ verdict: "evidence_missing", why: "run_not_created", runs: [] });
  });
  test("malformed run rows: not waiting", () => {
    const main = { project: "p", repo: "example/repo", ref: "refs/heads/main", sha: MAIN };
    const h = evaluateMainCi(target, { before: main, after: main, observedAt: T0, checks: { ...main, total_count: 1, commit_status: { sha: MAIN, total_count: 0, statuses: [] },
      check_runs: [{ id: 1, name: "tests", head_sha: MAIN, status: "in_progress", conclusion: null }],
      push_runs: { runs: [{ ...pushRun({ status: "in_progress" }), run_attempt: 0 }], commit_time: iso(T0) } } });
    expect(h.ci).toMatchObject({ verdict: "unhealthy", why: "runs_unreadable" });
    expect(plan(h).actions).toEqual(paused);
  });
});

describe("[验收线 4] judgement kept per run id / attempt", () => {
  test("attempt 1 fails, the rerun passes: each observation carries its own attempt and verdict, the current one is the latest", () => {
    const first = health({ tests: { status: "completed", conclusion: "failure" }, runs: [{ id: 9, attempt: 1, status: "completed", conclusion: "failure" }], at: T0 + 20 * MIN });
    const rerun = health({ tests: PENDING, runs: [{ id: 9, attempt: 2, status: "in_progress" }], at: T0 + 25 * MIN });
    const second = health({ runs: [{ id: 9, attempt: 2, status: "completed", conclusion: "success" }], at: T0 + 40 * MIN });
    expect([first, rerun, second].map((h) => [plan(h).reason, plan(h).ci?.runs])).toEqual([
      ["main_unhealthy", [{ id: 9, attempt: 1, status: "completed", conclusion: "failure" }]],
      ["main_ci_pending", [{ id: 9, attempt: 2, status: "in_progress", conclusion: null }]],
      ["healthy", [{ id: 9, attempt: 2, status: "completed", conclusion: "success" }]],
    ]);
  });
  test("the observe evidence validator accepts exactly the agreed shape", () => {
    const ok = { rule: "run", newReason: "main_ci_pending", runs: [{ id: 9, attempt: 2, status: "in_progress", conclusion: null }] };
    expect(mainCiEvidence(JSON.stringify(ok))).toEqual(ok as never);
    for (const bad of ["{", "null", "[]", JSON.stringify({ ...ok, rule: "legacy" }), JSON.stringify({ ...ok, newReason: "nope" }),
      JSON.stringify({ ...ok, extra: 1 }), JSON.stringify({ ...ok, runs: [{ ...ok.runs[0], id: 0 }] }), JSON.stringify({ ...ok, runs: [{ ...ok.runs[0], attempt: 1.5 }] }),
      JSON.stringify({ ...ok, runs: [{ ...ok.runs[0], status: "done" }] }), JSON.stringify({ ...ok, runs: [{ ...ok.runs[0], conclusion: "ok" }] }),
      JSON.stringify({ ...ok, runs: Array.from({ length: 11 }, () => ok.runs[0]) }), JSON.stringify({ ...ok, pad: "x".repeat(2100) })]) {
      expect(mainCiEvidence(bad)).toBeNull();
    }
  });
});

describe("[验收线 5] modes and anomalies unchanged", () => {
  test("rule legacy (off / observe) is the original plan byte for byte, apart from the added evidence field", () => {
    for (const h of [health({ tests: PENDING, runs: [{ status: "in_progress" }], at: T0 + MIN }), health({ at: T0 + MIN, runs: [] }),
      health({ tests: { status: "completed", conclusion: "failure" }, runs: [], at: T0 + MIN })]) {
      const { ci, ...withRuns } = plan(h, "legacy");
      expect(ci?.rule).toBe("legacy");
      const { ci: _, ...without } = h;
      expect(withRuns).toEqual(plan(without, "legacy"));
      expect(plan(without, "legacy")).toEqual(planMainCi({ ...{ target, health: without, now: h.observedAt, maxAgeMs: 10 * MIN, currentMainSha: MAIN,
        readFailureSince: null, uncertainty: null, candidate: { project: "p", repo: "example/repo", taskId: "T1", head: "c".repeat(40) },
        projectPms: [], approvals: [], notificationClaims: [] } }));
    }
  });
  test("waiting never survives a changed SHA, a stale snapshot, a scope mismatch or a read failure", () => {
    const h = health({ tests: PENDING, runs: [{ status: "in_progress" }], at: T0 + MIN });
    expect(plan(h, "run", { currentMainSha: NEXT })).toMatchObject({ reason: "main_unhealthy", actions: paused });
    expect(plan(h, "run", { currentMainSha: null })).toMatchObject({ actions: paused });
    expect(plan(h, "run", { now: h.observedAt + 11 * MIN })).toMatchObject({ reason: "stale_health", actions: paused });
    expect(plan(h, "run", { target: { ...target, repo: "example/other" } })).toMatchObject({ reason: "scope_mismatch", actions: paused });
    const main = { project: "p", repo: "example/repo", ref: "refs/heads/main", sha: MAIN };
    const drift = evaluateMainCi(target, { before: main, after: { ...main, sha: NEXT }, observedAt: T0, checks: null });
    expect(drift.ci).toBeUndefined();
    expect(plan(drift).actions).toEqual(paused);
    const incomplete = health({ tests: PENDING, runs: [{ status: "in_progress" }], at: T0 + MIN });
    const broken = evaluateMainCi(target, { before: main, after: main, observedAt: T0 + MIN, checks: { ...main, total_count: 5, check_runs: [],
      commit_status: { sha: MAIN, total_count: 0, statuses: [] }, push_runs: { runs: [pushRun({ status: "in_progress" })], commit_time: iso(T0) } } });
    expect(incomplete.ci?.verdict).toBe("pending");
    expect(broken).toMatchObject({ state: "unknown", reasons: [{ code: "invalid_checks" }] });
    expect(broken.ci).toBeUndefined();
    expect(plan(broken).actions).toEqual(paused);
    const ambiguous = evaluateMainCi(target, { before: main, after: main, observedAt: T0 + MIN, checks: { ...main, total_count: 2, check_runs: [
      { id: 1, name: "tests", head_sha: MAIN, status: "in_progress", conclusion: null }, { id: 2, name: "tests", head_sha: MAIN, status: "in_progress", conclusion: null }],
      commit_status: { sha: MAIN, total_count: 1, statuses: [{ id: 3, context: "web", state: "pending" }] }, push_runs: { runs: [pushRun({ status: "in_progress" })], commit_time: iso(T0) } } });
    expect(ambiguous.ci).toMatchObject({ verdict: "unhealthy", why: "other_fault" });
    expect(plan(ambiguous).actions).toEqual(paused);
  });
});

describe("[验收线 3] round 2: green checks on a cancelled sole push run", () => {
  const OK = { status: "completed", conclusion: "success" };
  test("sole push run completed / cancelled, no new attempt, required checks success: evidence_missing under run, never green", () => {
    const h = health({ tests: OK, web: OK, runs: [{ status: "completed", conclusion: "cancelled" }], at: T0 + 20 * MIN });
    expect(h.state).toBe("green"); // the original health keeps its meaning
    expect(h.ci).toMatchObject({ verdict: "evidence_missing", why: "run_cancelled" });
    expect(plan(h)).toMatchObject({ reason: "main_ci_evidence_missing", actions: paused, faultKey: null, notification: null });
    expect(plan(h, "legacy")).toMatchObject({ reason: "healthy", actions: go }); // observe / off unchanged
  });
  test("a successful run next to it, or the run still going, stays green", () => {
    for (const runs of [[{ id: 7, status: "completed", conclusion: "cancelled" }, { id: 8, status: "completed", conclusion: "success" }],
      [{ status: "in_progress" }], [{ status: "completed", conclusion: "success" }], []]) {
      expect(plan(health({ tests: OK, web: OK, runs, at: T0 + 20 * MIN }))).toMatchObject({ reason: "healthy", actions: go });
    }
  });
  test("green checks with unreadable run evidence: not green under run", () => {
    const h = health({ tests: OK, web: OK, runs: [{ status: "bogus" }], at: T0 + 20 * MIN });
    expect(h.ci).toMatchObject({ verdict: "unhealthy", why: "runs_unreadable" });
    expect(plan(h)).toMatchObject({ actions: paused });
  });
});
