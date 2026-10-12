/**
 * merge-arch-CIPROOF1: the CI coverage proof (lib/ci-proof.ts + lib/ci-proof-manifest.ts). Each wrong binding is first shown
 * passing today's name / bucket check (the red side), then rejected by the proof; related never authorises; full rejects a
 * missing test, a missing required check, a skipped or cancelled job; observe keeps the prior verdict; unknown fields never
 * yield a full proof; train fields bind members, combined tree and baseline.
 */
import { describe, expect, test } from "bun:test";
import {
  type CiProofExpect, type CiRunEvidence, ciCoverageGateMode, judgeCiCoverage, verifyCiProof,
} from "../src/lib/ci-proof.js";
import { CI_PROOF_MANIFEST_VERSION, ciProofManifestDigest, parseCiProofManifest } from "../src/lib/ci-proof-manifest.js";

const sha = (c: string) => c.repeat(40);
const dig = (c: string) => `sha256:${c.repeat(64)}`;
const REQUIRED = ["check", "test shard 1"];

const EXPECT: CiProofExpect = {
  repo: "shawnlu96/claudestra", head: sha("1"), base: sha("2"), checkout: { sha: sha("3"), tree: sha("4") },
  workflow: { path: ".github/workflows/ci.yml", sha: sha("5") }, policyVersion: "merge-policy-1",
  toolchain: { bun: "1.3.14", lockfileDigest: dig("6") }, testsUniverseDigest: dig("7"), requiredChecks: REQUIRED,
};

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CI_PROOF_MANIFEST_VERSION, repo: EXPECT.repo, head: EXPECT.head, base: EXPECT.base,
    checkout: { ...EXPECT.checkout }, workflow: { ...EXPECT.workflow }, policyVersion: EXPECT.policyVersion,
    toolchain: { ...EXPECT.toolchain }, tests: { universeDigest: dig("7"), selectedDigest: dig("7"), count: 3000 },
    scope: "full", checks: [...REQUIRED], ...over,
  };
}

/** A run whose artifact digest matches its content, unless the content does not parse (then a fixed digest). */
function run(over: Partial<CiRunEvidence> = {}, content: unknown = manifest()): CiRunEvidence {
  const parsed = parseCiProofManifest(content);
  const digest = parsed.ok ? ciProofManifestDigest(parsed.manifest) : dig("0");
  const jobs = REQUIRED.map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("4") }));
  return {
    origin: "actions-api", repo: EXPECT.repo, runId: 900, attempt: 2, latestAttempt: 2, workflow: { ...EXPECT.workflow },
    headSha: sha("1"), status: "completed", conclusion: "success", jobs,
    artifact: { runId: 900, attempt: 2, digest, content }, ...over,
  };
}

/** Today's gate (scheduler-merge-driver green()): every required name has a check in bucket pass, nothing failed/pending. */
const nameBucketGreen = (ev: CiRunEvidence) => {
  const checks = ev.jobs.map((j) => ({ name: j.name, bucket: j.conclusion === "success" ? "pass" : j.conclusion === "skipped" ? "skipping" : "fail" }));
  return REQUIRED.every((n) => checks.some((c) => c.name === n && c.bucket === "pass")) && checks.every((c) => c.bucket !== "fail");
};

