import { describe, expect, test } from "bun:test";
import { evaluateMainCi, type MainCiTarget } from "../src/lib/scheduler-main-ci.js";
import { mainCiFaultKey, planMainCi, type MainCiPlanInput, type MainCiPmApproval } from "../src/lib/scheduler-main-ci-plan.js";

const MAIN = "a".repeat(40), NEXT = "b".repeat(40), TASK = "c".repeat(40);
const target: MainCiTarget = { project: "p", repo: "example/repo", requiredChecks: ["ci"] };
function input(conclusion: string | null = "failure", sha = MAIN): MainCiPlanInput {
  const main = { project: "p", repo: "example/repo", ref: "refs/heads/main", sha };
  const health = evaluateMainCi(target, { before: main, after: main, checks: { ...main, total_count: 1,
    check_runs: [{ id: 1, name: "ci", head_sha: sha, status: conclusion === null ? "queued" : "completed", conclusion }] } });
  return { target, health, candidate: { project: "p", repo: "example/repo", taskId: "T1", head: TASK },
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

  test("persisted notification claim survives restart; head/fault changes get their own PM-only plan", () => {
    const i = input();
    const first = planMainCi(i).notification!;
    expect(first).toMatchObject({ recipient: "project-pm", project: "p", mainSha: MAIN, state: "red" });
    const persisted = JSON.parse(JSON.stringify([first.key]));
    expect(planMainCi({ ...input(), notificationClaims: persisted }).notification).toBeNull();
    expect(planMainCi({ ...input("failure", NEXT), notificationClaims: persisted }).notification?.key).not.toBe(first.key);
    expect(planMainCi({ ...input("cancelled"), notificationClaims: persisted }).notification?.key).not.toBe(first.key);
    expect(planMainCi({ ...input(null), notificationClaims: persisted }).notification?.key).not.toBe(first.key);
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

  test("old approval expires when head/fault changes; uncertainty never grants repair exception", () => {
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
