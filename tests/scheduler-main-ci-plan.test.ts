import { describe, expect, test } from "bun:test";
import { evaluateMainCi, readMainCi, type MainCiTarget } from "../src/lib/scheduler-main-ci.js";
import { mainCiFaultKey, planMainCi, type MainCiPlanInput, type MainCiPmApproval } from "../src/lib/scheduler-main-ci-plan.js";

const NOW = 1_000_000;
const MAIN = "a".repeat(40), NEXT = "b".repeat(40), TASK = "c".repeat(40);
const target: MainCiTarget = { project: "p", repo: "example/repo", requiredChecks: ["ci"] };
function input(conclusion: string | null = "failure", sha = MAIN): MainCiPlanInput {
  const main = { project: "p", repo: "example/repo", ref: "refs/heads/main", sha };
  const health = evaluateMainCi(target, { before: main, after: main, observedAt: NOW, checks: { ...main, total_count: 1, commit_status: { sha, total_count: 0, statuses: [] },
    check_runs: [{ id: 1, name: "ci", head_sha: sha, status: conclusion === null ? "queued" : "completed", conclusion }] } });
  return { target, health, now: NOW, maxAgeMs: 60_000, currentMainSha: sha, readFailureSince: null, candidate: { project: "p", repo: "example/repo", taskId: "T1", head: TASK },
    projectPms: ["pm-p"], approvals: [], notificationClaims: [] };
}
function approval(i: MainCiPlanInput): MainCiPmApproval {
  return { requestId: "pm-request-1", actor: "pm-p", binding: { ...i.candidate, kind: "main-ci-repair", mainSha: i.health.mainSha!,
    faultKey: mainCiFaultKey(i.health)! } };
}
const allPaused = { formTrain: "pause", updateBranch: "pause", rerun: "pause", merge: "pause", bounce: "pause" } as const;

describe("pure main CI pause overlay", () => {
  test.each(["failure", null])("red/unknown (%s) pauses ordinary effects and preserves ongoing work", (conclusion) => {
    const i = input(conclusion);
    const before = JSON.stringify(i);
    expect(planMainCi(i)).toMatchObject({ mode: "plan-only", reason: "main_unhealthy", actions: allPaused,
      continue: ["write", "independent-review"], preserve: ["reviews", "rounds", "resources", "unknown-side-effects"], cancelExistingCi: false, repair: null });
    expect(JSON.stringify(i)).toBe(before);
  });

  test("fresh green resumes through normal gates, without declaring queue/CI/reviews cleared", () => {
    const red = input();
    const first = planMainCi(red);
    const green = input("success", NEXT);
    green.notificationClaims = [first.notification!.key];
    expect(planMainCi(green)).toMatchObject({ reason: "healthy", repair: null, notification: null,
      actions: { formTrain: "normal-gates", updateBranch: "normal-gates", rerun: "normal-gates", merge: "normal-gates", bounce: "normal-gates" } });
    expect(mainCiFaultKey(green.health)).toBeNull();
    expect(planMainCi(input(null, NEXT)).actions).toEqual(allPaused);
  });

  test("wrong project/repo/policy observation cannot clear or notify another queue", () => {
    for (const mismatch of [{ project: "other" }, { repo: "other/repo" }, { requiredChecks: ["additional"] }]) {
      const i = input("success");
      i.target = { ...target, ...mismatch };
      expect(planMainCi(i)).toMatchObject({ reason: "scope_mismatch", actions: allPaused, repair: null, notification: null });
    }
    const i = input("success");
    i.candidate = { ...i.candidate, project: "other" };
    expect(planMainCi(i).reason).toBe("scope_mismatch");
    expect(planMainCi(input("success")).reason).toBe("healthy");
  });

  test("persisted red claim survives restart and conclusion changes; new heads get their own PM-only plan", () => {
    const i = input();
    const first = planMainCi(i).notification!;
    expect(first).toMatchObject({ recipient: "project-pm", project: "p", mainSha: MAIN, state: "red" });
    const persisted = JSON.parse(JSON.stringify([first.key]));
    expect(planMainCi({ ...input(), notificationClaims: persisted }).notification).toBeNull();
    expect(planMainCi({ ...input("failure", NEXT), notificationClaims: persisted }).notification?.key).not.toBe(first.key);
    expect(planMainCi({ ...input("cancelled"), notificationClaims: persisted }).notification).toBeNull();
    expect(planMainCi({ ...input(null), notificationClaims: persisted }).notification).toBeNull();
    expect(planMainCi(input("success")).notification).toBeNull();
  });

  test("dedup is order insensitive and scoped; no unknown SHA is invented for a read failure", () => {
    const i = input();
    i.health.reasons = [{ code: "missing_check", check: "web" }, { code: "pending_check", check: "ci" }];
    const key = mainCiFaultKey(i.health);
    i.health.reasons = [...i.health.reasons].reverse();
    expect(mainCiFaultKey(i.health)).toBe(key);
    i.health.target = { ...target, repo: "other/repo" };
    expect(mainCiFaultKey(i.health)).not.toBe(key);
    i.health.target = target;
    i.health.mainSha = null;
    i.health.state = "unknown";
    expect(planMainCi(i)).toMatchObject({ actions: allPaused, notification: null });
  });
});