describe("[验收线 1] same-name green checks bound to the wrong subject are rejected", () => {
  test("baseline: a correctly bound full run authorises the merge", () => {
    const r = verifyCiProof(EXPECT, run());
    expect(r).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true, reasons: [] });
  });

  test("same-name matrix jobs and extra shards all on the right tree, and SHA / repo case, still authorise", () => {
    const extra = ["check", "test shard 2"].map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("4") }));
    const upper = manifest({ repo: EXPECT.repo.toUpperCase(), checkout: { sha: sha("3").toUpperCase(), tree: sha("4") } });
    expect(verifyCiProof(EXPECT, run({ jobs: [...run().jobs, ...extra] }, upper))).toMatchObject({ ok: true, mergeAuthorized: true, reasons: [] });
  });

  test("pull_request run: API head_sha is the PR head while jobs check out the merge commit, and that authorises", () => {
    const r = verifyCiProof(EXPECT, run({ headSha: EXPECT.head }));
    expect(r).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true, reasons: [] });
  });

  test("train run: runHead names the combined commit the run was triggered on", () => {
    const x = { ...EXPECT, runHead: sha("3") };
    expect(verifyCiProof(x, run({ headSha: sha("3") }))).toMatchObject({ mergeAuthorized: true, reasons: [] });
    expect(verifyCiProof(x, run({ headSha: EXPECT.head })).reasons.join()).toMatch(/run head/);
  });

  const cases: [string, CiRunEvidence, RegExp][] = [
    ["wrong repo (run)", run({ repo: "evil/claudestra" }), /run 仓库/],
    ["wrong repo (manifest)", run({}, manifest({ repo: "evil/claudestra" })), /manifest repo/],
    ["wrong tree (job checkout)", run({ jobs: REQUIRED.map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("9") })) }), /实际检出 tree/],
    ["wrong tree (manifest)", run({}, manifest({ checkout: { sha: sha("3"), tree: sha("9") } })), /checkout.tree/],
    ["wrong base", run({}, manifest({ base: sha("9") })), /manifest base/],
    ["wrong head", run({}, manifest({ head: sha("9") })), /manifest head/],
    ["wrong workflow version", run({ workflow: { path: EXPECT.workflow.path, sha: sha("9") } }, manifest({ workflow: { path: EXPECT.workflow.path, sha: sha("9") } })), /批准版本/],
    ["wrong workflow file", run({}, manifest({ workflow: { path: ".github/workflows/other.yml", sha: sha("5") } })), /workflow.path/],
    ["wrong toolchain", run({}, manifest({ toolchain: { bun: "1.2.0", lockfileDigest: dig("6") } })), /toolchain.bun/],
    ["wrong lockfile", run({}, manifest({ toolchain: { bun: "1.3.14", lockfileDigest: dig("9") } })), /lockfileDigest/],
    ["wrong policy version", run({}, manifest({ policyVersion: "merge-policy-0" })), /policyVersion/],
    ["wrong test universe", run({}, manifest({ tests: { universeDigest: dig("9"), selectedDigest: dig("9"), count: 1 } })), /universeDigest/],
    ["artifact from another run", run({ artifact: { runId: 899, attempt: 2, digest: dig("0"), content: manifest() } }), /工件来自/],
    ["artifact digest mismatch", run({ artifact: { runId: 900, attempt: 2, digest: dig("a"), content: manifest() } }), /digest/],
    ["no artifact", run({ artifact: null }), /没有证明工件/],
    ["stale attempt", run({ attempt: 1, latestAttempt: 2, artifact: { runId: 900, attempt: 1, digest: dig("0"), content: manifest() } }), /不是最新/],
    ["required job from an older attempt",
      run({ jobs: REQUIRED.map((name, i) => ({ name, attempt: i ? 1 : 2, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("4") })) }),
      /来自 attempt 1/],
    ["checkout not read", run({ jobs: REQUIRED.map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: null, checkoutTree: null })) }), /实际检出未知/],
    ["run on another commit", run({ headSha: sha("9") }), /run head/],
    ["second same-name required job on the wrong tree",
      run({ jobs: [...run().jobs, { name: "check", attempt: 2, conclusion: "success", checkoutSha: sha("9"), checkoutTree: sha("9") }] }),
      /job #3 check 实际检出 tree 不符/],
    ["extra test shard on the wrong tree",
      run({ jobs: [...run().jobs, { name: "test shard 2", attempt: 2, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("9") }] }),
      /test shard 2 实际检出 tree 不符/],
    ["extra test shard with unknown checkout",
      run({ jobs: [...run().jobs, { name: "test shard 2", attempt: 2, conclusion: "success", checkoutSha: null, checkoutTree: null }] }),
      /test shard 2 实际检出未知/],
    ["manifest workflow path differs only in case",
      run({}, manifest({ workflow: { path: ".github/workflows/CI.yml", sha: sha("5") } })), /manifest workflow.path/],
    ["manifest policy version differs only in case", run({}, manifest({ policyVersion: "Merge-Policy-1" })), /manifest policyVersion/],
  ];
  for (const [name, ev, why] of cases) {
    test(`${name}: name/bucket says green, proof refuses`, () => {
      expect(nameBucketGreen(ev)).toBe(true); // red: today's predicate cannot tell this run from the right one
      const r = verifyCiProof(EXPECT, ev);
      expect(r.mergeAuthorized).toBe(false);
      expect(r.reasons.join("；")).toMatch(why);
    });
  }

  test("an author-submitted JSON or a bare same-name check is not proof, whatever it says", () => {
    for (const origin of ["author-json", "check-run"] as const) {
      const ev = run({ origin });
      expect(nameBucketGreen(ev)).toBe(true);
      expect(verifyCiProof(EXPECT, ev)).toMatchObject({ ok: false, mergeAuthorized: false, reasons: [expect.stringContaining("不受信")] });
    }
  });

  test("no evidence at all is no proof", () => {
    expect(verifyCiProof(EXPECT, null)).toMatchObject({ ok: false, reasons: ["没有证明"] });
  });
});

