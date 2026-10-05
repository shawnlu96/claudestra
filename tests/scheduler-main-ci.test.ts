import { describe, expect, test } from "bun:test";
import { evaluateMainCi, readMainCi, type MainCiReadPort, type MainCiTarget } from "../src/lib/scheduler-main-ci.js";

const OLD = "a".repeat(40), HEAD = "b".repeat(40), NEW = "c".repeat(40);
const target: MainCiTarget = { project: "p", repo: "example/repo", requiredChecks: ["tests", "web", "desktop"] };
const main = (sha = HEAD) => ({ project: target.project, repo: target.repo, ref: "refs/heads/main", sha });
const run = (name: string, id: number, head_sha = HEAD) => ({ id, name, head_sha, status: "completed", conclusion: "success" as string | null });
const checks = (sha = HEAD) => ({ project: target.project, repo: target.repo, sha, total_count: 3,
  check_runs: target.requiredChecks.map((name, i) => run(name, i + 1, sha)) });
const evaluate = (batch: unknown = checks(), before: unknown = main(), after: unknown = main(), policy = target) =>
  evaluateMainCi(policy, { before, after, checks: batch });

describe("exact main CI health from synthetic GitHub check-runs", () => {
  test("requires complete, successful checks at both reads of the same full main commit", () => {
    expect(evaluate()).toMatchObject({ state: "green", mainSha: HEAD, reasons: [{ code: "healthy" }],
      checks: target.requiredChecks.map((name) => ({ name, bucket: "pass" })) });
    expect(evaluate(checks(HEAD), main(HEAD.toUpperCase()), main())).toMatchObject({ state: "green", mainSha: HEAD });
    expect(evaluate({ ...checks(), repo: "Example/Repo" })).toMatchObject({ state: "green" });
  });

  test("old red cannot poison new green, and old green cannot clear new main", () => {
    const red = checks(OLD);
    red.check_runs[0]!.conclusion = "failure";
    expect(evaluate(red, main(OLD), main(OLD)).state).toBe("red");
    expect(evaluate().state).toBe("green");
    expect(evaluate(checks(OLD)).reasons).toEqual([{ code: "stale_checks" }]);
    const staleRow = checks();
    staleRow.check_runs[2]!.head_sha = OLD;
    expect(evaluate(staleRow).state).toBe("unknown");
  });

  test.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "startup_failure"])(
    "completed/%s is never successful", (conclusion) => {
      const batch = checks();
      batch.check_runs[1]!.conclusion = conclusion;
      expect(evaluate(batch)).toMatchObject({ state: "red", reasons: [{ code: "unsuccessful_check", check: "web", conclusion }] });
    });

  test.each(["queued", "in_progress", "waiting", "pending", "requested"])("%s is unknown, not healthy", (status) => {
    const batch = checks();
    Object.assign(batch.check_runs[0]!, { status, conclusion: null });
    expect(evaluate(batch)).toMatchObject({ state: "unknown", reasons: [{ code: "pending_check", check: "tests" }] });
  });

  test("missing check, truncated pagination and duplicate required names cannot reuse partial greens", () => {
    const partial = checks();
    partial.check_runs.pop();
    expect(evaluate(partial).reasons).toEqual([{ code: "invalid_checks" }]);
    partial.total_count = 2;
    expect(evaluate(partial).reasons).toEqual([{ code: "missing_check", check: "desktop" }]);
    const duplicate = checks();
    duplicate.check_runs.push(run("web", 4));
    duplicate.total_count++;
    expect(evaluate(duplicate).reasons).toEqual([{ code: "ambiguous_check", check: "web" }]);
    expect(evaluate({ ...checks(), total_count: 0, check_runs: [] }).state).toBe("unknown");
  });

  test("required list comes from policy; no second built-in job list", () => {
    const policy = { ...target, requiredChecks: ["custom check", "custom check"] };
    expect(evaluate({ ...checks(), total_count: 1, check_runs: [run("custom check", 1)] }, main(), main(), policy).state).toBe("green");
    expect(evaluate(checks(), main(), main(), policy).state).toBe("unknown");
    expect(evaluate(checks(), main(), main(), { ...target, requiredChecks: [] }).reasons).toEqual([{ code: "invalid_target" }]);
  });

  test("repo/project/ref scope and malformed SHA are rejected before green", () => {
    for (const raw of [null, {}, { ...main(), sha: HEAD.slice(0, 7) }, { ...main(), sha: 123 }, { ...main(), ref: "refs/heads/other" }]) {
      expect(evaluate(checks(), raw).reasons).toEqual([{ code: "invalid_main" }]);
    }
    for (const mismatch of [{ repo: "other/repo" }, { project: "other" }, { repo: null }]) {
      expect(evaluate(checks(), { ...main(), ...mismatch }).reasons).toEqual([{ code: "scope_mismatch" }]);
      expect(evaluate({ ...checks(), ...mismatch }).reasons).toEqual([{ code: "scope_mismatch" }]);
    }
    expect(evaluate(checks(), main(), main(NEW))).toMatchObject({ state: "unknown", mainSha: NEW, reasons: [{ code: "main_changed" }] });
  });

  test("malformed external fields cannot masquerade as pass", () => {
    const invalidRows = [null, { id: 1 }, { ...run("tests", 1), id: 0 }, { ...run("tests", 1), id: "1" },
      { ...run("tests", 1), name: 1 }, { ...run("tests", 1), name: " " }, { ...run("tests", 1), status: "pass" },
      { ...run("tests", 1), status: "queued" }, { ...run("tests", 1), conclusion: "SUCCESS" }, { ...run("tests", 1), conclusion: null },
      { ...run("tests", 1), head_sha: null }, { ...run("tests", 1), head_sha: HEAD.slice(0, 12) }];
    for (const row of invalidRows) {
      expect(evaluate({ ...checks(), check_runs: [row, ...checks().check_runs.slice(1)] }).state).toBe("unknown");
    }
    for (const fields of [{ total_count: "3" }, { total_count: -1 }, { total_count: 3.5 }, { check_runs: {} }, { sha: null }]) {
      expect(evaluate({ ...checks(), ...fields }).state).toBe("unknown");
    }
    const sameId = checks();
    sameId.check_runs[2]!.id = 1;
    expect(evaluate(sameId).state).toBe("unknown");
  });

  test("input snapshot is not mutated", () => {
    const snapshot = { before: main(), after: main(), checks: checks() };
    const original = JSON.stringify(snapshot);
    evaluateMainCi(target, snapshot);
    expect(JSON.stringify(snapshot)).toBe(original);
  });
});

