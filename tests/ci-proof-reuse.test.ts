/**
 * merge-arch-REUSE1: reuse of a successful CI check only on fully identical inputs (lib/ci-proof-reuse.ts, scripts/ci-proof-reuse.ts,
 * scripts/ci-proof-reuse-verify.ts, the ci.yml wiring and the thin call in lib/ci-proof.ts). Every miss — a differing input, a
 * forged / expired / revoked artifact, a wrong repo, a non-success result, a failed lookup — really runs the check; tests and guard
 * never reuse; a receipt never turns a related proof into a full one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CiProofExpect, type CiRunEvidence, judgeCiCoverage, verifyCiProof } from "../src/lib/ci-proof.js";
import { CI_PROOF_MANIFEST_VERSION, ciProofManifestDigest, parseCiProofManifest } from "../src/lib/ci-proof-manifest.js";
import {
  CI_PROOF_REUSE_ARTIFACT, CI_PROOF_REUSE_POLICY, CI_PROOF_REUSE_WORKFLOW, CI_REUSE_CHECKS, CI_REUSE_GUARD_BASELINE, CI_REUSE_LOCKFILES, type CiReuseInputs,
  type CiReuseApi, type CiReuseOrigin, type CiRunReuse, readCiRunReuse, ciProofReuseMode, ciProofReusePolicyMode, ciProofReuseProblems, ciReuseArtifactName, ciReuseCommandDigest, ciReuseDigest,
  ciReuseInputDiff, ciReuseInputProblems, ciReuseKey, decideCiReuse, parseCiReuseReceipt, parseCiReuseRecord, verifyCiReuseOrigin,
} from "../src/lib/ci-proof-reuse.js";
import { RECOVERY_KEYS, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { localInputs, lookupOrigins, type OriginDeps, reuseNotice, revokedRuns, runCheck, type RunDeps, RUN_FILE } from "../scripts/ci-proof-reuse.ts";
import { verifyReceipts, writerRun } from "../scripts/ci-proof-reuse-verify.ts";

const ROOT = join(import.meta.dir, "..");
const sha = (c: string) => c.repeat(40);
const REPO = "shawnlu96/claudestra", LOCK = ciReuseDigest("bun.lock"), ZIP = ciReuseDigest("zip bytes");
const SELF = { runId: 900, attempt: 2 }, ORIGIN_RUN = 700;

function inputs(over: Partial<CiReuseInputs> = {}, check = "typecheck"): CiReuseInputs {
  const def = CI_REUSE_CHECKS[check];
  return {
    policy: CI_PROOF_REUSE_POLICY, repo: REPO, tree: sha("4"), base: sha("2"), guardBaseline: ciReuseDigest("baseline"),
    workflow: { path: CI_PROOF_REUSE_WORKFLOW, digest: ciReuseDigest("ci.yml") },
    check: { id: check, scope: def?.scope ?? "repo", command: def ? ciReuseCommandDigest(def) : ciReuseDigest("anything") },
    toolchain: { bun: "1.3.14", node: "v22.9.0" }, lockfiles: [{ path: "bun.lock", digest: LOCK }, { path: "web/package-lock.json", digest: ciReuseDigest("web") }],
    platform: { os: "Linux", arch: "X64", image: "ubuntu24:20261005.1" }, generated: [], ...over,
  };
}

/** A trusted original run that really passed the check on `i`; `rec` overrides fields of its record. */
function origin(i: CiReuseInputs = inputs(), over: Partial<CiReuseOrigin> = {}, rec: Record<string, unknown> = {}): CiReuseOrigin {
  const def = CI_REUSE_CHECKS[i.check.id] ?? CI_REUSE_CHECKS.typecheck!;
  const record = { version: 1, kind: "record", key: ciReuseKey(i), inputs: i, run: { runId: ORIGIN_RUN, attempt: 1, checkout: sha("c") }, seconds: 95, ...rec };
  return {
    source: "actions-api", repo: REPO, headRepo: REPO, runId: ORIGIN_RUN, workflowPath: CI_PROOF_REUSE_WORKFLOW, event: "pull_request", headSha: sha("a"), attempt: 1,
    job: { name: def.job, conclusion: "success", steps: [{ name: "Install dependencies", conclusion: "success" }, { name: def.step, conclusion: "success" }] },
    artifact: { id: 55, name: ciReuseArtifactName(i), runId: ORIGIN_RUN, expired: false, digest: ZIP, contentDigest: ZIP, record },
    commit: { sha: sha("c"), tree: i.tree, parents: [sha("b"), sha("a")] }, ...over,
  };
}

type Lookup = CiReuseOrigin[] | Error;
function harness(mode: RunDeps["mode"], opts: { origins?: Lookup; code?: number; inputs?: CiReuseInputs | Error; revoked?: number[] } = {}) {
  const ran: string[] = [], calls: string[] = [], out: string[] = [], log: string[] = [], files = new Map<string, unknown>();
  let clock = 0;
  const deps: RunDeps = {
    mode, run: { ...SELF, checkout: sha("3") }, revokedRuns: opts.revoked ?? [], now: () => clock,
    inputs: () => { calls.push("inputs"); if (opts.inputs instanceof Error) throw opts.inputs; return opts.inputs ?? inputs(); },
    lookup: async () => { calls.push("lookup"); clock += 800; if (opts.origins instanceof Error) throw opts.origins; return opts.origins ?? []; },
    exec: async (cmd) => { ran.push(cmd.join(" ")); clock += 95_000; return opts.code ?? 0; },
    writeJson: (path, value) => { files.set(path, value); }, output: (line) => { out.push(line); }, log: (line) => { log.push(line); },
  };
  const notice = () => log.find((l) => l.startsWith("::notice title=ci-proof-reuse::")) ?? "";
  return { deps, ran, calls, out, log, files, notice, go: () => runCheck("typecheck", "out", deps) };
}

const ciText = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
interface Step { name?: string; id?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; "continue-on-error"?: boolean }
const ci = Bun.YAML.parse(ciText) as { jobs: Record<string, { name: string; if?: string; "timeout-minutes"?: number; steps: Step[] }> };
const step = (job: string, name: string) => ci.jobs[job]!.steps.find((s) => s.name === name)!;
const MODE_EXPR = "${{ vars.CI_PROOF_REUSE == 'on' && 'on' || vars.CI_PROOF_REUSE == 'off' && 'off' || 'observe' }}";