describe("[验收线 2] related never authorises; full must cover everything", () => {
  test("related with every check green still does not authorise a merge", () => {
    const r = verifyCiProof(EXPECT, run({}, manifest({ scope: "related", tests: { universeDigest: dig("7"), selectedDigest: dig("8"), count: 40 } })));
    expect(r).toMatchObject({ ok: true, scope: "related", mergeAuthorized: false });
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: run({}, manifest({ scope: "related" })) }).allow).toBe(false);
  });

  test("full that selected fewer tests than the universe is refused", () => {
    const r = verifyCiProof(EXPECT, run({}, manifest({ tests: { universeDigest: dig("7"), selectedDigest: dig("8"), count: 40 } })));
    expect(r).toMatchObject({ scope: "full", mergeAuthorized: false });
    expect(r.reasons.join()).toMatch(/漏测试/);
  });

  test("full whose manifest misses a required check is refused", () => {
    const r = verifyCiProof(EXPECT, run({}, manifest({ checks: ["check"] })));
    expect(r.mergeAuthorized).toBe(false);
    expect(r.reasons.join()).toMatch(/漏必需检查 test shard 1/);
  });

  test("full whose run lacks a required job is refused", () => {
    const r = verifyCiProof(EXPECT, run({ jobs: run().jobs.slice(0, 1) }));
    expect(r.mergeAuthorized).toBe(false);
    expect(r.reasons.join()).toMatch(/test shard 1 不在 run 里/);
  });

  for (const conclusion of ["skipped", "cancelled", "failure", "neutral", null]) {
    test(`full with a job concluded ${String(conclusion)} is refused`, () => {
      const jobs = [...run().jobs, { name: "test shard 2", attempt: 2, conclusion, checkoutSha: sha("3"), checkoutTree: sha("4") }];
      const r = verifyCiProof(EXPECT, run({ jobs }));
      expect(r.mergeAuthorized).toBe(false);
      expect(r.reasons.join()).toMatch(/job test shard 2 结论/);
    });
  }

  test("full on a cancelled or unfinished run is refused", () => {
    expect(verifyCiProof(EXPECT, run({ conclusion: "cancelled" })).mergeAuthorized).toBe(false);
    expect(verifyCiProof(EXPECT, run({ status: "in_progress", conclusion: null })).mergeAuthorized).toBe(false);
  });
});