describe("explicit PM repair binding is only a candidate for unchanged normal gates", () => {
  test("exact approval enables serial repair planning while ordinary trains and bounce remain paused", () => {
    const i = input();
    i.approvals = [approval(i)];
    expect(planMainCi(i)).toMatchObject({ reason: "pm_repair_candidate", actions: { formTrain: "pause", updateBranch: "normal-gates",
      rerun: "normal-gates", merge: "normal-gates", bounce: "pause" },
      repair: { requestId: "pm-request-1", taskId: "T1", head: TASK, requires: ["review", "ui", "ci", "authorization"] } });
    expect(planMainCi(input()).repair).toBeNull();
  });

  test("forged role/name prefix, owner or provider name is not an explicit project PM approval", () => {
    for (const actor of ["author", "PM-fix-main", "owner", "codex", "pm-p ", ""]) {
      const i = input();
      i.candidate.taskId = "MAINCI-repair-main";
      i.approvals = [{ ...approval(i), actor }];
      expect(planMainCi(i)).toMatchObject({ actions: allPaused, repair: null });
    }
    const i = input();
    i.candidate.taskId = "MAINCIW-fix-main";
    expect(planMainCi(i).repair).toBeNull();
  });

  test("approval binds task, task head, project, repo, current main and exact fault", () => {
    const mismatches = [{ taskId: "T2" }, { head: NEXT }, { project: "other" }, { repo: "other/repo" }, { mainSha: NEXT },
      { faultKey: "red" }, { kind: "fix" }, { head: TASK.slice(0, 8) }, { mainSha: MAIN.slice(0, 8) }];
    for (const mismatch of mismatches) {
      const i = input();
      const a = approval(i);
      i.approvals = [{ ...a, binding: { ...a.binding, ...mismatch } } as MainCiPmApproval];
      expect(planMainCi(i)).toMatchObject({ actions: allPaused, repair: null });
    }
    const i = input();
    i.approvals = [{ ...approval(i), requestId: "" }];
    expect(planMainCi(i).repair).toBeNull();
  });

  test("old approval expires when head/fault changes; pending alone never grants repair exception", () => {
    const a = approval(input());
    for (const i of [input("failure", NEXT), input("cancelled"), input(null)]) {
      i.approvals = [a];
      expect(planMainCi(i)).toMatchObject({ actions: allPaused, repair: null });
    }
    const unknown = input(null);
    unknown.approvals = [approval(unknown)];
    expect(planMainCi(unknown).repair).toBeNull();
    const changed = input();
    changed.approvals = [a];
    changed.candidate.head = NEXT;
    expect(planMainCi(changed).repair).toBeNull();
  });
});

function multiInput(rows: readonly { name: string; conclusion: string | null }[]): MainCiPlanInput {
  const i = input();
  i.target = { ...target, requiredChecks: ["a", "b"] };
  const main = { project: target.project, repo: target.repo, ref: "refs/heads/main", sha: MAIN };
  i.health = evaluateMainCi(i.target, { before: main, after: main, observedAt: NOW, checks: { ...main,
    total_count: rows.length, commit_status: { sha: MAIN, total_count: 0, statuses: [] },
    check_runs: rows.map((r, n) => ({ ...r, id: n + 1, head_sha: MAIN, status: r.conclusion === null ? "queued" : "completed" })) } });
  return i;
}

describe("repairable unknown evidence and transient uncertainty", () => {
  test.each([
    { label: "failure plus missing", rows: [{ name: "a", conclusion: "failure" }] },
    { label: "missing", rows: [{ name: "a", conclusion: "success" }] },
    { label: "all missing", rows: [] },
    { label: "ambiguous", rows: [{ name: "a", conclusion: "success" }, { name: "a", conclusion: "success" }, { name: "b", conclusion: "success" }] },
    { label: "failure plus pending", rows: [{ name: "a", conclusion: "failure" }, { name: "b", conclusion: null }] },
  ])("exact PM approval unblocks only a serial candidate for $label", ({ rows }) => {
    const i = multiInput(rows);
    expect(i.health.state).toBe("unknown");
    expect(planMainCi(i).actions).toEqual(allPaused);
    i.approvals = [approval(i)];
    expect(planMainCi(i)).toMatchObject({ reason: "pm_repair_candidate", actions: { ...allPaused,
      merge: "normal-gates", updateBranch: "normal-gates", rerun: "normal-gates" }, repair: { requires: ["review", "ui", "ci", "authorization"] } });
    i.approvals = [{ ...approval(i), actor: "author" }];
    expect(planMainCi(i).repair).toBeNull();
  });

  test("read error or main drift never gains an exception, even with an exact approval", async () => {
    for (const failRead of [true, false]) {
      const i = input();
      let n = 0;
      const main = { project: target.project, repo: target.repo, ref: "refs/heads/main", sha: MAIN };
      i.health = await readMainCi(target, {
        main: async () => ({ ...main, sha: n++ === 0 ? MAIN : NEXT }),
        checks: async () => {
          if (failRead) throw new Error("read failed");
          return { ...main, total_count: 0, check_runs: [], commit_status: { sha: MAIN, total_count: 0, statuses: [] } };
        },
      }, () => NOW);
      i.currentMainSha = i.health.mainSha;
      i.approvals = [approval(i)];
      expect(planMainCi(i)).toMatchObject({ actions: allPaused, repair: null, notification: null });
    }
  });

  test("fault-specific approval cannot follow an unknown changing checks or stale observations", () => {
    const i = multiInput([{ name: "a", conclusion: "failure" }]);
    const a = approval(i);
    const changed = multiInput([]);
    changed.approvals = [a];
    expect(planMainCi(changed).repair).toBeNull();
    for (const fields of [{ currentMainSha: NEXT }, { now: NOW + 60_001 }]) {
      expect(planMainCi({ ...i, ...fields, approvals: [a] })).toMatchObject({ actions: allPaused, repair: null });
    }
  });
});

