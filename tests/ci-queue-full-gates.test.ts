import { expect, test } from "bun:test";
import { driveMerge, green, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { ciRed } from "../src/lib/scheduler-merge-ci-carried.js";
import { borrowerReady, holderWaits } from "../src/lib/scheduler-merge-pipe-judge.js";
import { preflight } from "../scripts/pm-merge-preflight.js";
import { collectMergeCi } from "../src/lib/ledger-audit-merge-ready.js";
import type { AuditSnapshot } from "../src/lib/ledger-audit.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";

const H = "a".repeat(40), M = "b".repeat(40), PR = "https://github.com/o/r/pull/1";
const names = ["typecheck + test + guard", "web typecheck + lint", "desktop typecheck + cargo test"];
const checks: PrSnapshot["checks"] = [...names, "ci scope light"].map((name) => ({ name, bucket: "pass" }));
const base: MergeRun = { intentId: "i", taskId: "T", project: "p", prRef: PR, reviewedHead: H, expectedBranch: "task/T",
  requiredChecks: names.join(","), phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
const pr: PrSnapshot = { state: "OPEN", head: H, branch: "task/T", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks };

test("light-only is never green; full success clears it but a failed required check still refuses", () => {
  expect(green(base, checks)).toBe(false);
  const full = [...checks, { name: "ci scope full", bucket: "pass" as const }];
  expect(green(base, full)).toBe(true);
  const red = [...full, { name: names[0]!, bucket: "fail" as const }];
  expect(green(base, red)).toBe(false);
  expect(ciRed(base, red)).toBe("required");
});

test("direct ready and await_ci wait without merging light-only", async () => {
  for (const phase of ["ready", "await_ci"] as const) {
    let row = { ...base, phase } as MergeRun, merges = 0;
    const io: MergeExternal = { inspect: async () => pr, direct: () => true, freshness: async () => ({ behindBy: 0, mainHead: M }),
      carryReview: async () => ({ ok: false, reason: "no" }), updateBranch: async () => {}, merge: async () => { merges++; return M; } };
    const result = await driveMerge(row, io, async (_, to, rev, reason) => row = { ...row, phase: to, rev: rev + 1, reason: reason ?? null });
    expect(result.phase).toBe("await_ci");
    expect(merges).toBe(0);
  }
});

test("light borrower refuses while full rerun holder still lends", () => {
  expect(borrowerReady({ headSHA: H, branch: "task/T" }, names.join(","), pr)).toContain("CI 未全绿");
  expect(holderWaits(base, { ...pr, checks: checks.map((c) => ({ ...c, bucket: "pending" })) })).toBeNull();
});

const gh = (full = false): Run => async (argv) => {
  let value: unknown;
  if (argv[1] === "pr") value = { state: "OPEN", headRefOid: H, baseRefName: "main", isDraft: false, isCrossRepository: false };
  else if (argv[2]?.includes("git/ref")) value = { object: { sha: M } };
  else {
    const runs = [...names, "ci scope light", ...(full ? ["ci scope full"] : [])].map((name, i) =>
      ({ id: i + 1, name, head_sha: H, status: "completed", conclusion: "success" }));
    value = { total_count: runs.length, check_runs: runs };
  }
  return { code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false };
};

test("preflight reads optional scope markers: light-only waits, full passes, absent markers remain compatible", async () => {
  const input = { pr: PR, expectedHead: H, actualMain: M, checks: names };
  expect(await preflight(input, gh())).toMatchObject({ ok: false, exit: 3, reason: expect.stringContaining("只有轻量") });
  expect(await preflight(input, gh(true))).toMatchObject({ ok: true });
});

test("audit never calls light-only current-head checks green", async () => {
  const card = { task: { id: "T", project: "p", itemId: null, title: "T", kind: "code", stage: "merge", stageBefore: null,
    round: 1, headSHA: H, pr: PR, agent: null, pm: null, branch: "task/T", spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: null, assignee: null }, events: [
    { seq: 1, ts: 1, actor: "rv", project: "p", target: "T", kind: "review", text: "", dedupKey: null,
      data: { round: 1, head: H, verdict: "pass", reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
        findings: [], p0: 0, p1: 0, p2: 0 } },
  ] } as AuditSnapshot["tasks"][number];
  expect((await collectMergeCi("p", [card], 100, { run: gh(), checksOf: () => names }))?.T)
    .toMatchObject({ state: "pending", missing: ["ci scope full"] });
  expect((await collectMergeCi("p", [card], 100, { run: gh(true), checksOf: () => names }))?.T).toMatchObject({ state: "green", missing: [] });
});
