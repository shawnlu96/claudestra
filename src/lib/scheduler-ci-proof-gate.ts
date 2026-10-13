/**
 * merge-arch-GATE1: the one CI full-proof decision behind the planner, the merge driver (serial, manual queue, PM repair binding
 * and train members all go through its MergeExternal), the train's mergeCandidates and the deploy tick. The subject is the exact
 * integration content: for a PR, the commit CI checked out must be a merge of [the main it would merge onto, the reviewed head];
 * for a deploy, the main commit that would be deployed. The PR head alone proves nothing. Switch: recovery key ciCoverageGate.
 * - off: nothing is read. observe: the path's own answer stands; a ledger note records "on would wait for the full proof".
 * - on: a missing proof only waits (run kept as is: no fix, no freeze, no slot taken); the merge call itself re-checks before sending.
 * Boarding (planner, mergeCandidates) never needs a proof: the train's combined proof is asked when its members merge.
 * The scheduler cannot constrain a host's own git / gh commands, so this is a gate on its own actions, not a security boundary.
 * docs/architecture/ci-proof.md, tests/scheduler-ci-proof-gate.test.ts, tests/scheduler-ci-proof-flow.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type CiCoverageGateMode, type CiProofExpect, type CiRunEvidence, ciCoverageGateMode, judgeCiCoverage } from "./ci-proof.js";
import { MERGE_NOT_SENT } from "./manual-merge-queue-facts.js";
import { type ObservedAction, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { CI_PROOF_WORKFLOW, type CiProofPort, ghCiProofPort } from "./scheduler-ci-proof-port.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import type { TrainGate, TrainState } from "./scheduler-merge-train.js";
import { isTestProcess } from "./test-guard.js";

type ProjectSchedule = SchedulerConfig["projects"][string];
export type CiProofStage = "admit" | "merge" | "deploy";
/** The rule version scripts/ci-proof-artifact.ts writes into a full manifest (CI_PROOF_POLICY_VERSION there). */
export const CI_PROOF_POLICY = "ci-full-1";
const LOCKFILE = "bun.lock";
/** How long a deploy waits for the main run of the commit it would deploy; past it (or once that run ended without a proof) the merge goes to PM. */
export const DEPLOY_PROOF_WAIT_MS = 45 * 60_000;
/** A pass older than this was taken by a tick that did not merge: the merge call checks again instead of trusting it. */
const PASS_FRESH_MS = 5 * 60_000;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

/**
 * What must be proven. pr: PR `pr` at `head` (absent = whatever head the PR has now: a train car's own PR) merged onto `base`.
 * main: the main commit `head`, as pushed.
 */
export interface CiProofSubject { kind: "pr" | "main"; repo: string; pr?: number; head?: string; base?: string; requiredChecks: readonly string[] }
/** The facts one check resolved. Without `expect` the subject could not even be bound to a run; `gaps` says why. */
export interface CiProofFacts {
  subject: CiProofSubject;
  head: string | null;
  runId: number | null;
  expect: CiProofExpect | null;
  evidence: CiRunEvidence | null;
  gaps: string[];
  /** The proof may still arrive without anything changing: no run yet, a run in progress, or a read that failed. */
  pending: boolean;
  /** Expected values taken from the run's own manifest because the caller has no independent source for them. */
  attested: string[];
}
export interface CiProofVerdict { stage: CiProofStage; mode: CiCoverageGateMode; allow: boolean; proven: boolean; reasons: string[] }

const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (s: string | null | undefined) => (s ?? "").slice(0, 12) || "?";
const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const stopped = (e: unknown) => e instanceof SchedulerStopped;
const failText = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").slice(0, 300);