describe("freshness and durable PM notification plans", () => {
  test("old green, unknown current head, future/invalid clocks and missing age never release a queue", () => {
    const i = input("success");
    for (const fields of [{ currentMainSha: NEXT }, { currentMainSha: null }, { currentMainSha: "short" },
      { now: NOW + 60_001 }, { now: NOW - 1 }, { now: NaN }, { maxAgeMs: Infinity }, { maxAgeMs: 0 },
      { health: { ...i.health, observedAt: undefined } }, { health: { ...i.health, observedAt: -1 } }]) {
      expect(planMainCi({ ...i, ...fields } as MainCiPlanInput)).toMatchObject({ reason: "stale_health", actions: allPaused, notification: null });
    }
    expect(planMainCi({ ...i, currentMainSha: MAIN.toUpperCase(), now: NOW + 60_000 }).reason).toBe("healthy");
  });

  test("queued progress and transient drift are silent; failure dedup ignores which job finished first", () => {
    for (const rows of [[{ name: "a", conclusion: null }, { name: "b", conclusion: null }],
      [{ name: "a", conclusion: "success" }, { name: "b", conclusion: null }]]) {
      expect(planMainCi(multiInput(rows)).notification).toBeNull();
    }
    const first = planMainCi(multiInput([{ name: "a", conclusion: "cancelled" }, { name: "b", conclusion: "failure" }])).notification!;
    const later = multiInput([{ name: "a", conclusion: "success" }, { name: "b", conclusion: "failure" }]);
    later.notificationClaims = JSON.parse(JSON.stringify([first.key]));
    expect(planMainCi(later).notification).toBeNull();
    expect(mainCiFaultKey(later.health)).not.toBe(first.key);
  });

  test("sustained main-before read failure alerts PM without SHA, with persisted hourly claims and recovery", async () => {
    const i = input();
    const port = { main: async () => { throw new Error("private error"); }, checks: async () => null };
    i.readFailureSince = NOW;
    i.currentMainSha = null;
    const observeAt = async (now: number) => {
      i.now = now;
      i.health = await readMainCi(target, port, () => now);
      return planMainCi(i);
    };
    expect((await observeAt(NOW + 15 * 60_000 - 1)).notification).toBeNull();
    const first = (await observeAt(NOW + 15 * 60_000)).notification!;
    expect(first).toMatchObject({ kind: "read_unavailable", recipient: "project-pm", state: "unknown", mainSha: null });
    expect(first.key).not.toContain("private error");
    i.notificationClaims = JSON.parse(JSON.stringify([first.key]));
    expect((await observeAt(NOW + 75 * 60_000 - 1)).notification).toBeNull();
    expect((await observeAt(NOW + 75 * 60_000)).notification?.key).not.toBe(first.key);
    i.readFailureSince = null;
    expect(planMainCi(i).notification).toBeNull();
    expect(planMainCi({ ...input("success"), notificationClaims: i.notificationClaims }).reason).toBe("healthy");
  });

  test("outage metadata cannot notify wrong scope, stale evidence or ordinary pending", async () => {
    const i = input();
    i.health = await readMainCi(target, { main: async () => { throw new Error("offline"); }, checks: async () => null }, () => NOW);
    for (const since of [null, -1, NaN, Infinity, NOW + 1]) {
      expect(planMainCi({ ...i, readFailureSince: since }).notification).toBeNull();
    }
    i.readFailureSince = 0;
    expect(planMainCi(i).notification?.kind).toBe("read_unavailable");
    expect(planMainCi({ ...i, target: { ...target, project: "other" } }).notification).toBeNull();
    expect(planMainCi({ ...i, now: NOW + 60_001 }).notification).toBeNull();
    expect(planMainCi({ ...input(null), readFailureSince: 0 }).notification).toBeNull();
  });
});