describe("[验收线 1] identical inputs + an original success: on reuses with a traceable receipt, observe still runs", () => {
  test("red first: the two static steps used to run their command directly, so a repeat of the same content left no reuse evidence", () => {
    expect(step("tests", "Typecheck (tsc --noEmit)").run).toBe('bun scripts/ci-proof-reuse.ts run typecheck "$RUNNER_TEMP/ci-reuse"');
    expect(step("tests", "Build entrypoints").run).toBe('bun scripts/ci-proof-reuse.ts run build "$RUNNER_TEMP/ci-reuse"');
    expect(CI_REUSE_CHECKS.typecheck!.commands).toEqual([["bun", "run", "typecheck"]]);
    // without an original run there is nothing to reuse: the check runs, exactly as before this card
    expect(decideCiReuse({ mode: "on", inputs: inputs(), evidence: null, run: SELF })).toMatchObject({ execute: true, candidate: false, receipt: null });
  });

  test("on: the command is not run, the step exits 0 and the receipt names the original run / attempt / job / step / artifact / key", async () => {
    const h = harness("on", { origins: [origin()] });
    expect(await h.go()).toBe(0);
    expect(h.ran).toEqual([]);
    const receipt = h.files.get("out/receipts/receipt-typecheck.json");
    expect(receipt).toMatchObject({ kind: "receipt", key: ciReuseKey(inputs()), run: SELF, origin: { runId: ORIGIN_RUN, attempt: 1, job: "test shard 1 of 8",
      step: "Typecheck (tsc --noEmit)", checkout: sha("c"), artifact: { id: 55, name: ciReuseArtifactName(inputs()), digest: ZIP }, seconds: 95 } });
    expect(parseCiReuseReceipt(JSON.parse(JSON.stringify(receipt))).ok).toBe(true);
    expect(h.files.get(`out/receipts/${RUN_FILE}`)).toEqual(SELF);
    expect(h.notice()).toBe("::notice title=ci-proof-reuse::check=typecheck mode=on candidate=1 reused=1 origin=700/1 lookup-ms=800 exec-s=0 saved-s=95 actual=reused");
    // a reusing run publishes no record of its own: reuse never chains
    expect(h.out).toEqual([]);
  });

  test("observe (the default) finds the same hit but really runs, leaves no receipt and records the would-be reuse next to the real result", async () => {
    const h = harness("observe", { origins: [origin()] });
    expect(await h.go()).toBe(0);
    expect(h.ran).toEqual(["bun run typecheck"]);
    expect([...h.files.keys()].sort()).toEqual(["out/receipts/run.json", "out/record-typecheck/record.json"]);
    expect(h.notice()).toBe("::notice title=ci-proof-reuse::check=typecheck mode=observe candidate=1 reused=0 origin=700/1 lookup-ms=800 exec-s=95 saved-s=0 actual=success");
    expect(h.out).toEqual([`reuse_record=${ciReuseArtifactName(inputs())}`]);
    expect(parseCiReuseRecord(h.files.get("out/record-typecheck/record.json"))).toMatchObject({ ok: true, value: { run: { ...SELF, checkout: sha("3") }, seconds: 95 } });
  });

  test("ciProofReuse defaults to observe on both sides: unset / empty / unknown values, and the recovery key", () => {
    for (const raw of [undefined, "", "observe", "yes", " on", 1]) expect(ciProofReuseMode(raw)).toBe("observe");
    expect([ciProofReuseMode("ON"), ciProofReuseMode("off")]).toEqual(["on", "off"]);
    expect(RECOVERY_KEYS.filter((k) => k === "ciProofReuse")).toHaveLength(1);
    expect(recoveryPolicy("p", "ciProofReuse", join(ROOT, "no-such-policy.json")).mode).toBe("observe");
    expect(ciProofReusePolicyMode("p", () => ({ mode: "on", manualAfterMs: null, source: "config" }))).toBe("on");
    for (const name of ["Typecheck (tsc --noEmit)", "Build entrypoints"]) expect(step("tests", name).env!.CI_PROOF_REUSE).toBe(MODE_EXPR);
  });
});