/** The one Bun version every setup-bun step of the workflow at that commit pins; null = none or several. */
function workflowBun(yml: string): string | null {
  const all = new Set([...yml.matchAll(/^\s*bun-version:\s*["']?([\w.-]+)["']?\s*$/gm)].map((m) => m[1]!));
  return all.size === 1 ? [...all][0]! : null;
}

/** No facts could be read (GitHub down, a list cut short): the proof may still be there, so this gap is pending. */
const UNREAD = "证据读取失败";
const unbound = (subject: CiProofSubject, why: string, pending: boolean): CiProofFacts =>
  ({ subject, head: subject.head ?? null, runId: null, expect: null, evidence: null, gaps: [why], pending, attested: [] });

/** Binds the subject to the newest CI run of its head and to the commit that run checked out. Never throws except for a stop. */
export async function resolveCiProof(subject: CiProofSubject, port: CiProofPort): Promise<CiProofFacts> {
  const out: CiProofFacts = { subject, head: subject.head ?? null, runId: null, expect: null, evidence: null, gaps: [], pending: false, attested: [] };
  const gap = (why: string, pending = false): CiProofFacts => ({ ...out, gaps: [why], pending });
  try {
    const { repo } = subject, pr = subject.kind === "pr" ? await port.pull(repo, subject.pr ?? 0) : null;
    if (pr && pr.state !== "open") return gap(`PR 状态 ${pr.state}，不是 open`);
    if (pr && subject.head && !eq(pr.head, subject.head)) return gap(`PR head 已变成 ${short(pr.head)}，不是被核的 ${short(subject.head)}`);
    const head = out.head = pr?.head ?? subject.head ?? "";
    const row = (await port.runs(repo, head)).find((r) => r.event === (pr ? "pull_request" : "push") && eq(r.headSha, head));
    if (!row) return gap(`head ${short(head)} 还没有 ${pr ? "pull_request" : "main push"} 的 CI run`, true);
    out.runId = row.id;
    if (row.status !== "completed") return gap(`run ${row.id} ${row.status}，未完成`, true);
    const read = await port.read(repo, row.id);
    out.evidence = read.evidence;
    const checkout = pr ? read.checkout : head;
    if (!checkout) return gap(`run ${row.id} 没有留下本次 attempt 的证明工件，无从确认它检出的集成提交`);
    const c = await port.commit(repo, checkout);
    if (pr && !(c.parents.length === 2 && eq(c.parents[0], subject.base) && eq(c.parents[1], head))) {
      return gap(`run ${row.id} 测的集成提交 ${short(c.sha)} 不是 main ${short(subject.base)} + head ${short(head)}（main 已变或测的是别的内容）`);
    }
    const m = (read.evidence.artifact?.content ?? {}) as { tests?: { universeDigest?: unknown } };
    const bun = workflowBun(await port.file(repo, c.sha, CI_PROOF_WORKFLOW));
    out.attested = ["tests.universeDigest"];
    out.expect = {
      repo, head, base: pr ? pr.base : c.parents[0] ?? "", checkout: { sha: c.sha, tree: c.tree },
      workflow: { path: CI_PROOF_WORKFLOW, sha: pr ? c.sha : head }, policyVersion: CI_PROOF_POLICY,
      toolchain: { bun: bun ?? "", lockfileDigest: sha256(await port.file(repo, c.sha, LOCKFILE)) },
      testsUniverseDigest: typeof m.tests?.universeDigest === "string" ? m.tests.universeDigest : "", requiredChecks: subject.requiredChecks,
    };
    return bun ? out : { ...out, gaps: [`${CI_PROOF_WORKFLOW}@${short(c.sha)} 没有唯一的 bun-version`] };
  } catch (e) {
    if (stopped(e)) throw e;
    return gap(`${UNREAD}：${failText(e)}`, true);
  }
}

/**
 * The shared decision. `prior` is the path's own verdict and is only ever narrowed. admit never needs a proof. merge / deploy ask
 * judgeCiCoverage when the subject was bound to a run; an unbound subject has no proof at all.
 */
export function ciProofVerdict(stage: CiProofStage, mode: CiCoverageGateMode, prior: boolean, facts: CiProofFacts | null): CiProofVerdict {
  if (stage === "admit" || mode === "off") return { stage, mode, allow: prior, proven: false, reasons: [] };
  const bound = facts?.expect && !facts.gaps.length ? judgeCiCoverage({ mode, prior, expect: facts.expect, evidence: facts.evidence }) : null;
  const proven = bound?.proof?.mergeAuthorized === true;
  const reasons = proven ? [] : bound ? bound.reasons : facts?.gaps.length ? facts.gaps : ["没有证明"];
  return { stage, mode, allow: mode === "on" ? prior && proven : prior, proven, reasons };
}

/** Boarding a train or planning a merge intent: the same decision at its admit stage (always the path's own answer). */
export const ciProofAdmits = (prior = true): boolean => ciProofVerdict("admit", "on", prior, null).allow;

/** The same evidence and gaps for a person: the PM preflight prints these lines; nothing here blocks. */
export function ciProofReport(facts: CiProofFacts, mode: CiCoverageGateMode = "observe"): string[] {
  const v = ciProofVerdict(facts.subject.kind === "main" ? "deploy" : "merge", mode === "off" ? "observe" : mode, true, facts), x = facts.expect;
  const what = facts.subject.kind === "main" ? `main ${short(facts.head)}` : `PR #${facts.subject.pr} head ${short(facts.head)} 合到 main ${short(facts.subject.base)}`;
  return [
    `CI full 证明（ciCoverageGate=${mode}）：${what}`,
    `  run：${facts.runId ?? "无"}${facts.evidence ? ` attempt ${facts.evidence.attempt}，${facts.evidence.status}/${facts.evidence.conclusion ?? "?"}` : ""}`,
    `  集成提交：${x ? `${x.checkout.sha} tree ${x.checkout.tree}` : "未确认"}`,
    ...(facts.attested.length ? [`  取自 run 自述、未独立核对：${facts.attested.join("、")}`] : []),
    v.proven ? "  结论：full 证明成立" : `  缺口（${facts.pending ? "可能还会补齐" : "不会自己补齐"}）：${v.reasons.join("；")}`,
  ];
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
interface Gate {
  port: CiProofPort; mode(project: string): CiCoverageGateMode; now(): number;
  /** Writes one observe note; throws when it was not written. */
  record(a: ObservedAction): Promise<void>;
  /** PR + head → a proof this pass saw (and the main it was bound to; absent for a train member, whose train rechecks main itself). */
  passed: Map<string, { at: number; repo: string; main?: string }>;
}
/** Tests only: the GitHub port (a test process never gets the gh one) and a clock. */
interface TestPorts { port?: CiProofPort; now?: () => number }
let testPorts: TestPorts = {};
const gates = new Map<string, Gate>(), names = new WeakMap<ProjectSchedule, string>();
/** intent → when its deploy first waited for main's proof. Module-level: the wait must outlast a pass. */
const deployWaits = new Map<string, number>(), logged = new Set<string>();
export function setCiProofPortsForTest(p: TestPorts | null): void { testPorts = p ?? {}; gates.clear(); deployWaits.clear(); logged.clear(); }

/**
 * The service's ledger connection is query_only, so a note goes through the scheduler identity's ledger CLI (the pass's guarded
 * manager), like every other write of the pass. A child's lease-lost answer is only a note not written, unless the pass itself stopped.
 */
const recordByCli = (manager: Manager, active: () => void) => async (a: ObservedAction): Promise<void> => {
  const r = await manager("ledger", "scheduler-recovery-observe", a.target, "--mechanism", a.mechanism, "--action-key", a.actionKey, "--action", a.action,
    "--data", JSON.stringify(a.data ?? {})).catch((e: unknown) => { active(); throw new Error((e as Error).message); });
  if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
};

/**
 * Opened once per pass (scheduler-pass.ts) with the pass's guarded command; every later question of the pass finds its project here.
 * A project that is not in the config, or a test process without an injected port, has no gate: every path behaves as before.
 */
export function openCiProofGate(db: Database, config: SchedulerConfig, policy: RecoveryPolicyPort = recoveryPolicy, command?: typeof runBounded,
  manager?: Manager, active: () => void = () => {}): void {
  gates.clear();
  const port = testPorts.port ?? (isTestProcess() || !command ? null : ghCiProofPort(command));
  if (!port) return;
  const now = testPorts.now ?? Date.now;
  const gate: Gate = { port, now, passed: new Map(), mode: (project) => ciCoverageGateMode(policy(project, "ciCoverageGate").mode),
    record: manager ? recordByCli(manager, active) : async (a) => void recordObserved(db, a, now()) };
  for (const [project, schedule] of Object.entries(config.projects)) { gates.set(project, gate); names.set(schedule, project); }
}

/**
 * observe: one ledger note per distinct would-wait; on: one log line per distinct wait. A waiting card is asked every pass, so what
 * was already said is not said again. A note that cannot be written never changes the path's answer (only a stopping pass ends it).
 */
async function note(g: Gate, where: { project: string; taskId: string }, v: CiProofVerdict, facts: CiProofFacts): Promise<void> {
  if (v.proven || v.mode === "off") return;
  const why = v.reasons.join("；").slice(0, 400), head = short(facts.head);
  // an unreadable GitHub words its failure differently every time: one key for all of them, or each retry would be a new note
  const actionKey = `${v.stage}:${facts.head ? head : "nohead"}:${why.startsWith(UNREAD) ? "unread" : sha256(why).slice(7, 19)}`;
  const said = `${v.mode} ${where.taskId} ${actionKey}`;
  if (logged.has(said)) return;
  if (logged.size >= 500) logged.clear();
  logged.add(said);
  const action = `on 会等待 full 证明（${v.stage}，head ${head}）：${why}`;
  if (v.mode === "on") return void console.log(`🧾 [ci-proof] ${where.taskId} ${v.stage} 等 full 证明（head ${head}）：${why}`);
  try {
    await g.record({ project: where.project, mechanism: "ciCoverageGate", target: where.taskId, actionKey, action,
      data: { stage: v.stage, head: facts.head, runId: facts.runId, checkout: facts.expect?.checkout.sha ?? null, pending: facts.pending, reasons: v.reasons } });
  } catch (e) {
    if (stopped(e)) throw e;
    console.error(`⚠️ [ci-proof] ${where.taskId} 观察记录没写下（不影响合并路径；本会 ${action}）：${failText(e)}`);
  }
}

const prKey = (prRef: string, head: string) => `${prRef}\n${head.toLowerCase()}`;
function prOf(prRef: string): { repo: string; pr: number } {
  const m = PR_URL.exec(prRef);
  if (!m) throw new Error("PR URL 不合法");
  return { repo: m[1]!, pr: Number(m[2]) };
}

/** The serial subject (the PR merged onto the main of right now) or a train car's (its own PR merged onto the train's base). */
async function mergeFacts(g: Gate, run: Pick<MergeRun, "prRef" | "reviewedHead" | "requiredChecks">, car?: { pr: number; base: string }):
  Promise<{ facts: CiProofFacts; repo: string; main?: string }> {
  const { repo, pr } = prOf(run.prRef), requiredChecks = run.requiredChecks.split(",").filter(Boolean);
  if (car) return { repo, facts: await resolveCiProof({ kind: "pr", repo, pr: car.pr, base: car.base, requiredChecks }, g.port) };
  const subject: CiProofSubject = { kind: "pr", repo, pr, head: run.reviewedHead, requiredChecks };
  try {
    const main = await g.port.mainHead(repo);
    return { repo, main, facts: await resolveCiProof({ ...subject, base: main }, g.port) };
  } catch (e) {
    if (stopped(e)) throw e;
    return { repo, facts: unbound(subject, `${UNREAD}：${failText(e)}`, true) };
  }
}

/** true = hold the run as it is this tick. An unreadable GitHub holds under on and changes nothing under observe (it is recorded). */
async function mergeHold(g: Gate | undefined, run: MergeRun, car?: { pr: number; base: string } | { gap: string }): Promise<boolean> {
  const mode = g?.mode(run.project) ?? "off";
  if (!g || mode === "off") return false;
  const key = prKey(run.prRef, run.reviewedHead);
  g.passed.delete(key);
  const { facts, repo, main } = car && "gap" in car ? { facts: unbound({ kind: "pr", repo: "", requiredChecks: [] }, car.gap, false), repo: "", main: undefined }
    : await mergeFacts(g, run, car);
  const v = ciProofVerdict("merge", mode, true, facts);
  await note(g, run, v, facts);
  if (v.proven) g.passed.set(key, { at: g.now(), repo, ...(main ? { main } : {}) });
  return !v.allow;
}

/** Under on, right before the merge API: the pass's proof must still be bound to the main of now; without one it is checked here. */
async function assertProven(g: Gate | undefined, project: string | undefined, prRef: string, head: string, requiredChecks: readonly string[]): Promise<void> {
  if (!g || !project || g.mode(project) !== "on") return;
  const key = prKey(prRef, head), pass = g.passed.get(key);
  g.passed.delete(key);
  if (pass && g.now() - pass.at <= PASS_FRESH_MS) {
    if (!pass.main) return;
    const main = await g.port.mainHead(pass.repo);
    if (eq(main, pass.main)) return;
    throw new Error(`${MERGE_NOT_SENT}：full 证明绑定的 main ${short(pass.main)} 已变成 ${short(main)}，须重新核对`);
  }
  const { facts } = await mergeFacts(g, { prRef, reviewedHead: head, requiredChecks: requiredChecks.join(",") });
  const v = ciProofVerdict("merge", "on", true, facts);
  if (!v.allow) throw new Error(`${MERGE_NOT_SENT}：缺 full 证明（${v.reasons.join("；").slice(0, 300)}）`);
}

/**
 * The merge driver's entry (assembled in scheduler-merge-external.ts): after the path's own full re-check lets the run go on, a
 * missing proof answers "wait" under on; the merge call is the last check. Train members are asked through ciProofTrain instead.
 */
export function withCiProofGate(base: MergeExternal, policy: ProjectSchedule): MergeExternal {
  const gate = () => gates.get(names.get(policy) ?? "");
  const fullRecheck = base.fullRecheck?.bind(base), merge = base.merge.bind(base);
  return {
    ...base,
    fullRecheck: async (run, pr) => {
      const own = await fullRecheck?.(run, pr);
      return own ? own : await mergeHold(gate(), run) ? "wait" : null;
    },
    merge: async (prRef, head) => { await assertProven(gate(), names.get(policy), prRef, head, policy.requiredChecks); return merge(prRef, head); },
  };
}

/**
 * The train hook's entry (scheduler-merge-train-tick.ts withMergeTrain): a member the train cleared merges only with the full proof
 * of the green car that carried it (the car's PR merged onto the train's base). Any other train answer passes through untouched.
 */
export async function ciProofTrain(answer: TrainGate, state: TrainState | null, run: MergeRun): Promise<TrainGate> {
  const g = gates.get(run.project);
  if (answer !== "cleared" || !state || !g || g.mode(run.project) === "off") return answer;
  const car = state.cars.find((c) => c.status === "green" && c.pr !== null && c.members.includes(run.taskId));
  const subject = car ? { pr: car.pr!, base: state.base } : { gap: `列车 ${state.id} 里没有带 ${run.taskId} 的绿色车厢，无从核组合证明` };
  return await mergeHold(g, run, subject) ? "wait" : answer;
}

/**
 * The deploy tick's entry, asked right before a deploy begins: null = go on; "wait" = main's run for the commit that would be
 * deployed may still deliver its proof; any other string = it will not (or DEPLOY_PROOF_WAIT_MS passed): the reason, for the
 * tick to settle the merge as "not deployed automatically" so the merge slot is not held forever (a repair must be able to merge).
 */
export async function ciProofDeployHold(policy: ProjectSchedule, merge: { intentId: string; project: string; taskId: string; prRef: string }): Promise<null | "wait" | string> {
  const g = gates.get(names.get(policy) ?? ""), mode = g?.mode(merge.project) ?? "off";
  if (!g || mode === "off") return null;
  let facts: CiProofFacts;
  try {
    const { repo } = prOf(merge.prRef);
    facts = await resolveCiProof({ kind: "main", repo, head: await g.port.mainHead(repo), requiredChecks: policy.requiredChecks }, g.port);
  } catch (e) {
    if (stopped(e)) throw e;
    facts = unbound({ kind: "main", repo: "", requiredChecks: [] }, `${UNREAD}：${failText(e)}`, true);
  }
  const v = ciProofVerdict("deploy", mode, true, facts);
  await note(g, merge, v, facts);
  if (v.allow) { deployWaits.delete(merge.intentId); return null; }
  const since = deployWaits.get(merge.intentId) ?? g.now();
  deployWaits.set(merge.intentId, since);
  if (facts.pending && g.now() - since <= DEPLOY_PROOF_WAIT_MS) return "wait";
  deployWaits.delete(merge.intentId);
  return `main ${short(facts.head)} 没有全量证明：${v.reasons.join("；").slice(0, 300)}`;
}

/** PM manual operations: the same evidence and gaps as the gate would see for this PR at this head, read through a plain gh port. */
export async function ciProofPreflight(input: { project: string; prRef: string; head: string; requiredChecks: readonly string[] },
  port: CiProofPort, policy: RecoveryPolicyPort = recoveryPolicy): Promise<string[]> {
  const { repo, pr } = prOf(input.prRef);
  const facts = await resolveCiProof({ kind: "pr", repo, pr, head: input.head, base: await port.mainHead(repo), requiredChecks: input.requiredChecks }, port);
  return ciProofReport(facts, ciCoverageGateMode(policy(input.project, "ciCoverageGate").mode));
}
