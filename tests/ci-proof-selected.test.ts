/**
 * merge-arch-CISEL1 [验收线 4]: a coverage proof with shards released by receipt. The producer (scripts/ci-proof-artifact.ts) folds
 * the receipts into a versioned section whose digest it appends to policyVersion, keeping the covered-universe evidence; the
 * verifier (src/lib/ci-proof.ts) accepts such a proof only with that section matching digest, run, attempt and checkout. A proof
 * with no release is what it was (tests/ci-proof*.test.ts unchanged).
 */
import { describe, expect, test } from "bun:test";
import {
  CI_PROOF_POLICY_VERSION, PROOF_JOBS, buildCiProof, proofRun, sha256, shardFacts, WEB_BUILD_JOB, type ProofInput,
} from "../scripts/ci-proof-artifact.ts";
import { shardReceipt } from "../scripts/ci-selected-verdict.ts";
import { planShards } from "../scripts/ci-test-shard.ts";
import { type CiProofExpect, type CiRunEvidence, verifyCiProof } from "../src/lib/ci-proof.js";
import { responsibility, SELECTED_SECTION_VERSION, sectionDigest, type SelectedSection } from "../src/lib/ci-selected-verdict.js";

const sha = (c: string) => c.repeat(40);
const files = Array.from({ length: 23 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
const SHA = sha("a"), BUN = "1.3.14", LOCK = "lockfile v1\n";
const ENV = {
  GITHUB_REPOSITORY: "shawnlu96/claudestra", GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: "shawnlu96/claudestra/.github/workflows/ci.yml@refs/pull/7/merge", GITHUB_WORKFLOW_SHA: sha("5"),
};
const CORE_OK = { JOB_STATUS: "success", CORE_TYPECHECK: "success", CORE_GUARD: "success", CORE_BUILD: "success" };
const plan = planShards(files, 8);
/** Shard k's log; `red` makes its first file fail the way bun reports it (a released shard still ends green). */
const logOf = (k: number, red = false) => [`shard=${k}/8`, `head=${SHA}`, `discovered=${files.length}`, `bun test v${BUN} (0d9b296a)`, "",
  ...plan[k - 1]!.flatMap((f, i) => [`::group::${f}:`, red && i === 0 ? "(fail) flaky under load [5001.00ms]" : "(pass) ok [1.00ms]", "::endgroup::"]),
  " 9 pass", ` ${red ? 1 : 0} fail`, `Ran 10 tests across ${plan[k - 1]!.length} files. [1.00s]`].join("\n");
const RESP = responsibility(["tests/mine.test.ts"]);
const PLAN_TEXT = JSON.stringify({ responsibility: RESP });
const PLAN_DIGEST = `sha256:${new Bun.CryptoHasher("sha256").update(PLAN_TEXT).digest("hex")}`;
const receiptFor = (k: number, over: { attempt?: number; mode?: "on" | "observe" } = {}) => shardReceipt({ mode: over.mode ?? "on", shard: k, exitCode: 1,
  log: logOf(k, true), assigned: plan[k - 1]!.map((f) => `./${f}`), planText: PLAN_TEXT, planDigest: PLAN_DIGEST, changed: ["src/lib/mine.ts"],
  typecheck: k === 1 ? "success" : "skipped", run: { runId: 900, attempt: over.attempt ?? 2, head: SHA } });

/** Eight green shards from this attempt; `released` shards are red in the log, green as jobs, with the given receipt in their facts. */
function input(released: Record<number, unknown> = {}): ProofInput {
  const red = (k: number) => k in released;
  const shardLogs = new Map([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [`test-shard-${k}`, logOf(k, red(k))]));
  const facts = new Map<string, unknown>([1, 2, 3, 4, 5, 6, 7, 8].map((k) =>
    [`ci-facts-shard-${k}`, shardFacts({ ...ENV, ...CORE_OK }, k, logOf(k, red(k)), released[k])]));
  facts.set("ci-facts-web-build", { version: 1, job: WEB_BUILD_JOB, runId: 900, attempt: 2, head: SHA, status: "success",
    webBuild: { mode: "observe", outcome: "success", seconds: 41, depsCacheHit: false } });
  return { run: proofRun(ENV, { pull_request: { head: { sha: sha("1") }, base: { sha: sha("2") } } }), checkout: { sha: SHA, tree: sha("4") }, bunVersion: BUN,
    lockfile: LOCK, files, needs: { tests: "success", check: "success", web: "success", desktop: "success", [WEB_BUILD_JOB]: "success" }, shardLogs, facts,
    webBuildMode: "observe" };
}

const OMIT = Symbol("no section read");
function verify(i: ProofInput, selected: unknown = "from-proof") {
  const { manifest, report, selected: section } = buildCiProof(i);
  const subject: CiProofExpect = { repo: manifest!.repo, head: sha("1"), base: sha("2"), checkout: { sha: SHA, tree: sha("4") }, workflow: manifest!.workflow,
    policyVersion: CI_PROOF_POLICY_VERSION, toolchain: manifest!.toolchain, testsUniverseDigest: sha256(files.join("\n")),
    requiredChecks: ["typecheck + test + guard", "web typecheck + lint"] };
  const jobs = [...Object.values(PROOF_JOBS).flat(), "web production build"].map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: SHA,
    checkoutTree: sha("4") }));
  const evidence: CiRunEvidence = { origin: "actions-api", repo: manifest!.repo, runId: 900, attempt: 2, latestAttempt: 2, workflow: manifest!.workflow,
    headSha: sha("1"), status: "completed", conclusion: "success", jobs, artifact: { runId: 900, attempt: 2, digest: report.manifestDigest!, content: manifest },
    ...(selected === OMIT ? {} : { selected: selected === "from-proof" ? JSON.parse(JSON.stringify(section)) : selected }) };
  return verifyCiProof(subject, evidence);
}