describe("injected read port has no live default", () => {
  test("pins the check read and detects main changing during the query", async () => {
    const calls: unknown[] = [];
    let read = 0;
    const port: MainCiReadPort = {
      main: async (t) => { calls.push(["main", t]); return main(read++ === 0 ? HEAD : NEW); },
      checks: async (t, sha) => { calls.push(["checks", t, sha]); return checks(sha); },
    };
    expect(await readMainCi(target, port)).toMatchObject({ state: "unknown", mainSha: NEW, reasons: [{ code: "main_changed" }] });
    expect(calls).toEqual([["main", target], ["checks", target, HEAD], ["main", target]]);
  });

  test.each(["main_before", "checks", "main_after"] as const)("%s read rejection becomes structured unknown", async (phase) => {
    let reads = 0;
    const port: MainCiReadPort = {
      main: async () => {
        if (phase === (reads++ === 0 ? "main_before" : "main_after")) throw new Error("private GH stderr");
        return main();
      },
      checks: async () => { if (phase === "checks") throw new Error("request failed"); return checks(); },
    };
    const result = await readMainCi(target, port);
    expect(result).toMatchObject({ state: "unknown", reasons: [{ code: "read_error", phase }] });
    expect(JSON.stringify(result)).not.toContain("private GH stderr");
  });

  test("invalid first main / policy stops before checks; no empty-list success", async () => {
    let called = 0;
    const port: MainCiReadPort = { main: async () => main("short"), checks: async () => { called++; return checks(); } };
    expect((await readMainCi(target, port)).state).toBe("unknown");
    expect(called).toBe(0);
    expect((await readMainCi({ ...target, requiredChecks: [] }, port)).reasons).toEqual([{ code: "invalid_target" }]);
  });

  test("invalid policy fields return unknown even when runtime input violates the declared type", async () => {
    const port: MainCiReadPort = { main: async () => { throw new Error("must not read"); }, checks: async () => checks() };
    for (const bad of [null, {}, { ...target, repo: 123 }, { ...target, requiredChecks: null }, { ...target, requiredChecks: "ci" }]) {
      const policy = bad as unknown as MainCiTarget;
      expect(evaluateMainCi(policy, { before: main(), after: main(), checks: checks() }).reasons).toEqual([{ code: "invalid_target" }]);
      expect((await readMainCi(policy, port)).reasons).toEqual([{ code: "invalid_target" }]);
    }
  });

  test("config changes while awaiting do not silently weaken this observation", async () => {
    const policy = { ...target, requiredChecks: [...target.requiredChecks] };
    const port: MainCiReadPort = { main: async () => main(), checks: async () => {
      policy.requiredChecks.pop();
      return { ...checks(), total_count: 2, check_runs: checks().check_runs.slice(0, 2) };
    } };
    expect(await readMainCi(policy, port)).toMatchObject({ state: "unknown", reasons: [{ code: "missing_check", check: "desktop" }] });
  });
});
