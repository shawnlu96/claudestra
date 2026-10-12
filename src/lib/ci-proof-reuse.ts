/**
 * CI proof reuse (merge-arch-REUSE1): skip a deterministic static check or build only when a trusted earlier run already passed
 * it on exactly the same inputs. Pure: the key, the strict record / receipt formats and the one verdict both sides ask
 * (scripts/ci-proof-reuse.ts in CI, lib/ci-proof.ts on the merge side). off: no lookup. observe (default): look up, still run,
 * record the would-be hit. on: a verified hit skips the run and leaves a receipt naming the original run. Tests, guard and
 * anything time / host sensitive are not in CI_REUSE_CHECKS and never reuse. tests/ci-proof-reuse.test.ts.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";

export type CiProofReuseMode = "off" | "observe" | "on";
const MODES: readonly CiProofReuseMode[] = ["off", "observe", "on"];

/**
 * The CI_PROOF_REUSE value, read the way ci.yml's expression normalises it (`vars.CI_PROOF_REUSE == 'on'`): letter case is
 * ignored, nothing is trimmed. Absent or anything else reads observe.
 */
export function ciProofReuseMode(raw: unknown): CiProofReuseMode {
  const v = typeof raw === "string" ? raw.toLowerCase() : raw;
  return MODES.includes(v as CiProofReuseMode) ? v as CiProofReuseMode : "observe";
}

/** The merge side's switch: the recovery key ciProofReuse (absent = observe; an unreadable policy file answers off). */
export const ciProofReusePolicyMode = (project: string, policy: RecoveryPolicyPort): CiProofReuseMode => policy(project, "ciProofReuse").mode;

/** Bumping this voids every earlier record at once: the version is part of the key. */
export const CI_PROOF_REUSE_POLICY = "ci-reuse-1";
export const CI_PROOF_REUSE_WORKFLOW = ".github/workflows/ci.yml";
/** The per-run artifact holding this run's receipts (one file per reused check). */
export const CI_PROOF_REUSE_ARTIFACT = "ci-proof-reuse";
/** The marker file in that artifact: the run / attempt that wrote it. */
export const CI_PROOF_REUSE_RUN_FILE = "run.json";
/** The one file of an original run's record artifact. */
export const CI_REUSE_RECORD_FILE = "record.json";
export const CI_REUSE_LOCKFILES: readonly string[] = ["bun.lock", "web/package-lock.json"];
export const CI_REUSE_GUARD_BASELINE = "scripts/guard/baseline.json";
/** Only runs GitHub started for this repository's own refs; a dispatch run's checkout cannot be tied to its head_sha, so it is out. */
const TRUSTED_EVENTS: readonly string[] = ["push", "pull_request"];
const BUILD_ENTRIES = ["bridge", "channel-server", "manager", "launcher", "cron", "setup", "relay", "scheduler"] as const;

export interface CiReuseCheck {
  /** The GitHub job and step that run the check; the original run must show both as success. */
  job: string;
  step: string;
  /** What the step runs, in order; the first non-zero exit stops it. */
  commands: readonly (readonly string[])[];
  scope: string;
  /** Generated (untracked) files the check reads; each must be in the key with its digest. */
  generated: readonly string[];
}

/** First phase: the two deterministic steps of shard 1. A check that is not listed here is never reused. */
export const CI_REUSE_CHECKS: Readonly<Record<string, CiReuseCheck>> = {
  typecheck: { job: "test shard 1 of 8", step: "Typecheck (tsc --noEmit)", commands: [["bun", "run", "typecheck"]], scope: "repo", generated: [] },
  build: {
    job: "test shard 1 of 8", step: "Build entrypoints", scope: "entrypoints", generated: [],
    commands: BUILD_ENTRIES.map((e) => ["bun", "build", `src/${e}.ts`, "--target=bun", "--outdir=/tmp/ci-build"]),
  },
};

export const ciReuseDigest = (data: string | Uint8Array): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
export const ciReuseCommandDigest = (check: CiReuseCheck): string => ciReuseDigest(canonicalJson(check.commands));

interface FileDigest { path: string; digest: string }