describe("[验收线 2] any input difference, an invalid or forged artifact, a wrong repo or a non-success result really reruns", () => {
  const VARIANTS: [string, Partial<CiReuseInputs>][] = [
    ["policy", { policy: "ci-reuse-0" }], ["repo", { repo: "someone/claudestra" }], ["tree", { tree: sha("9") }], ["base", { base: sha("9") }],
    ["guardBaseline", { guardBaseline: ciReuseDigest("other baseline") }], ["workflow", { workflow: { path: CI_PROOF_REUSE_WORKFLOW, digest: ciReuseDigest("edited") } }],
    ["check", { check: { ...inputs().check, command: ciReuseDigest("other command") } }], ["check", { check: { ...inputs().check, scope: "related" } }],
    ["toolchain", { toolchain: { bun: "1.3.15", node: "v22.9.0" } }], ["toolchain", { toolchain: { bun: "1.3.14", node: "v22.10.0" } }],
    ["lockfiles", { lockfiles: [{ path: "bun.lock", digest: ciReuseDigest("bumped") }, inputs().lockfiles[1]!] }],
    ["lockfiles", { lockfiles: [inputs().lockfiles[0]!, { path: "web/package-lock.json", digest: ciReuseDigest("bumped") }] }],
    ["platform", { platform: { ...inputs().platform, image: "ubuntu24:20261012.1" } }], ["platform", { platform: { ...inputs().platform, arch: "ARM64" } }],
    ["generated", { generated: [{ path: "web/lib/build-info.ts", digest: ciReuseDigest("gen") }] }],
  ];

  test("every listed input is in the key: changing any one of them changes the key and the artifact name the lookup asks for", () => {
    const base = inputs();
    for (const [field, over] of VARIANTS) {
      const other = inputs(over);
      expect(ciReuseInputDiff(base, other)).toEqual([field]);
      expect(ciReuseKey(other)).not.toBe(ciReuseKey(base));
      expect(ciReuseArtifactName(other)).not.toBe(ciReuseArtifactName(base));
    }
    expect(ciReuseArtifactName(inputs({}, "build"))).not.toBe(ciReuseArtifactName(base));
  });

  test("a record built from different inputs is refused even when it is filed under this key's name", () => {
    for (const [field, over] of VARIANTS) {
      const forged = origin(inputs(), {}, { inputs: inputs(over) });
      const d = decideCiReuse({ mode: "on", inputs: inputs(), evidence: forged, run: SELF });
      expect(d).toMatchObject({ execute: true, candidate: false, receipt: null });
      expect(d.reasons.join("；")).toContain(`输入不同：${field}`);
    }
  });

  const art = (over: Record<string, unknown>) => ({ artifact: { ...origin().artifact!, ...over } });
  const job = (conclusion: string | null, stepConclusion: string | null = "success") =>
    ({ job: { name: "test shard 1 of 8", conclusion, steps: [{ name: "Typecheck (tsc --noEmit)", conclusion: stepConclusion }] } });
  const MISSES: [string, CiReuseOrigin, string][] = [
    ["wrong repo", origin(inputs(), { repo: "someone/claudestra" }), "原 run 仓库"],
    ["fork head", origin(inputs(), { headRepo: "fork/claudestra" }), "fork 不受信"],
    ["unknown head repo", origin(inputs(), { headRepo: null }), "fork 不受信"],
    ["untrusted source", origin(inputs(), { source: "author-json" }), "不受信"],
    ["check-run source", origin(inputs(), { source: "check-run" }), "不受信"],
    ["other workflow", origin(inputs(), { workflowPath: ".github/workflows/nightly.yml" }), "workflow"],
    ["dispatch event", origin(inputs(), { event: "workflow_dispatch" }), "事件"],
    ["expired artifact", origin(inputs(), art({ expired: true })), "已过期"],
    ["tampered bytes", origin(inputs(), art({ contentDigest: ciReuseDigest("other bytes") })), "不完整"],
    ["no registered digest", origin(inputs(), art({ digest: null })), "不完整"],
    ["no artifact", origin(inputs(), { artifact: null }), "没有复用记录工件"],
    ["artifact of another run", origin(inputs(), art({ runId: 701 })), "工件属于 run 701"],
    ["wrong name", origin(inputs(), art({ name: "ci-reuse-typecheck-0000" })), "工件名"],
    ["unknown field in record", origin(inputs(), {}, { verdict: "success" }), "不是版本 1 的复用记录"],
    ["garbage record", origin(inputs(), art({ record: "ok" })), "不是版本 1 的复用记录"],
    ["forged key", origin(inputs(), {}, { key: ciReuseDigest("forged") }), "key 与输入不符"],
    ["record of another run", origin(inputs(), {}, { run: { runId: 701, attempt: 1, checkout: sha("c") } }), "记录来自 run 701"],
    ["record of another attempt", origin(inputs(), {}, { run: { runId: ORIGIN_RUN, attempt: 3, checkout: sha("c") } }), "attempt 3"],
    ["failed job", origin(inputs(), job("failure")), "原作业结论 failure"],
    ["cancelled job", origin(inputs(), job("cancelled")), "原作业结论 cancelled"],
    ["skipped job", origin(inputs(), job("skipped")), "原作业结论 skipped"],
    ["job still running", origin(inputs(), job(null)), "原作业结论 未知"],
    ["skipped step", origin(inputs(), job("success", "skipped")), "结论 skipped"],
    ["failed step", origin(inputs(), job("success", "failure")), "结论 failure"],
    ["step missing", origin(inputs(), { job: { name: "test shard 1 of 8", conclusion: "success", steps: [] } }), "结论 缺失"],
    ["job missing", origin(inputs(), { job: null }), "没有作业"],
    ["checkout unreadable", origin(inputs(), { commit: null }), "读不回"],
    ["checkout of another tree", origin(inputs(), { commit: { sha: sha("c"), tree: sha("8"), parents: [sha("b"), sha("a")] } }), "tree"],
    ["checkout not this PR head's merge", origin(inputs(), { commit: { sha: sha("c"), tree: sha("4"), parents: [sha("b"), sha("d")] } }), "对不上"],
    ["push run on another commit", origin(inputs(), { event: "push" }), "对不上"],
  ];

  test("each of these candidates is a miss with its reason, and on then runs the command instead of reusing", async () => {
    for (const [label, ev, reason] of MISSES) {
      const v = verifyCiReuseOrigin(inputs(), ev, { selfRunId: SELF.runId });
      expect(`${label}: ${v.ok}`).toBe(`${label}: false`);
      expect(`${label}: ${v.reasons.join("；")}`).toContain(reason);
      const h = harness("on", { origins: [ev] });
      expect(await h.go()).toBe(0);
      expect(`${label}: ${h.ran.join()}`).toBe(`${label}: bun run typecheck`);
      expect(h.files.has("out/receipts/receipt-typecheck.json")).toBe(false);
    }
  });

  test("a revoked run and this run itself are never an origin; a push run counts when its head is the checkout", async () => {
    expect(verifyCiReuseOrigin(inputs(), origin(), { revokedRuns: [ORIGIN_RUN] }).reasons).toEqual([`原 run ${ORIGIN_RUN} 已撤销`]);
    expect(verifyCiReuseOrigin(inputs(), origin(), { selfRunId: ORIGIN_RUN }).reasons).toEqual(["不能复用本次运行自己的结果"]);
    expect(revokedRuns("700, 701\n702 x -3")).toEqual([700, 701, 702]);
    const h = harness("on", { origins: [origin()], revoked: [ORIGIN_RUN] });
    await h.go();
    expect(h.ran).toEqual(["bun run typecheck"]);
    expect(verifyCiReuseOrigin(inputs(), origin(inputs(), { event: "push", headSha: sha("c"), commit: { sha: sha("c"), tree: sha("4"), parents: [sha("b")] } })).ok).toBe(true);
  });

  test("the first valid candidate is used when an invalid one is listed before it", async () => {
    const h = harness("on", { origins: [origin(inputs(), { headRepo: "fork/claudestra" }), origin()] });
    expect(await h.go()).toBe(0);
    expect(h.ran).toEqual([]);
  });

  test("a failed run is never cached: no record is written and its exit code is the step's", async () => {
    for (const mode of ["observe", "on"] as const) {
      const h = harness(mode, { code: 2 });
      expect(await h.go()).toBe(2);
      expect([...h.files.keys()]).toEqual(["out/receipts/run.json"]);
      expect(h.out).toEqual([]);
      expect(h.notice()).toContain("candidate=0 reused=0 origin=none lookup-ms=800 exec-s=95 saved-s=0 actual=failure");
    }
  });

  test("tests, guard and anything unlisted are outside the approved range and always really run", () => {
    expect(Object.keys(CI_REUSE_CHECKS).sort()).toEqual(["build", "typecheck"]);
    for (const id of ["guard", "tests", "test shard 1 of 8", "web-build", "constructor"]) {
      const i = inputs({}, id);
      expect(ciReuseInputProblems(i).join()).toContain("不在首期批准的复用范围");
      expect(decideCiReuse({ mode: "on", inputs: i, evidence: origin(i), run: SELF })).toMatchObject({ execute: true, candidate: false });
      expect(() => localInputs(id, { env: {}, git: () => "", read: () => "", bun: "1", node: "v1" })).toThrow("不在批准的复用范围");
    }
    expect(step("tests", "Guard (ratchets)").run).toBe("bun run guard");
    expect(step("tests", "Unit tests").run).not.toContain("ci-proof-reuse");
    const reusing = Object.values(ci.jobs).flatMap((j) => j.steps).filter((s) => (s.run ?? "").includes("ci-proof-reuse.ts"));
    expect(reusing.map((s) => s.name)).toEqual(["Typecheck (tsc --noEmit)", "Build entrypoints"]);
  });

  test("this run's inputs come from its own checkout, lockfiles, toolchain and runner; a missing one means no reuse and no record", async () => {
    const env = { GITHUB_REPOSITORY: REPO, REUSE_BASE: sha("2"), RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20261005.1" };
    const read: string[] = [];
    const git = (...a: string[]) => (a.join(" ") === "rev-parse HEAD^{tree}" ? `${sha("4")}\n` : "");
    const facts = { env, git, read: (p: string) => { read.push(p); return p; }, bun: "1.3.14", node: "v22.9.0" };
    const i = localInputs("typecheck", facts);
    expect(i).toMatchObject({ repo: REPO, tree: sha("4"), base: sha("2"), platform: { os: "Linux", arch: "X64", image: "ubuntu24:20261005.1" } });
    expect(i.guardBaseline).toBe(ciReuseDigest(CI_REUSE_GUARD_BASELINE));
    expect(read.sort()).toEqual([CI_PROOF_REUSE_WORKFLOW, CI_REUSE_GUARD_BASELINE, ...CI_REUSE_LOCKFILES].sort());
    expect(ciReuseInputProblems(i)).toEqual([]);
    expect(() => localInputs("typecheck", { ...facts, env: { ...env, REUSE_BASE: "" } })).toThrow("REUSE_BASE");
    const h = harness("on", { inputs: new Error("缺环境变量 ImageVersion") });
    expect(await h.go()).toBe(0);
    expect([h.ran, h.calls, [...h.files.keys()]]).toEqual([["bun run typecheck"], ["inputs"], ["out/receipts/run.json"]]);
  });
});

const U = ciReuseDigest("all tests"), REQUIRED = ["typecheck + test + guard"];
const EXPECT: CiProofExpect = {
  repo: REPO, head: sha("1"), base: sha("2"), checkout: { sha: sha("3"), tree: sha("4") }, workflow: { path: CI_PROOF_REUSE_WORKFLOW, sha: sha("5") },
  policyVersion: "ci-full-1", toolchain: { bun: "1.3.14", lockfileDigest: LOCK }, testsUniverseDigest: U, requiredChecks: REQUIRED,
};
/** A run whose own manifest is valid for EXPECT (full unless overridden), carrying the given reuse evidence. */
function proofRun(reuse: CiRunReuse | null | undefined, manifestOver: Record<string, unknown> = {}): CiRunEvidence {
  const { requiredChecks, testsUniverseDigest, ...bound } = EXPECT;
  const tests = { universeDigest: testsUniverseDigest, selectedDigest: U, count: 12 };
  const content = { version: CI_PROOF_MANIFEST_VERSION, ...bound, tests, scope: "full", checks: requiredChecks, ...manifestOver };
  const parsed = parseCiProofManifest(content);
  if (!parsed.ok) throw new Error(parsed.reason);
  const jobs = [{ name: REQUIRED[0]!, attempt: SELF.attempt, conclusion: "success", checkoutSha: sha("3"), checkoutTree: sha("4") }];
  return { origin: "actions-api", repo: REPO, ...SELF, latestAttempt: SELF.attempt, workflow: EXPECT.workflow, headSha: EXPECT.head, status: "completed", conclusion: "success",
    jobs, artifact: { ...SELF, digest: ciProofManifestDigest(parsed.manifest), content }, reuse };
}
const receiptOf = (i: CiReuseInputs = inputs(), o: CiReuseOrigin = origin(i)) => decideCiReuse({ mode: "on", inputs: i, evidence: o, run: SELF }).receipt!;
const reuseOf = (receipts: unknown[], origins: CiReuseOrigin[] = [origin()], revoked?: number[]): CiRunReuse => ({ artifact: { ...SELF, receipts }, origins, revokedRuns: revoked });

describe("[验收线 3] a receipt never upgrades related to full and never stands in for tests that did not run", () => {
  test("a full proof with valid receipts authorises exactly as one without; the receipts change nothing else", () => {
    expect(verifyCiProof(EXPECT, proofRun(undefined))).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true });
    expect(verifyCiProof(EXPECT, proofRun(reuseOf([receiptOf()])))).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true, reasons: [] });
  });

  test("related stays related: valid receipts on a related proof authorise nothing", () => {
    const related = { scope: "related", tests: { universeDigest: U, selectedDigest: ciReuseDigest("some tests"), count: 12 } };
    expect(verifyCiProof(EXPECT, proofRun(reuseOf([receiptOf()]), related))).toMatchObject({ ok: true, scope: "related", mergeAuthorized: false, reasons: ["related 证明不授权合并"] });
  });

  test("a full manifest that missed tests is still refused with valid static receipts beside it", () => {
    const missed = { tests: { universeDigest: U, selectedDigest: ciReuseDigest("some tests"), count: 12 } };
    expect(verifyCiProof(EXPECT, proofRun(reuseOf([receiptOf()]), missed))).toMatchObject({ mergeAuthorized: false, reasons: ["full 证明漏测试：选集 ≠ 全集"] });
  });

  test("a receipt claiming tests, guard or a related-scope check is itself a reason to refuse the proof", () => {
    for (const i of [inputs({}, "tests"), inputs({}, "guard"), inputs({ check: { ...inputs().check, scope: "related" } })]) {
      const forged = { ...receiptOf(), key: ciReuseKey(i), inputs: i };
      const r = verifyCiProof(EXPECT, proofRun(reuseOf([forged], [origin(i)])));
      expect(r).toMatchObject({ ok: false, mergeAuthorized: false });
    }
  });

  test("a receipt bound to another subject, another run or an origin that no longer verifies refuses the proof", () => {
    const cases: [string, CiRunReuse][] = [
      ["回执 tree 与被核对象不符", reuseOf([receiptOf(inputs({ tree: sha("8") }))], [origin(inputs({ tree: sha("8") }))])],
      ["回执 base 与被核对象不符", reuseOf([receiptOf(inputs({ base: sha("8") }))], [origin(inputs({ base: sha("8") }))])],
      ["回执 bun.lock 与被核对象不符", reuseOf([receiptOf(inputs({ lockfiles: [{ path: "bun.lock", digest: ciReuseDigest("x") }, inputs().lockfiles[1]!] }))])],
      ["的回执属于 run 901", reuseOf([{ ...receiptOf(), run: { runId: 901, attempt: 2 } }])],
      ["复用回执来自 run 900 attempt 1", { ...reuseOf([receiptOf()]), artifact: { runId: 900, attempt: 1, receipts: [receiptOf()] } }],
      ["没有候选的原 run", reuseOf([receiptOf()], [])],
      [`原 run ${ORIGIN_RUN} 已撤销`, reuseOf([receiptOf()], [origin()], [ORIGIN_RUN])],
      ["原工件已过期", reuseOf([receiptOf()], [origin(inputs(), { artifact: { ...origin().artifact!, expired: true } })])],
      ["原作业结论 failure", reuseOf([receiptOf()], [origin(inputs(), { job: { name: "test shard 1 of 8", conclusion: "failure", steps: [] } })])],
      ["不是同一份工件", reuseOf([receiptOf()], [origin(inputs(), { artifact: { ...origin().artifact!, id: 56 } })])],
      ["有多份回执", reuseOf([receiptOf(), receiptOf()])],
      ["不是版本 1 的复用回执", reuseOf([{ ...receiptOf(), verdict: "success" }])],
      ["key 与输入不符", reuseOf([{ ...receiptOf(), key: ciReuseDigest("forged") }])],
    ];
    for (const [reason, reuse] of cases) {
      const r = verifyCiProof(EXPECT, proofRun(reuse));
      expect(`${reason}: ${r.ok}/${r.mergeAuthorized}`).toBe(`${reason}: false/false`);
      expect(r.reasons.join("；")).toContain(reason);
    }
  });
});

