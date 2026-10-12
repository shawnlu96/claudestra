/**
 * CI coverage proof (merge-arch-CIPROOF1): one pure verdict on whether a trusted Actions run (run → attempt → jobs → manifest
 * artifact) binds the merge subject, instead of today's name / bucket check. related never authorises a merge; only a full
 * proof does. judgeCiCoverage is the one entry for planner, inspect, mergeCandidates and the deploy tick; it only narrows the
 * prior verdict (off / observe / on). Not wired anywhere yet. docs/architecture/ci-proof.md, tests/ci-proof.test.ts.
 */
import { type CiProofManifest, type CiProofScope, type CiProofTrain, ciProofManifestDigest, parseCiProofManifest } from "./ci-proof-manifest.js";

export type CiCoverageGateMode = "off" | "observe" | "on";
const GATE_MODES: readonly CiCoverageGateMode[] = ["off", "observe", "on"];

/** What the merge is about: the caller's own facts (ledger, PR snapshot, scheduler config), never the run's. */
export interface CiProofExpect {
  repo: string;
  head: string;
  /** The head_sha the Actions API reports for the triggering event; absent = head (pull_request: the PR head). */
  runHead?: string;
  base: string;
  /** The commit and tree CI must have checked out (a PR's merge ref, or a train's combined commit). */
  checkout: { sha: string; tree: string };
  /** The approved workflow file and its version. */
  workflow: { path: string; sha: string };
  policyVersion: string;
  toolchain: { bun: string; lockfileDigest: string };
  testsUniverseDigest: string;
  requiredChecks: readonly string[];
  train?: CiProofTrain;
}

interface CiProofJob {
  name: string;
  attempt: number;
  conclusion: string | null;
  /** What the job's checkout step actually resolved; null = not read. */
  checkoutSha: string | null;
  checkoutTree: string | null;
}

/** One run as read back. `origin` says where the facts came from; only "actions-api" can prove anything. */
export interface CiRunEvidence {
  origin: "actions-api" | "check-run" | "author-json";
  repo: string;
  runId: number;
  attempt: number;
  latestAttempt: number;
  workflow: { path: string; sha: string };
  headSha: string;
  status: string;
  conclusion: string | null;
  jobs: CiProofJob[];
  artifact: { runId: number; attempt: number; digest: string; content: unknown } | null;
}

type CiProofResult =
  | { ok: true; scope: CiProofScope; mergeAuthorized: boolean; manifestDigest: string; reasons: string[] }
  | { ok: false; scope: null; mergeAuthorized: false; reasons: string[] };

/** Case-insensitive: only for repo slugs and hex SHAs / digests. Paths, versions and policy ids compare exactly. */
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The run itself: source, repo, workflow version, triggering head (not the checkout: jobs prove that), and that this is the latest attempt that finished. */
function runProblems(x: CiProofExpect, ev: CiRunEvidence): string[] {
  if (ev.origin !== "actions-api") return [`证据来源 ${ev.origin} 不受信，只认 Actions API 的 run/attempt/job/工件`];
  const out: string[] = [];
  if (!eq(ev.repo, x.repo)) out.push(`run 仓库 ${ev.repo} ≠ ${x.repo}`);
  if (ev.workflow.path !== x.workflow.path || !eq(ev.workflow.sha, x.workflow.sha)) out.push(`workflow ${ev.workflow.path}@${ev.workflow.sha.slice(0, 12)} 不是批准版本`);
  const runHead = x.runHead ?? x.head;
  if (!eq(ev.headSha, runHead)) out.push(`run head ${ev.headSha.slice(0, 12)} ≠ 触发 head ${runHead.slice(0, 12)}`);
  if (ev.attempt !== ev.latestAttempt) out.push(`attempt ${ev.attempt} 不是最新 ${ev.latestAttempt}`);
  if (ev.status !== "completed") out.push(`run 状态 ${ev.status} 未完成`);
  return out;
}

/**
 * Jobs: every required name is present in this attempt, and every job of this attempt (each same-name matrix entry and each
 * extra test shard, not only the first required match) really checked out the expected commit / tree. Unknown = mismatch.
 */
function jobProblems(x: CiProofExpect, ev: CiRunEvidence): string[] {
  const out: string[] = [];
  for (const name of x.requiredChecks) {
    const named = ev.jobs.filter((j) => j.name === name);
    if (named.some((j) => j.attempt === ev.attempt)) continue;
    out.push(named[0] ? `必需检查 ${name} 来自 attempt ${named[0].attempt}` : `必需检查 ${name} 不在 run 里`);
  }
  ev.jobs.forEach((job, i) => {
    const id = `job #${i + 1} ${job.name}`;
    if (job.attempt !== ev.attempt) return;
    if (job.checkoutSha === null || job.checkoutTree === null) out.push(`${id} 实际检出未知`);
    else if (!eq(job.checkoutSha, x.checkout.sha) || !eq(job.checkoutTree, x.checkout.tree)) out.push(`${id} 实际检出 tree 不符`);
  });
  return out;
}

/** The artifact: from this run + attempt, digest matching its content, content a valid manifest. */
function readManifest(ev: CiRunEvidence): { manifest: CiProofManifest; digest: string } | string {
  const a = ev.artifact;
  if (!a) return "run 没有证明工件";
  if (a.runId !== ev.runId || a.attempt !== ev.attempt) return `工件来自 run ${a.runId} attempt ${a.attempt}，不是本次`;
  const parsed = parseCiProofManifest(a.content);
  if (!parsed.ok) return parsed.reason;
  const digest = ciProofManifestDigest(parsed.manifest);
  if (!eq(digest, a.digest)) return "工件 digest 与内容不符";
  return { manifest: parsed.manifest, digest };
}