describe("[验收线 3] observe keeps the prior verdict; unknown fields give no full proof", () => {
  const bad = run({ repo: "evil/claudestra" });
  test("observe returns the prior verdict plus would-deny reasons; on denies; off reads nothing", () => {
    for (const prior of [true, false]) {
      const o = judgeCiCoverage({ mode: "observe", prior, expect: EXPECT, evidence: bad });
      expect(o.allow).toBe(prior);
      expect(o.reasons.join()).toMatch(/run 仓库/);
    }
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: bad })).toMatchObject({ allow: false });
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: null })).toMatchObject({ allow: false, reasons: ["没有证明"] });
    expect(judgeCiCoverage({ mode: "off", prior: true, expect: EXPECT, evidence: bad })).toEqual({ mode: "off", allow: true, reasons: [], proof: null });
  });

  test("a good proof under observe or on keeps the prior verdict with no reasons", () => {
    for (const mode of ["observe", "on"] as const) {
      expect(judgeCiCoverage({ mode, prior: true, expect: EXPECT, evidence: run() })).toMatchObject({ allow: true, reasons: [] });
    }
  });

  test("ciCoverageGate defaults to observe; anything not off/observe/on reads observe", () => {
    expect(ciCoverageGateMode(undefined)).toBe("observe");
    expect(ciCoverageGateMode("ON")).toBe("observe");
    expect(ciCoverageGateMode(1)).toBe("observe");
    for (const m of ["off", "observe", "on"] as const) expect(ciCoverageGateMode(m)).toBe(m);
  });

  test("an unknown top-level or nested field, a wrong version or an unknown scope never yields a full proof", () => {
    const variants = [
      manifest({ skipTests: true }),
      manifest({ tests: { universeDigest: dig("7"), selectedDigest: dig("7"), count: 3000, filter: "*" } }),
      manifest({ checkout: { sha: sha("3"), tree: sha("4"), dirty: true } }),
      manifest({ version: 2 }),
      manifest({ scope: "fullish" }),
      manifest({ toolchain: { bun: "1.3.14" } }),
      manifest({ train: { members: [{ pr: 1, head: sha("1"), note: "x" }], combinedTree: sha("4"), baseline: sha("2") } }),
      "not json object",
    ];
    for (const content of variants) {
      const r = verifyCiProof(EXPECT, run({}, content));
      expect(r).toMatchObject({ ok: false, scope: null, mergeAuthorized: false });
      expect(r.reasons.join()).toMatch(/^manifest /);
    }
  });

  test("the digest ignores key order", () => {
    const a = parseCiProofManifest(manifest()), b = parseCiProofManifest(Object.fromEntries(Object.entries(manifest()).reverse()));
    expect(a.ok && b.ok && ciProofManifestDigest(a.manifest) === ciProofManifestDigest(b.manifest)).toBe(true);
  });
});

describe("[验收线 4] one pure verdict that only narrows, train fields bound", () => {
  const TRAIN = { members: [{ pr: 11, head: sha("a") }, { pr: 12, head: sha("b") }], combinedTree: sha("4"), baseline: sha("2") };
  const TRAIN_EXPECT: CiProofExpect = { ...EXPECT, train: TRAIN };

  test("a prior deny is never turned into an allow, in any mode", () => {
    for (const mode of ["off", "observe", "on"] as const) expect(judgeCiCoverage({ mode, prior: false, expect: EXPECT, evidence: run() }).allow).toBe(false);
  });

  test("the verdict is pure: same inputs, same answer, inputs untouched", () => {
    const ev = run(), before = JSON.stringify(ev);
    const a = judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: ev });
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: ev })).toEqual(a);
    expect(JSON.stringify(ev)).toBe(before);
  });

  test("a train proof binding the current members, combined tree and baseline authorises", () => {
    expect(verifyCiProof(TRAIN_EXPECT, run({}, manifest({ train: TRAIN }))).mergeAuthorized).toBe(true);
  });

  const trainCases: [string, unknown, RegExp][] = [
    ["missing train binding", undefined, /缺列车绑定/],
    ["a member dropped", { ...TRAIN, members: TRAIN.members.slice(0, 1) }, /成员或 head/],
    ["a member at another head", { ...TRAIN, members: [TRAIN.members[0], { pr: 12, head: sha("c") }] }, /成员或 head/],
    ["members reordered", { ...TRAIN, members: [...TRAIN.members].reverse() }, /成员或 head/],
    ["another combined tree", { ...TRAIN, combinedTree: sha("9") }, /组合 tree/],
    ["another baseline", { ...TRAIN, baseline: sha("9") }, /基线/],
  ];
  for (const [name, train, why] of trainCases) {
    test(`train: ${name} is refused`, () => {
      const r = verifyCiProof(TRAIN_EXPECT, run({}, manifest(train === undefined ? {} : { train })));
      expect(r.mergeAuthorized).toBe(false);
      expect(r.reasons.join()).toMatch(why);
    });
  }

  test("a train proof does not stand in for a single-PR merge", () => {
    expect(verifyCiProof(EXPECT, run({}, manifest({ train: TRAIN }))).reasons).toContain("列车证明用于非列车合并");
  });
});