describe("[验收线 4] one verification for every merge path; a hit or a failed lookup never interrupts them", () => {
  test("judgeCiCoverage, the entry the planner, inspect, mergeCandidates and the deploy tick share, re-verifies the receipts", () => {
    const good = proofRun(reuseOf([receiptOf()])), bad = proofRun(reuseOf([receiptOf()], [origin()], [ORIGIN_RUN]));
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: good })).toMatchObject({ allow: true, reasons: [] });
    expect(judgeCiCoverage({ mode: "on", prior: true, expect: EXPECT, evidence: bad })).toMatchObject({ allow: false, reasons: [`复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`] });
    // the gate only narrows: a valid reuse cannot turn a path's own refusal (slot, review, UI gate) into an allow
    expect(judgeCiCoverage({ mode: "on", prior: false, expect: EXPECT, evidence: good }).allow).toBe(false);
    expect(judgeCiCoverage({ mode: "observe", prior: true, expect: EXPECT, evidence: bad })).toMatchObject({ allow: true, reasons: [`复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`] });
    expect(judgeCiCoverage({ mode: "off", prior: true, expect: EXPECT, evidence: bad })).toMatchObject({ allow: true, reasons: [], proof: null });
  });

  /** The Actions API as the evidence reader sees it: run 900's ci-proof-reuse artifact (id 80) and the original run 700 behind receipt artifact 55. */
  function fakeApi(o: { receipts?: unknown[]; marker?: unknown; fail?: RegExp; none?: boolean; digest?: string; expired?: boolean } = {}) {
    const asked: string[] = [], bytes = (t: string) => new TextEncoder().encode(t);
    const files = new Map([[RUN_FILE, JSON.stringify(o.marker ?? SELF)], ...(o.receipts ?? [receiptOf()]).map((r, n) => [`receipt-${n}.json`, JSON.stringify(r)] as const)]);
    const own = { id: 80, name: CI_PROOF_REUSE_ARTIFACT, expired: o.expired === true, digest: o.digest ?? ciReuseDigest("receipts zip"), workflow_run: { id: SELF.runId } };
    const api: CiReuseApi = {
      api: async (path) => {
        asked.push(path.replace(`/repos/${REPO}`, ""));
        if (o.fail?.test(path)) throw new Error("503");
        if (path.includes(`/runs/${SELF.runId}/artifacts?`)) return { artifacts: o.none ? [] : [own] };
        if (path.endsWith("/actions/artifacts/55")) return { id: 55, name: ciReuseArtifactName(inputs()), expired: false, digest: ZIP, workflow_run: { id: ORIGIN_RUN } };
        if (path.includes("/jobs")) return { jobs: [{ name: "test shard 1 of 8", conclusion: "success", steps: [{ name: "Typecheck (tsc --noEmit)", conclusion: "success" }] }] };
        if (path.includes("/git/commits/")) return { sha: sha("c"), tree: { sha: sha("4") }, parents: [{ sha: sha("b") }, { sha: sha("a") }] };
        return { repository: { full_name: REPO }, head_repository: { full_name: REPO }, path: CI_PROOF_REUSE_WORKFLOW, event: "pull_request", head_sha: sha("a") };
      },
      download: async (id) => bytes(id === 80 ? "receipts zip" : "zip bytes"), entries: async () => [...files.keys()],
      unzip: async (_zip, name) => (name === "record.json" ? JSON.stringify(origin().artifact!.record) : files.get(name)!),
    };
    return { api, asked };
  }
  /** Each merge entry's call, drilled with injected ports (the real wiring is merge-arch-GATE1): read the run's reuse evidence, then ask the one gate. */
  const ENTRIES = ["planner", "inspect", "mergeCandidates", "deploy tick"] as const;
  const enter = async (_entry: (typeof ENTRIES)[number], api: CiReuseApi, o: { revoked?: number[]; prior?: boolean; mode?: "off" | "observe" | "on" } = {}) =>
    judgeCiCoverage({ mode: o.mode ?? "on", prior: o.prior ?? true, expect: EXPECT, evidence: proofRun(await readCiRunReuse(REPO, SELF, api, o.revoked)) });

  test("drill with fake ports: all four entries read the receipts back from the API and get the same verdict; unread evidence refuses", async () => {
    const cases: [string, Parameters<typeof fakeApi>[0], number[], string | null][] = [
      ["a verified reuse", {}, [], null],
      ["no reuse artifact at all", { none: true }, [], null],
      ["a marker but no receipt", { receipts: [] }, [], null],
      ["artifact list unreachable", { fail: /runs\/900\/artifacts/ }, [], "复用回执工件读不回（503），不能当作没有复用"],
      ["artifact expired", { expired: true }, [], "复用回执工件读不回（工件已过期）"],
      ["archive tampered", { digest: ciReuseDigest("other") }, [], "下载内容的摘要与登记的不符"],
      ["receipts without this run's marker", { marker: { runId: 901, attempt: 2 } }, [], `有回执却没有属于本次 run 的 ${RUN_FILE}`],
      ["receipts of an earlier attempt", { marker: { runId: 900, attempt: 1 } }, [], "复用回执来自 run 900 attempt 1，不是本次"],
      ["original run unreachable", { fail: /runs\/700$/ }, [], `复用 typecheck 的原 run ${ORIGIN_RUN} 读不回（503）`],
      ["original run revoked", {}, [ORIGIN_RUN], `复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`],
      ["revoked and unreachable", { fail: /700|artifacts\/55/ }, [ORIGIN_RUN], `复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`],
      ["a forged receipt file", { receipts: [receiptOf(), { ...receiptOf(), verdict: "success" }] }, [], "不是版本 1 的复用回执"],
    ];
    for (const [name, o, revoked, reason] of cases) {
      const seen = new Set<string>();
      for (const entry of ENTRIES) {
        const v = await enter(entry, fakeApi(o).api, { revoked });
        expect(`${name}: ${v.allow}`).toBe(`${name}: ${reason === null}`);
        expect(v.reasons.join("；")).toContain(reason ?? "");
        seen.add(JSON.stringify(v));
        // the read never throws and the gate only narrows: observe keeps the path's own verdict, a refused prior stays refused
        expect((await enter(entry, fakeApi(o).api, { revoked, mode: "observe" })).allow).toBe(true);
        expect((await enter(entry, fakeApi(o).api, { revoked, prior: false })).allow).toBe(false);
      }
      expect(seen.size).toBe(1);
    }
    const good = fakeApi();
    expect((await readCiRunReuse(REPO, SELF, good.api)).origins).toEqual([origin(inputs(), { job: { name: "test shard 1 of 8", conclusion: "success",
      steps: [{ name: "Typecheck (tsc --noEmit)", conclusion: "success" }] } })]);
    expect(good.asked).toEqual([`/actions/runs/900/artifacts?name=${CI_PROOF_REUSE_ARTIFACT}&per_page=100`, "/actions/artifacts/55", `/actions/runs/${ORIGIN_RUN}`,
      `/actions/runs/${ORIGIN_RUN}/attempts/1/jobs?per_page=100`, `/git/commits/${sha("c")}`]);
    // a revoked origin is refused from the list alone: its run is not even asked for
    const revoked = fakeApi();
    await readCiRunReuse(REPO, SELF, revoked.api, [ORIGIN_RUN]);
    expect(revoked.asked).toHaveLength(1);
  });

  test("only the proof verifier and the two CI scripts import the reuse module: trains, the serial driver, manual queues and PM ops do not", () => {
    const ls = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "src", "scripts"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().split("\n").filter((p) => /\.ts$/.test(p));
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const modules = new Set(["ci-proof-reuse.ts", "ci-proof-reuse.js", "ci-proof-reuse-verify.ts", "ci-proof-reuse-verify.js"]);
    const importsReuse = (source: string) => {
      // Scan dependencies rather than basis data or comments; the scanner expects shebangs to be removed.
      const code = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
      return transpiler.scanImports(code).some((i) => modules.has(i.path.split("/").at(-1)!));
    };
    expect(importsReuse('export const basis = [{ path: "src/lib/ci-proof-reuse.ts" }];')).toBe(false);
    expect(importsReuse('import { runCheck } from "./ci-proof-reuse.ts";')).toBe(true);
    expect(importsReuse("export { runCheck } from './ci-proof-reuse.js';")).toBe(true);
    expect(importsReuse('const reuse = import("./ci-proof-reuse-verify.ts");')).toBe(true);
    expect(importsReuse('const reuse = require("./ci-proof-reuse.js");')).toBe(true);
    expect(importsReuse('#!/usr/bin/env bun\nimport "./ci-proof-reuse-verify.js";')).toBe(true);
    const users = ls.filter((p) => p !== "src/lib/ci-proof-reuse.ts" && importsReuse(readFileSync(join(ROOT, p), "utf8")));
    expect(users.sort()).toEqual(["scripts/ci-proof-reuse-verify.ts", "scripts/ci-proof-reuse.ts", "src/lib/ci-proof.ts", "src/lib/scheduler-ci-proof-port.ts"]);
    const lib = readFileSync(join(ROOT, "src", "lib", "ci-proof-reuse.ts"), "utf8");
    for (const m of lib.matchAll(/^import [^;]*? from "([^"]+)";/gm)) expect(m[1]!).toMatch(/^(node:[\w/]+|\.\/[\w-]+\.js)$/);
  });

  test("a failed lookup or download is only a miss: the command runs and its result is the step's, in observe and in on", async () => {
    for (const mode of ["observe", "on"] as const) {
      const h = harness(mode, { origins: new Error("GET /repos/x/actions/artifacts → 503") });
      expect(await h.go()).toBe(0);
      expect(h.ran).toEqual(["bun run typecheck"]);
      expect(h.log.join("\n")).toContain("查询候选失败，照常执行：GET /repos/x/actions/artifacts → 503");
      expect(h.out).toEqual([`reuse_record=${ciReuseArtifactName(inputs())}`]);
    }
  });

  test("the lookup reads every fact back through the API, skips this run's own artifact and survives an undecodable archive", async () => {
    const i = inputs(), rec = origin(i).artifact!.record, asked: string[] = [];
    const row = (id: number, runId: number, expired = false) => ({ id, name: ciReuseArtifactName(i), expired, digest: ZIP, workflow_run: { id: runId } });
    const deps: OriginDeps = {
      api: async (path) => {
        asked.push(path.replace(`/repos/${REPO}`, ""));
        if (path.includes("/actions/artifacts?")) return { artifacts: [row(50, 650, true), row(55, ORIGIN_RUN), row(60, SELF.runId)] };
        if (path.includes("/jobs")) return { jobs: [{ name: "test shard 1 of 8", conclusion: "success", steps: [{ name: "Typecheck (tsc --noEmit)", conclusion: "success" }] }] };
        if (path.includes("/git/commits/")) return { sha: sha("c"), tree: { sha: sha("4") }, parents: [{ sha: sha("b") }, { sha: sha("a") }] };
        return { repository: { full_name: REPO }, head_repository: { full_name: REPO }, path: CI_PROOF_REUSE_WORKFLOW, event: "pull_request", head_sha: sha("a") };
      },
      download: async () => new TextEncoder().encode("zip bytes"), entries: async () => ["record.json"], unzip: async () => JSON.stringify(rec),
    };
    const found = await lookupOrigins(i, SELF.runId, deps);
    expect(found.map((o) => [o.runId, verifyCiReuseOrigin(i, o).ok])).toEqual([[ORIGIN_RUN, true], [650, false]]);
    expect(found[0]).toEqual(origin(i, { job: { name: "test shard 1 of 8", conclusion: "success", steps: [{ name: "Typecheck (tsc --noEmit)", conclusion: "success" }] } }));
    expect(asked).toEqual([`/actions/artifacts?name=${ciReuseArtifactName(i)}&per_page=20`, `/actions/runs/${ORIGIN_RUN}`, `/actions/runs/${ORIGIN_RUN}/attempts/1/jobs?per_page=100`,
      `/git/commits/${sha("c")}`, "/actions/runs/650"]);
    const broken = await lookupOrigins(i, SELF.runId, { ...deps, unzip: async () => { throw new Error("not a zip"); } });
    expect(verifyCiReuseOrigin(i, broken[0]!).reasons.join()).toContain("不是版本 1 的复用记录");
  });

  const SUBJECT = { repo: REPO, base: sha("2"), tree: sha("4"), bun: "1.3.14", lockfileDigest: LOCK, workflowDigest: inputs().workflow.digest, guardBaseline: inputs().guardBaseline };
  test("the CI gate re-verifies each receipt against a fresh read; an unreachable API is a warning, a real contradiction is red", async () => {
    const receipts = new Map<string, unknown>([["receipt-typecheck.json", receiptOf()]]);
    const base = { subject: SUBJECT, run: SELF, receipts, revokedRuns: [] as number[] };
    expect(await verifyReceipts({ ...base, origin: async () => origin() })).toEqual({ errors: [], warnings: [], verified: [`复用 typecheck ← run ${ORIGIN_RUN} attempt 1`] });
    const down = await verifyReceipts({ ...base, origin: async () => { throw new Error("503"); } });
    expect(down).toMatchObject({ errors: [], verified: [] });
    expect(down.warnings).toEqual([`复用 typecheck 的原 run ${ORIGIN_RUN} 这次读不回来（503），只核了回执本身`]);
    const failed = origin(inputs(), { job: { name: "test shard 1 of 8", conclusion: "failure", steps: [] } });
    expect((await verifyReceipts({ ...base, origin: async () => failed })).errors)
      .toEqual(["复用 typecheck：原作业结论 failure，不是 success", "复用 typecheck：原步骤 Typecheck (tsc --noEmit) 结论 缺失，不是 success"]);
    expect((await verifyReceipts({ ...base, revokedRuns: [ORIGIN_RUN], origin: async () => origin() })).errors).toEqual([`复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`]);
    // revocation is a local fact: red before any API call, and an unreachable API cannot turn it into a warning
    let read = 0;
    const revokedDown = await verifyReceipts({ ...base, revokedRuns: [ORIGIN_RUN], origin: async () => { read++; throw new Error("network unavailable"); } });
    expect([revokedDown, read]).toEqual([{ errors: [`复用 typecheck：原 run ${ORIGIN_RUN} 已撤销`], warnings: [], verified: [] }, 0]);
    // offline the receipt itself is still held to this checkout: another tree is red without any API
    const other = await verifyReceipts({ ...base, subject: { ...SUBJECT, tree: sha("8") }, origin: async () => { throw new Error("503"); } });
    expect(other.errors).toEqual(["复用 typecheck：回执 tree 与被核对象不符"]);
    const junk = await verifyReceipts({ ...base, receipts: new Map([["receipt-typecheck.json", null]]), origin: async () => origin() });
    expect(junk.errors).toEqual(["receipt-typecheck.json：复用回执不是版本 1 的复用回执"]);
  });

  test("a rerun of failed jobs keeps shard 1's earlier attempt: its receipts stay bound to the attempt that wrote them, never to another run", () => {
    expect(writerRun({ runId: 900, attempt: 1 }, 900, 2)).toEqual({ runId: 900, attempt: 1 });
    expect(writerRun({ runId: 900, attempt: 3 }, 900, 2)).toContain("不属于本次 run 900 attempt 2");
    expect(writerRun({ runId: 899, attempt: 1 }, 900, 2)).toContain("不属于本次");
    expect(writerRun(null, 900, 2)).toContain("认不出是哪次 attempt 写的");
  });

  test("workflow: reuse adds no job and no red path of its own; required check names, always() and timeouts are as they were", () => {
    expect(Object.keys(ci.jobs)).toEqual(["plan", "scope", "tests", "check", "web", "web-build", "desktop-scope", "desktop", "proof"]);
    expect([ci.jobs.check!.name, ci.jobs.check!.if, ci.jobs.tests!.name]).toEqual(["typecheck + test + guard", "always()", "test shard ${{ matrix.shard }} of 8"]);
    for (const [id, job] of Object.entries(ci.jobs)) expect(`${id}:${(job["timeout-minutes"] ?? 0) > 0 && job["timeout-minutes"]! < 60}`).toBe(`${id}:true`);
    const records = ci.jobs.tests!.steps.filter((s) => String(s.with?.name ?? "").includes("reuse_record"));
    expect(records.map((s) => [s.if, s["continue-on-error"]]))
      .toEqual([["always() && steps.typecheck.outputs.reuse_record != ''", true], ["always() && steps.build.outputs.reuse_record != ''", true]]);
    expect(step("tests", "Upload reuse receipts")).toMatchObject({ if: "always() && matrix.shard == 1", with: { name: CI_PROOF_REUSE_ARTIFACT, overwrite: true } });
    const steps = ci.jobs.check!.steps, at = steps.findIndex((s) => s.name === "Reused checks verify against their original runs");
    expect(steps[at]!.run).toBe("bun scripts/ci-proof-reuse-verify.ts reuse");
    expect(steps[at - 1]).toMatchObject({ uses: "actions/download-artifact@v4", with: { pattern: CI_PROOF_REUSE_ARTIFACT, path: "reuse" } });
    expect(steps.findIndex((s) => s.name === "All shards succeeded")).toBe(0);
  });
});