/** Everything the result depends on. Two runs may share a result only when all of it is equal. */
export interface CiReuseInputs {
  policy: string;
  repo: string;
  /** The tree the check ran on (the checkout's, not the PR head's). */
  tree: string;
  base: string;
  guardBaseline: string;
  workflow: { path: string; digest: string };
  check: { id: string; scope: string; command: string };
  toolchain: { bun: string; node: string };
  lockfiles: FileDigest[];
  platform: { os: string; arch: string; image: string };
  generated: FileDigest[];
}

export interface CiReuseRecord {
  version: 1;
  kind: "record";
  key: string;
  inputs: CiReuseInputs;
  /** The run that really executed the check, and the commit its job had checked out. */
  run: { runId: number; attempt: number; checkout: string };
  seconds: number;
}

export interface CiReuseReceipt {
  version: 1;
  kind: "receipt";
  key: string;
  inputs: CiReuseInputs;
  /** The run that skipped the check. */
  run: { runId: number; attempt: number };
  origin: { runId: number; attempt: number; job: string; step: string; checkout: string; artifact: { id: number; name: string; digest: string }; seconds: number };
}

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re?: RegExp): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && (!re || re.test(v));
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
/** An object with exactly these keys: an unknown or missing field never parses. */
const exact = (v: unknown, keys: readonly string[]): v is Obj => isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
const files = (v: unknown): v is FileDigest[] => Array.isArray(v) && v.length <= 16 && v.every((f) => exact(f, ["path", "digest"]) && str(f.path) && str(f.digest, DIGEST));
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const INPUT_KEYS = ["policy", "repo", "tree", "base", "guardBaseline", "workflow", "check", "toolchain", "lockfiles", "platform", "generated"];

/** Strict parse of a key's inputs; a string is the reason it is not one. */
function parseInputs(raw: unknown): CiReuseInputs | string {
  if (!exact(raw, INPUT_KEYS)) return "inputs 字段不全或有未知字段";
  if (!str(raw.policy) || !str(raw.repo, REPO) || !str(raw.tree, SHA) || !str(raw.base, SHA) || !str(raw.guardBaseline, DIGEST)) return "inputs 的 policy/repo/tree/base/guardBaseline 非法";
  const { workflow: w, check: c, toolchain: t, platform: p } = raw;
  if (!exact(w, ["path", "digest"]) || !str(w.path) || !str(w.digest, DIGEST)) return "inputs.workflow 非法";
  if (!exact(c, ["id", "scope", "command"]) || !str(c.id) || !str(c.scope) || !str(c.command, DIGEST)) return "inputs.check 非法";
  if (!exact(t, ["bun", "node"]) || !str(t.bun) || !str(t.node)) return "inputs.toolchain 非法";
  if (!exact(p, ["os", "arch", "image"]) || !str(p.os) || !str(p.arch) || !str(p.image)) return "inputs.platform 非法";
  if (!files(raw.lockfiles) || !files(raw.generated)) return "inputs.lockfiles/generated 非法";
  const file = (f: FileDigest): FileDigest => ({ path: f.path, digest: f.digest });
  return {
    policy: raw.policy, repo: raw.repo, tree: raw.tree, base: raw.base, guardBaseline: raw.guardBaseline, workflow: { path: w.path, digest: w.digest },
    check: { id: c.id, scope: c.scope, command: c.command }, toolchain: { bun: t.bun, node: t.node }, lockfiles: raw.lockfiles.map(file),
    platform: { os: p.os, arch: p.arch, image: p.image }, generated: raw.generated.map(file),
  };
}

/** `sha256:<hex>` of the canonical inputs: equal keys mean every listed input is equal. */
export const ciReuseKey = (inputs: CiReuseInputs): string => ciReuseDigest(canonicalJson(inputs));
/** The original run's artifact name: the lookup lists artifacts by it, so the whole key is in the name. */
export const ciReuseArtifactName = (inputs: CiReuseInputs): string => `ci-reuse-${inputs.check.id}-${ciReuseKey(inputs).slice("sha256:".length)}`;

/** Which top-level inputs differ (for the log; the decision itself compares keys). */
export function ciReuseInputDiff(a: CiReuseInputs, b: CiReuseInputs): string[] {
  return INPUT_KEYS.filter((k) => canonicalJson(a[k as keyof CiReuseInputs]) !== canonicalJson(b[k as keyof CiReuseInputs]));
}