describe("[验收线 4] a released proof carries its receipts, and is invalid without them", () => {
  test("producer: the released shard's receipt becomes a versioned section; its digest suffixes policyVersion; coverage evidence stays", () => {
    const { manifest, report, selected } = buildCiProof(input({ 3: receiptFor(3) }));
    expect(report.refusals).toEqual([]);
    expect(selected).toMatchObject({ version: SELECTED_SECTION_VERSION, runId: 900, attempt: 2, head: SHA, responsibilityDigest: RESP.digest,
      receipts: [{ shard: 3, receipt: { applied: true, outOfScope: [{ file: plan[2]![0]!, name: "flaky under load" }] } }] });
    expect(manifest!.policyVersion).toBe(`${CI_PROOF_POLICY_VERSION}+${SELECTED_SECTION_VERSION}:${sectionDigest(selected!)}`);
    expect(report.selected).toEqual({ version: SELECTED_SECTION_VERSION, digest: sectionDigest(selected!) });
    expect(manifest!.tests.selectedDigest).toBe(manifest!.tests.universeDigest);
    expect(verify(input({ 3: receiptFor(3) }))).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true });
  });

  test("verifier: the section missing, a receipt altered, or a section of another attempt / checkout is an invalid proof", () => {
    const i = input({ 3: receiptFor(3) }), section = buildCiProof(i).selected! as SelectedSection;
    expect(verify(i, OMIT)).toMatchObject({ ok: false, mergeAuthorized: false, reasons: expect.arrayContaining(["带放行的证明缺放行回执一节"]) });
    const altered = structuredClone(section);
    altered.receipts[0]!.receipt.outOfScope = [{ file: "tests/mine.test.ts", name: "x" }];
    expect(verify(i, altered).ok).toBe(false);
    expect(verify(i, { ...section, attempt: 1 }).reasons.join()).toContain("digest");
    expect(verify(i, { ...section, receipts: [] }).ok).toBe(false);
  });

  test("a section whose content was re-digested to match still has to bind the run, attempt and checkout", () => {
    const section = buildCiProof(input({ 3: receiptFor(3) })).selected!;
    const other = { ...section, attempt: 1 };
    // a forged manifest would need this digest in its policyVersion; the attempt check then refuses it on its own
    expect(verify(input({ 3: receiptFor(3) }), other).reasons).toEqual(expect.arrayContaining(["放行一节的 digest 与证明记的不符",
      "放行一节来自 run 900 attempt 1，不是本次"]));
  });

  test("producer: a shard red in its log but green as a job with no receipt, or a receipt of another attempt / not applied, writes no proof", () => {
    const none = buildCiProof(input({ 3: undefined }));
    expect([none.manifest, none.report.refusals]).toEqual([null, ["第 3 片走了放行却缺回执 ci-selected-shard-3"]]);
    expect(buildCiProof(input({ 3: receiptFor(3, { attempt: 1 }) })).report.refusals.join()).toContain("不是本次 run 900 attempt 2");
    expect(buildCiProof(input({ 3: receiptFor(3, { mode: "observe" }) })).report.refusals.join()).toContain("没有放行");
  });

  test("no release: the proof is what it was — exact policyVersion, no section, no report field, and a stray section is ignored", () => {
    const { manifest, report, selected } = buildCiProof(input());
    expect([manifest!.policyVersion, selected, "selected" in report]).toEqual([CI_PROOF_POLICY_VERSION, null, false]);
    expect(Object.keys(shardFacts({ ...ENV, ...CORE_OK }, 2, logOf(2)))).not.toContain("selected");
    expect(verify(input(), OMIT)).toMatchObject({ ok: true, mergeAuthorized: true });
    expect(verify(input(), { junk: true })).toMatchObject({ ok: true, mergeAuthorized: true });
  });
});