function trainProblems(want: CiProofTrain | undefined, m: CiProofManifest): string[] {
  if (!want) return m.train ? ["列车证明用于非列车合并"] : [];
  const got = m.train;
  if (!got) return ["缺列车绑定"];
  const out: string[] = [];
  const members = (t: CiProofTrain) => t.members.map((c) => `${c.pr}@${c.head.toLowerCase()}`).join(",");
  if (members(got) !== members(want)) out.push("列车成员或 head 不符");
  if (!eq(got.combinedTree, want.combinedTree) || !eq(got.combinedTree, m.checkout.tree)) out.push("列车组合 tree 不符");
  if (!eq(got.baseline, want.baseline)) out.push("列车基线不符");
  return out;
}

/** Every bound field of the manifest against the subject. */
function bindingProblems(x: CiProofExpect, m: CiProofManifest): string[] {
  const out: string[] = [];
  const folded: [string, string, string][] = [
    ["repo", m.repo, x.repo], ["head", m.head, x.head], ["base", m.base, x.base],
    ["checkout.sha", m.checkout.sha, x.checkout.sha], ["checkout.tree", m.checkout.tree, x.checkout.tree],
    ["workflow.sha", m.workflow.sha, x.workflow.sha],
    ["toolchain.lockfileDigest", m.toolchain.lockfileDigest, x.toolchain.lockfileDigest],
    ["tests.universeDigest", m.tests.universeDigest, x.testsUniverseDigest],
  ];
  const exact: [string, string, string][] = [
    ["workflow.path", m.workflow.path, x.workflow.path], ["policyVersion", m.policyVersion, x.policyVersion],
    ["toolchain.bun", m.toolchain.bun, x.toolchain.bun],
  ];
  for (const [field, got, want] of folded) if (!eq(got, want)) out.push(`manifest ${field} 不符`);
  for (const [field, got, want] of exact) if (got !== want) out.push(`manifest ${field} 不符`);
  return out.concat(trainProblems(x.train, m));
}

/** What a full proof needs on top of a bound one: every test, every required check, nothing skipped or cancelled. */
function fullProblems(x: CiProofExpect, m: CiProofManifest, ev: CiRunEvidence): string[] {
  const out: string[] = [];
  if (!eq(m.tests.selectedDigest, m.tests.universeDigest)) out.push("full 证明漏测试：选集 ≠ 全集");
  for (const name of x.requiredChecks) if (!m.checks.includes(name)) out.push(`full 证明漏必需检查 ${name}`);
  for (const j of ev.jobs) if (j.attempt === ev.attempt && j.conclusion !== "success") out.push(`job ${j.name} 结论 ${j.conclusion ?? "未知"}`);
  if (ev.conclusion !== "success") out.push(`run 结论 ${ev.conclusion ?? "未知"}`);
  return out;
}

/** Verifies one run against the subject. mergeAuthorized is true only for a full proof with no problem at all. */
export function verifyCiProof(x: CiProofExpect, ev: CiRunEvidence | null): CiProofResult {
  if (!ev) return { ok: false, scope: null, mergeAuthorized: false, reasons: ["没有证明"] };
  const run = runProblems(x, ev);
  if (ev.origin !== "actions-api") return { ok: false, scope: null, mergeAuthorized: false, reasons: run };
  const read = readManifest(ev);
  if (typeof read === "string") return { ok: false, scope: null, mergeAuthorized: false, reasons: [...run, read] };
  const { manifest: m, digest } = read;
  const bound = [...run, ...jobProblems(x, ev), ...bindingProblems(x, m)];
  if (bound.length) return { ok: false, scope: null, mergeAuthorized: false, reasons: bound };
  if (m.scope === "related") return { ok: true, scope: "related", mergeAuthorized: false, manifestDigest: digest, reasons: ["related 证明不授权合并"] };
  const full = fullProblems(x, m, ev);
  return { ok: true, scope: "full", mergeAuthorized: full.length === 0, manifestDigest: digest, reasons: full };
}

/** The ciCoverageGate value: absent or not one of off / observe / on reads observe. */
export function ciCoverageGateMode(raw: unknown): CiCoverageGateMode {
  return GATE_MODES.includes(raw as CiCoverageGateMode) ? raw as CiCoverageGateMode : "observe";
}

interface CiCoverageVerdict {
  mode: CiCoverageGateMode;
  allow: boolean;
  /** Why the gate denied (on) or would deny (observe); empty under off or when the proof authorises the merge. */
  reasons: string[];
  proof: CiProofResult | null;
}

/**
 * The one decision every merge path asks. `prior` is that path's own verdict (train, serial, manual, PM); the gate only ever
 * narrows it. off: prior as is, proof not read. observe: prior as is, plus the would-deny reasons. on: prior && full proof.
 */
export function judgeCiCoverage(input: { mode: CiCoverageGateMode; prior: boolean; expect: CiProofExpect; evidence: CiRunEvidence | null }): CiCoverageVerdict {
  if (input.mode === "off") return { mode: "off", allow: input.prior, reasons: [], proof: null };
  const proof = verifyCiProof(input.expect, input.evidence);
  const reasons = proof.mergeAuthorized ? [] : proof.reasons.length ? proof.reasons : ["证明不授权合并"];
  if (input.mode === "observe") return { mode: "observe", allow: input.prior, reasons, proof };
  return { mode: "on", allow: input.prior && proof.mergeAuthorized, reasons, proof };
}