/** Whether these inputs describe an approved check under the current policy; reasons when not. */
export function ciReuseInputProblems(inputs: CiReuseInputs): string[] {
  const def = Object.hasOwn(CI_REUSE_CHECKS, inputs.check.id) ? CI_REUSE_CHECKS[inputs.check.id]! : null;
  if (!def) return [`检查 ${inputs.check.id} 不在首期批准的复用范围（测试、guard、时间 / 宿主敏感检查一律实际执行）`];
  const out: string[] = [];
  if (inputs.policy !== CI_PROOF_REUSE_POLICY) out.push(`复用策略 ${inputs.policy} 不是现行 ${CI_PROOF_REUSE_POLICY}`);
  if (inputs.workflow.path !== CI_PROOF_REUSE_WORKFLOW) out.push(`workflow ${inputs.workflow.path} 不是 ${CI_PROOF_REUSE_WORKFLOW}`);
  if (inputs.check.scope !== def.scope || inputs.check.command !== ciReuseCommandDigest(def)) out.push(`检查 ${inputs.check.id} 的范围或命令不是批准的那份`);
  const paths = (list: FileDigest[]) => list.map((f) => f.path).join(",");
  if (paths(inputs.lockfiles) !== CI_REUSE_LOCKFILES.join(",")) out.push(`锁文件清单须恰为 ${CI_REUSE_LOCKFILES.join(" / ")}`);
  if (paths(inputs.generated) !== def.generated.join(",")) out.push(`检查 ${inputs.check.id} 的生成输入不全`);
  return out;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Strict parse of an original run's record (already JSON-decoded). Never throws. */
export function parseCiReuseRecord(raw: unknown): Parsed<CiReuseRecord> {
  if (!exact(raw, ["version", "kind", "key", "inputs", "run", "seconds"]) || raw.version !== 1 || raw.kind !== "record") return bad("不是版本 1 的复用记录");
  const inputs = parseInputs(raw.inputs), r = raw.run;
  if (typeof inputs === "string") return bad(inputs);
  if (!str(raw.key, DIGEST) || !exact(r, ["runId", "attempt", "checkout"]) || !posInt(r.runId) || !posInt(r.attempt) || !str(r.checkout, SHA)) return bad("记录的 key / run 非法");
  if (typeof raw.seconds !== "number" || !(raw.seconds >= 0)) return bad("记录的 seconds 非法");
  return { ok: true, value: { version: 1, kind: "record", key: raw.key, inputs, run: { runId: r.runId, attempt: r.attempt, checkout: r.checkout }, seconds: raw.seconds } };
}

/** Strict parse of a receipt (already JSON-decoded). Never throws. */
export function parseCiReuseReceipt(raw: unknown): Parsed<CiReuseReceipt> {
  if (!exact(raw, ["version", "kind", "key", "inputs", "run", "origin"]) || raw.version !== 1 || raw.kind !== "receipt") return bad("不是版本 1 的复用回执");
  const inputs = parseInputs(raw.inputs), r = raw.run, o = raw.origin;
  if (typeof inputs === "string") return bad(inputs);
  if (!str(raw.key, DIGEST) || !exact(r, ["runId", "attempt"]) || !posInt(r.runId) || !posInt(r.attempt)) return bad("回执的 key / run 非法");
  if (!exact(o, ["runId", "attempt", "job", "step", "checkout", "artifact", "seconds"]) || !posInt(o.runId) || !posInt(o.attempt) || !str(o.job) || !str(o.step)
    || !str(o.checkout, SHA) || typeof o.seconds !== "number" || !(o.seconds >= 0)) return bad("回执的 origin 非法");
  const a = o.artifact;
  if (!exact(a, ["id", "name", "digest"]) || !posInt(a.id) || !str(a.name) || !str(a.digest, DIGEST)) return bad("回执的 origin.artifact 非法");
  return { ok: true, value: { version: 1, kind: "receipt", key: raw.key, inputs, run: { runId: r.runId, attempt: r.attempt },
    origin: { runId: o.runId, attempt: o.attempt, job: o.job, step: o.step, checkout: o.checkout, artifact: { id: a.id, name: a.name, digest: a.digest }, seconds: o.seconds } } };
}

/** One candidate original run as read back. `source` says where the facts came from; only "actions-api" can back a reuse. */
export interface CiReuseOrigin {
  source: "actions-api" | "check-run" | "author-json";
  repo: string;
  /** The repository the run's head lives in; a fork (or unknown) is not trusted. */
  headRepo: string | null;
  runId: number;
  workflowPath: string;
  event: string;
  headSha: string;
  /** The attempt whose job was read: the one the record names. */
  attempt: number;
  job: { name: string; conclusion: string | null; steps: { name: string; conclusion: string | null }[] } | null;
  /** digest: what the API reports for the stored archive; contentDigest: computed over the bytes actually downloaded. */
  artifact: { id: number; name: string; runId: number; expired: boolean; digest: string | null; contentDigest: string | null; record: unknown } | null;
  /** The commit the record says the job checked out, read back from the repository. */
  commit: { sha: string; tree: string; parents: string[] } | null;
}

function runTrustProblems(inputs: CiReuseInputs, ev: CiReuseOrigin, opts: { revokedRuns?: readonly number[]; selfRunId?: number }): string[] {
  const out: string[] = [];
  if (!eq(ev.repo, inputs.repo)) out.push(`原 run 仓库 ${ev.repo} ≠ ${inputs.repo}`);
  if (ev.headRepo === null || !eq(ev.headRepo, inputs.repo)) out.push(`原 run 的 head 仓库 ${ev.headRepo ?? "未知"} 不是本仓库（fork 不受信）`);
  if (ev.workflowPath !== CI_PROOF_REUSE_WORKFLOW) out.push(`原 run 的 workflow ${ev.workflowPath} 不是 ${CI_PROOF_REUSE_WORKFLOW}`);
  if (!TRUSTED_EVENTS.includes(ev.event)) out.push(`原 run 的事件 ${ev.event} 不在受信范围（${TRUSTED_EVENTS.join(" / ")}）`);
  if (opts.revokedRuns?.includes(ev.runId)) out.push(`原 run ${ev.runId} 已撤销`);
  if (ev.runId === opts.selfRunId) out.push("不能复用本次运行自己的结果");
  return out;
}

/** The artifact is this run's, alive, intact, and its record is the same key built from the same inputs. */
function artifactProblems(inputs: CiReuseInputs, ev: CiReuseOrigin): { record: CiReuseRecord | null; problems: string[] } {
  const a = ev.artifact;
  if (!a) return { record: null, problems: ["原 run 没有复用记录工件"] };
  const out: string[] = [];
  if (a.runId !== ev.runId) out.push(`工件属于 run ${a.runId}，不是原 run ${ev.runId}`);
  if (a.expired) out.push("原工件已过期");
  if (a.name !== ciReuseArtifactName(inputs)) out.push("工件名不是这份输入的 key");
  if (a.digest === null || a.contentDigest === null || !eq(a.digest, a.contentDigest)) out.push("工件不完整：下载内容的摘要与登记的不符或缺失");
  const parsed = parseCiReuseRecord(a.record);
  if (!parsed.ok) return { record: null, problems: [...out, `工件内容${parsed.reason}`] };
  const rec = parsed.value, key = ciReuseKey(inputs);
  const diff = ciReuseInputDiff(rec.inputs, inputs);
  if (diff.length) out.push(`输入不同：${diff.join(", ")}`);
  if (rec.key !== key || ciReuseKey(rec.inputs) !== key) out.push("记录的 key 与输入不符");
  if (rec.run.runId !== ev.runId || rec.run.attempt !== ev.attempt) out.push(`记录来自 run ${rec.run.runId} attempt ${rec.run.attempt}，读回的是 run ${ev.runId} attempt ${ev.attempt}`);
  return { record: rec, problems: out };
}

/** The check really finished success there, on a commit of this tree that the run's own head accounts for. */
function executionProblems(inputs: CiReuseInputs, ev: CiReuseOrigin, rec: CiReuseRecord | null): string[] {
  const def = CI_REUSE_CHECKS[inputs.check.id]!, out: string[] = [];
  if (!ev.job || ev.job.name !== def.job) out.push(`原 run attempt ${ev.attempt} 里没有作业 ${def.job}`);
  else {
    if (ev.job.conclusion !== "success") out.push(`原作业结论 ${ev.job.conclusion ?? "未知"}，不是 success`);
    const step = ev.job.steps.find((s) => s.name === def.step);
    if (step?.conclusion !== "success") out.push(`原步骤 ${def.step} 结论 ${step ? step.conclusion ?? "未知" : "缺失"}，不是 success`);
  }
  const c = ev.commit;
  if (!c || !rec || !eq(c.sha, rec.run.checkout)) return [...out, "原检出提交读不回"];
  if (!eq(c.tree, inputs.tree)) out.push("原检出的 tree 不是这份输入的 tree");
  const tied = ev.event === "pull_request" ? c.parents.length === 2 && eq(c.parents[1]!, ev.headSha) : eq(c.sha, ev.headSha);
  if (!tied) out.push("原检出提交与原 run 的 head 对不上");
  return out;
}

type CiReuseVerdict = { ok: true; record: CiReuseRecord; reasons: [] } | { ok: false; record: null; reasons: string[] };

/**
 * Whether one original run may stand in for running `inputs` now. Every miss is a reason and the answer is then "run it":
 * untrusted source / repo / fork / event, revoked, expired or tampered artifact, any input difference, a non-success job or
 * step, a checkout that is not this tree. Failed, cancelled and skipped results are never reusable.
 */
export function verifyCiReuseOrigin(inputs: CiReuseInputs, ev: CiReuseOrigin | null, opts: { revokedRuns?: readonly number[]; selfRunId?: number } = {}): CiReuseVerdict {
  const no = (reasons: string[]): CiReuseVerdict => ({ ok: false, record: null, reasons });
  if (!ev) return no(["没有候选的原 run"]);
  if (ev.source !== "actions-api") return no([`证据来源 ${ev.source} 不受信，只认 Actions API 读回的 run / job / 工件`]);
  const input = ciReuseInputProblems(inputs);
  if (input.length) return no(input);
  const art = artifactProblems(inputs, ev);
  const reasons = [...runTrustProblems(inputs, ev, opts), ...art.problems, ...executionProblems(inputs, ev, art.record)];
  return reasons.length || !art.record ? no(reasons.length ? reasons : ["记录读不出"]) : { ok: true, record: art.record, reasons: [] };
}

export interface CiReuseDecision {
  mode: CiProofReuseMode;
  /** Whether the check must really run now. Only on + a verified hit answers false. */
  execute: boolean;
  /** A verified hit: what on reuses and observe only records. */
  candidate: boolean;
  /** Why there is no hit (empty under off or on a hit). */
  reasons: string[];
  /** on + hit: what the skipping run publishes. */
  receipt: CiReuseReceipt | null;
}

/**
 * The CI side's one decision. off never reads the evidence. inputs null = this run could not establish its own inputs, which
 * is a miss like any other. A miss, whatever the cause (no candidate, download failed, expired, changed config), executes.
 */
export function decideCiReuse(input: { mode: CiProofReuseMode; inputs: CiReuseInputs | null; evidence: CiReuseOrigin | null;
  run: { runId: number; attempt: number }; revokedRuns?: readonly number[] }): CiReuseDecision {
  const { mode, inputs, evidence: ev } = input;
  if (mode === "off") return { mode, execute: true, candidate: false, reasons: [], receipt: null };
  if (!inputs) return { mode, execute: true, candidate: false, reasons: ["本次运行的输入没算出来"], receipt: null };
  const v = verifyCiReuseOrigin(inputs, ev, { revokedRuns: input.revokedRuns, selfRunId: input.run.runId });
  if (!v.ok || !ev?.artifact?.digest) return { mode, execute: true, candidate: false, reasons: v.reasons, receipt: null };
  if (mode === "observe") return { mode, execute: true, candidate: true, reasons: [], receipt: null };
  const def = CI_REUSE_CHECKS[inputs.check.id]!, a = ev.artifact;
  const receipt: CiReuseReceipt = { version: 1, kind: "receipt", key: v.record.key, inputs, run: { runId: input.run.runId, attempt: input.run.attempt },
    origin: { runId: ev.runId, attempt: ev.attempt, job: def.job, step: def.step, checkout: v.record.run.checkout,
      artifact: { id: a.id, name: a.name, digest: ev.artifact.digest }, seconds: v.record.seconds } };
  return { mode, execute: false, candidate: true, reasons: [], receipt };
}

/** What a receipt must be bound to: the verifier's own facts about the run it is judging. Optional fields are compared when known. */
export interface CiReuseSubject {
  repo: string;
  base: string;
  tree: string;
  bun: string;
  /** Digest of bun.lock. */
  lockfileDigest: string;
  workflowDigest?: string;
  guardBaseline?: string;
}

function subjectProblems(s: CiReuseSubject, i: CiReuseInputs): string[] {
  const pairs: [string, string, string | undefined][] = [
    ["repo", i.repo, s.repo], ["base", i.base, s.base], ["tree", i.tree, s.tree], ["toolchain.bun", i.toolchain.bun, s.bun],
    ["bun.lock", i.lockfiles.find((f) => f.path === "bun.lock")?.digest ?? "", s.lockfileDigest],
    ["workflow.digest", i.workflow.digest, s.workflowDigest], ["guardBaseline", i.guardBaseline, s.guardBaseline],
  ];
  return pairs.filter(([, got, want]) => want !== undefined && !eq(got, want)).map(([field]) => `回执 ${field} 与被核对象不符`);
}

/** The receipts one run published, with each original run read back again by whoever verifies. */
export interface CiRunReuse {
  artifact: { runId: number; attempt: number; receipts: unknown[] };
  origins: CiReuseOrigin[];
  /** The verifier's own revocation list (repo variable CI_PROOF_REUSE_REVOKED). */
  revokedRuns?: readonly number[];
  /** What the reader could not read back (readCiRunReuse). Each entry is a problem: unread evidence never counts as "reused nothing". */
  unread?: readonly string[];
}

/**
 * One receipt against the run that published it, the subject and the verifier's revocation list: no API needed. A revoked
 * original run is a local fact, so it refuses here, whether or not that run can be read back. `id` labels its problems.
 */
export function ciReuseReceiptProblems(subject: CiReuseSubject, run: { runId: number; attempt: number }, raw: unknown, revokedRuns: readonly number[] = []):
  { receipt: CiReuseReceipt | null; id: string; problems: string[] } {
  const p = parseCiReuseReceipt(raw);
  if (!p.ok) return { receipt: null, id: "复用回执", problems: [`复用回执${p.reason}`] };
  const r = p.value, id = `复用 ${r.inputs.check.id}`, out: string[] = [];
  if (r.run.runId !== run.runId || r.run.attempt !== run.attempt) out.push(`${id} 的回执属于 run ${r.run.runId} attempt ${r.run.attempt}`);
  if (r.key !== ciReuseKey(r.inputs)) out.push(`${id} 的 key 与输入不符`);
  out.push(...[...ciReuseInputProblems(r.inputs), ...subjectProblems(subject, r.inputs)].map((m) => `${id}：${m}`));
  if (revokedRuns.includes(r.origin.runId)) out.push(`${id}：原 run ${r.origin.runId} 已撤销`);
  return { receipt: r, id, problems: out };
}

/**
 * Re-verification of a run's receipts (the proof verifier and the CI gate both call this). null / undefined = the run reused
 * nothing; evidence the reader could not read back (`unread`) is a problem, never that. Each receipt must belong to this run + attempt, bind the subject, name an approved check once, and its original
 * run must pass verifyCiReuseOrigin again on evidence read now. A receipt never widens what the run covered: it stands for
 * its one static check, not for tests or guard, and it leaves the proof's scope (related / full) as it is.
 */
export function ciProofReuseProblems(subject: CiReuseSubject, run: { runId: number; attempt: number }, reuse: CiRunReuse | null | undefined): string[] {
  if (!reuse) return [];
  const a = reuse.artifact, out: string[] = [...(reuse.unread ?? [])], seen = new Set<string>();
  if (a.runId !== run.runId || a.attempt !== run.attempt) return [...out, `复用回执来自 run ${a.runId} attempt ${a.attempt}，不是本次`];
  for (const raw of a.receipts) {
    const { receipt: r, id, problems } = ciReuseReceiptProblems(subject, run, raw, reuse.revokedRuns);
    out.push(...problems);
    if (!r) continue;
    if (seen.has(r.inputs.check.id)) out.push(`${id} 有多份回执`);
    seen.add(r.inputs.check.id);
    const origin = reuse.origins.find((o) => o.runId === r.origin.runId && o.attempt === r.origin.attempt) ?? null;
    const v = verifyCiReuseOrigin(r.inputs, origin, { revokedRuns: reuse.revokedRuns, selfRunId: run.runId });
    if (!v.ok) { out.push(...v.reasons.filter((m) => !problems.includes(`${id}：${m}`)).map((m) => `${id}：${m}`)); continue; }
    const art = origin!.artifact!;
    if (art.id !== r.origin.artifact.id || !eq(art.digest ?? "", r.origin.artifact.digest) || !eq(v.record.run.checkout, r.origin.checkout)) out.push(`${id} 的回执与读回的原 run 不是同一份工件`);
  }
  return out;
}

/** Read-only Actions API access, injected: the CI scripts pass a GitHub client, tests a fake. Every method throws when it cannot answer. */
export interface CiReuseApi {
  /** The JSON of GET <api><path>. */
  api(path: string): Promise<unknown>;
  /** An artifact's archive bytes. */
  download(artifactId: number): Promise<Uint8Array>;
  /** The file names inside an archive. */
  entries(zip: Uint8Array): Promise<string[]>;
  /** The text of one file inside an archive. */
  unzip(zip: Uint8Array, file: string): Promise<string>;
}

const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
export interface CiReuseArtifactRow { id: number; name: string; runId: number; expired: boolean; digest: string | null }
export const ciReuseArtifactRow = (v: unknown): CiReuseArtifactRow => {
  const a = obj(v);
  return { id: Number(a.id), name: text(a.name), runId: Number(obj(a.workflow_run).id), expired: a.expired === true, digest: text(a.digest) || null };
};

/** One artifact's original run as evidence: the archive, the run, the job and steps of the attempt the record names, and the commit it names, all read back. */
export async function readCiReuseOrigin(inputs: CiReuseInputs, row: CiReuseArtifactRow, deps: CiReuseApi): Promise<CiReuseOrigin> {
  const repo = `/repos/${inputs.repo}`, def = Object.hasOwn(CI_REUSE_CHECKS, inputs.check.id) ? CI_REUSE_CHECKS[inputs.check.id] : undefined;
  const run = obj(await deps.api(`${repo}/actions/runs/${row.runId}`));
  const ev: CiReuseOrigin = {
    source: "actions-api", repo: text(obj(run.repository).full_name), headRepo: text(obj(run.head_repository).full_name) || null, runId: row.runId,
    workflowPath: text(run.path).split("@")[0]!, event: text(run.event), headSha: text(run.head_sha), attempt: 0, job: null,
    artifact: { ...row, contentDigest: null, record: null }, commit: null,
  };
  if (row.expired) return ev;
  const zip = await deps.download(row.id);
  let record: unknown = null;
  try { record = JSON.parse(await deps.unzip(zip, CI_REUSE_RECORD_FILE)); } catch { /* an archive that does not open or is not JSON: record stays null and is refused */ }
  ev.artifact = { ...row, contentDigest: ciReuseDigest(zip), record };
  const parsed = parseCiReuseRecord(record);
  if (!parsed.ok || !def) return ev;
  ev.attempt = parsed.value.run.attempt;
  const jobs = obj(await deps.api(`${repo}/actions/runs/${row.runId}/attempts/${ev.attempt}/jobs?per_page=100`)).jobs;
  const job = (Array.isArray(jobs) ? jobs : []).map(obj).find((j) => j.name === def.job);
  if (job) {
    const steps = (Array.isArray(job.steps) ? job.steps : []).map(obj).map((s) => ({ name: text(s.name), conclusion: text(s.conclusion) || null }));
    ev.job = { name: def.job, conclusion: text(job.conclusion) || null, steps };
  }
  const c = obj(await deps.api(`${repo}/git/commits/${parsed.value.run.checkout}`));
  ev.commit = { sha: text(c.sha), tree: text(obj(c.tree).sha), parents: (Array.isArray(c.parents) ? c.parents : []).map((p) => text(obj(p).sha)) };
  return ev;
}

/** The original run a receipt points at, by artifact id (never by name: a same-name artifact of another run cannot stand in). */
export async function readCiReuseReceiptOrigin(r: CiReuseReceipt, deps: CiReuseApi): Promise<CiReuseOrigin> {
  const row = ciReuseArtifactRow(await deps.api(`/repos/${r.inputs.repo}/actions/artifacts/${r.origin.artifact.id}`));
  return readCiReuseOrigin(r.inputs, { ...row, id: r.origin.artifact.id }, deps);
}

/** The receipts in one run's ci-proof-reuse artifact with the attempt that wrote them; null = the run published no such artifact. Throws when unreadable. */
async function readRunReceipts(repo: string, runId: number, deps: CiReuseApi): Promise<{ attempt: number; receipts: unknown[] } | null> {
  const list = obj(await deps.api(`/repos/${repo}/actions/runs/${runId}/artifacts?name=${CI_PROOF_REUSE_ARTIFACT}&per_page=100`)).artifacts;
  if (!Array.isArray(list)) throw new Error("工件列表读不懂");
  const row = list.map(ciReuseArtifactRow).filter((r) => r.name === CI_PROOF_REUSE_ARTIFACT).sort((a, b) => b.id - a.id)[0];
  if (!row) return null;
  if (row.runId !== runId || row.expired) throw new Error(row.expired ? "工件已过期" : `工件属于 run ${row.runId}`);
  const zip = await deps.download(row.id);
  if (row.digest === null || !eq(row.digest, ciReuseDigest(zip))) throw new Error("下载内容的摘要与登记的不符或缺失");
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } }; // bad JSON reads null and is refused as a receipt
  const names = (await deps.entries(zip)).filter((n) => n.endsWith(".json")).sort();
  const receipts: unknown[] = [];
  for (const n of names) if (n !== CI_PROOF_REUSE_RUN_FILE) receipts.push(parse(await deps.unzip(zip, n)));
  const marker = names.includes(CI_PROOF_REUSE_RUN_FILE) ? obj(parse(await deps.unzip(zip, CI_PROOF_REUSE_RUN_FILE))) : {};
  if (!receipts.length) return { attempt: 0, receipts };
  if (marker.runId !== runId || !posInt(marker.attempt)) throw new Error(`有回执却没有属于本次 run 的 ${CI_PROOF_REUSE_RUN_FILE}`);
  return { attempt: marker.attempt, receipts };
}