describe("[验收线 5] off restores real execution at once; requests already issued are not cancelled", () => {
  test("off runs the command without computing inputs or asking the API, and leaves neither record nor receipt", async () => {
    const h = harness("off", { origins: [origin()] });
    expect(await h.go()).toBe(0);
    expect([h.ran, h.calls, h.out, [...h.files.keys()]]).toEqual([["bun run typecheck"], [], [], ["out/receipts/run.json"]]);
    expect(decideCiReuse({ mode: "off", inputs: inputs(), evidence: origin(), run: SELF })).toEqual({ mode: "off", execute: true, candidate: false, reasons: [], receipt: null });
    const failing = harness("off", { code: 1 });
    expect(await failing.go()).toBe(1);
  });

  test("a receipt issued while on still verifies after the switch goes off: verification does not read the mode", async () => {
    const issued = harness("on", { origins: [origin()] });
    await issued.go();
    const receipt = issued.files.get("out/receipts/receipt-typecheck.json");
    expect(ciProofReuseProblems({ repo: REPO, base: sha("2"), tree: sha("4"), bun: "1.3.14", lockfileDigest: LOCK }, SELF, reuseOf([receipt]))).toEqual([]);
    const next = harness("off", { origins: [origin()] });
    await next.go();
    expect(next.ran).toEqual(["bun run typecheck"]);
  });

  test("the mode is the trusted repo variable, normalised the same way in ci.yml and in the script", () => {
    expect(ciText.match(/vars\.CI_PROOF_REUSE == 'on'/g)).toHaveLength(2);
    for (const raw of ["on", "ON", "off", "Off", "", "observe", "1"]) {
      const expr = raw.toLowerCase() === "on" ? "on" : raw.toLowerCase() === "off" ? "off" : "observe";
      expect(ciProofReuseMode(raw)).toBe(expr);
    }
    expect(reuseNotice("build", decideCiReuse({ mode: "off", inputs: null, evidence: null, run: SELF }), null, { lookupMs: 0, execSeconds: 3, code: 0, saved: null }))
      .toBe("::notice title=ci-proof-reuse::check=build mode=off candidate=0 reused=0 origin=none lookup-ms=0 exec-s=3 saved-s=0 actual=success");
  });

  test("the entry build is the same eight bundles as before, each from a file that exists; guard stays wired strict", async () => {
    const build = CI_REUSE_CHECKS.build!.commands;
    expect(build.map((c) => c[2])).toEqual(["bridge", "channel-server", "manager", "launcher", "cron", "setup", "relay", "scheduler"].map((e) => `src/${e}.ts`));
    for (const c of build) {
      expect([c[0], c[1], c.slice(3)]).toEqual(["bun", "build", ["--target=bun", "--outdir=/tmp/ci-build"]]);
      expect(existsSync(join(ROOT, c[2]!))).toBe(true);
    }
    const ran: string[] = [];
    const h = harness("observe");
    expect(await runCheck("build", "out", { ...h.deps, inputs: () => inputs({}, "build"), exec: async (c) => { ran.push(c[2]!); return ran.length === 3 ? 1 : 0; } })).toBe(1);
    expect(ran).toHaveLength(3);
    expect(step("tests", "Guard (ratchets)").env).toEqual({ GUARD_BASE: "${{ github.event.pull_request.base.sha || github.event.before || inputs.base }}", GUARD_STRICT: "1" });
    expect(step("tests", "Typecheck (tsc --noEmit)").env!.REUSE_BASE).toBe(step("tests", "Guard (ratchets)").env!.GUARD_BASE);
  });
});