/**
 * The merge side's evidence reader: fills CiRunEvidence.reuse for one run from the Actions API. It fails closed: an artifact
 * that cannot be listed, downloaded or opened, and an original run that cannot be read back, are recorded in `unread` (or left
 * without an origin) and ciProofReuseProblems refuses them; only a run that really published no receipt reads as "reused
 * nothing". It never throws, so a failed read cannot interrupt the path that asked — it can only make the proof refuse.
 */
export async function readCiRunReuse(repo: string, run: { runId: number; attempt: number }, deps: CiReuseApi, revokedRuns: readonly number[] = []): Promise<CiRunReuse> {
  const unread: string[] = [], origins: CiReuseOrigin[] = [];
  let artifact: CiRunReuse["artifact"] = { ...run, receipts: [] };
  try {
    const got = await readRunReceipts(repo, run.runId, deps);
    if (got?.receipts.length) artifact = { runId: run.runId, attempt: got.attempt, receipts: got.receipts };
  } catch (e) {
    return { artifact, origins, revokedRuns, unread: [`复用回执工件读不回（${(e as Error).message}），不能当作没有复用`] };
  }
  for (const raw of artifact.receipts) {
    const p = parseCiReuseReceipt(raw);
    if (!p.ok || revokedRuns.includes(p.value.origin.runId)) continue; // refused without the API
    try { origins.push(await readCiReuseReceiptOrigin(p.value, deps)); }
    catch (e) { unread.push(`复用 ${p.value.inputs.check.id} 的原 run ${p.value.origin.runId} 读不回（${(e as Error).message}）`); }
  }
  return { artifact, origins, revokedRuns, unread };
}
