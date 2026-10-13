/**
 * merge-arch-GATE1: the one CI full-proof decision behind the planner, the merge driver (serial, manual queue, PM repair binding
 * and train members all go through its MergeExternal), the train's mergeCandidates and the deploy tick. The subject is the exact
 * integration content: for a PR, the commit CI checked out must be a merge of [the main it would merge onto, the reviewed head];
 * for a deploy, the main commit that would be deployed. The PR head alone proves nothing. Switch: recovery key ciCoverageGate.
 * - off: nothing is read. observe: the path's own answer stands; a ledger note records "on would wait for the full proof".
 * - on: a missing proof only waits (run kept as is: no fix, no freeze, no slot taken); the merge call itself reads the proof again
 *   right before sending (a pass's earlier answer is never sent on: an artifact can be deleted, a run re-run, a reuse revoked).
 * Boarding (planner, mergeCandidates) never needs a proof: the train's combined proof is asked when its members merge.
 * A serial / manual PR whose own run was related-only is proven by the SELECT1 full re-check run (workflow_dispatch on main) of the
 * same binding; a train car by its own run on the train's base (main may since hold this train's merges, nothing else).
 * The scheduler cannot constrain a host's own git / gh commands, so this is a gate on its own actions, not a security boundary.
 * docs/architecture/ci-proof.md, tests/scheduler-ci-proof-gate.test.ts, tests/scheduler-ci-proof-flow.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type CiCoverageGateMode, type CiProofExpect, type CiRunEvidence, ciCoverageGateMode, judgeCiCoverage } from "./ci-proof.js";
import { MERGE_NOT_SENT } from "./manual-merge-queue-facts.js";
import { type ObservedAction, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import { fullRequestId, fullRunTitle } from "./scheduler-ci-full-request.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { CI_PROOF_WORKFLOW, type CiProofCommit, type CiProofPort, type CiProofPull, type CiProofRunRow, ghCiProofPort } from "./scheduler-ci-proof-port.js";
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
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

/**
 * What must be proven. pr: PR `pr` at `head` (absent = whatever head the PR has now: a train car's own PR) merged onto `base`.
 * main: the main commit `head`, as pushed (its manifest's base is the push event's `before`, which no API reads back: attested).
 * `car` marks a train car's PR: `base` is the train's fixed base, and `heads` are the
 * heads of the members that train cleared (the only merges main may have gained since that base).
 */
export interface CiProofSubject {
  kind: "pr" | "main"; repo: string; pr?: number; head?: string; base?: string; requiredChecks: readonly string[]; car?: { heads: readonly string[] };
}
/** The facts one check resolved. Without `expect` the subject could not even be bound to a run; `gaps` says why. */
export interface CiProofFacts {
  subject: CiProofSubject;
  head: string | null;
  runId: number | null;
  /** The event of the run the subject was bound to; workflow_dispatch = the SELECT1 full re-check of this exact binding. */
  event?: string;
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

/** How one kind of run is tied to the subject: which runs to list, which commit it must have tested, what its manifest must say. */
interface RunBinding {
  /** The reviewed head (or the main commit); `listed` = the head_sha the run was triggered for (a dispatch runs on main). */
  head: string; listed: string; event: string; title?: string; none: string;
  /** The commit the run must have checked out, when the caller knows it without the run (a push: the head; a re-check: the test merge). */
  checkout?: string;
  /** Why this commit is not the subject's integration content, or null. */
  refuse(c: CiProofCommit, runId: number): Promise<string | null>;
  /**
   * What the manifest records as base; absent = the run's own word is taken (and listed as attested). A push manifest records the
   * event's `before`: with several commits in one push that is not the tip's first parent, and nothing but the event knows it. The
   * base is not part of what a push run tested (the checkout is the pushed commit itself, read back from the Git API).
   */
  base?(c: CiProofCommit): string;
  /** The commit the workflow file was loaded from. */
  workflowSha(c: CiProofCommit): string;
}

/** main since the train's base holds nothing but merges of the members it cleared (the walk scheduler-merge-train.ts mainOnlyMembers does). */
async function onTrainBase(port: CiProofPort, repo: string, from: string, base: string | undefined, heads: readonly string[]): Promise<boolean> {
  let cur = from;
  for (let i = 0; i <= heads.length; i++) {
    if (eq(cur, base)) return true;
    const c = await port.commit(repo, cur);
    if (c.parents.length !== 2 || !heads.some((h) => eq(h, c.parents[1]))) return false;
    cur = c.parents[0]!;
  }
  return false;
}

/** Binds the subject to the newest run the binding names and to the commit that run checked out. Throws what the port throws. */
async function bindRun(subject: CiProofSubject, port: CiProofPort, b: RunBinding): Promise<CiProofFacts> {
  const { repo } = subject, out: CiProofFacts = { subject, head: b.head, runId: null, expect: null, evidence: null, gaps: [], pending: false, attested: [] };
  const gap = (why: string, pending = false): CiProofFacts => ({ ...out, gaps: [why], pending });
  const mine = (r: CiProofRunRow) => r.event === b.event && eq(r.headSha, b.listed) && (b.title === undefined || r.title === b.title);
  const row = (await port.runs(repo, b.listed)).find(mine);
  if (!row) return gap(b.none, true);
  out.runId = row.id; out.event = b.event;
  if (row.status !== "completed") return gap(`run ${row.id} ${row.status}，未完成`, true);
  const read = await port.read(repo, row.id);
  out.evidence = read.evidence;
  const checkout = b.event === "push" ? b.head : read.checkout;
  if (!checkout) return gap(`run ${row.id} 没有留下本次 attempt 的证明工件，无从确认它检出的集成提交`);
  if (b.checkout && !eq(checkout, b.checkout)) return gap(`run ${row.id} 检出的 ${short(checkout)} 不是绑定的集成提交 ${short(b.checkout)}`);
  const c = await port.commit(repo, checkout), why = await b.refuse(c, row.id);
  if (why) return gap(why);
  const m = (read.evidence.artifact?.content ?? {}) as { base?: unknown; tests?: { universeDigest?: unknown } };
  const workflow = b.workflowSha(c), bun = workflowBun(await port.file(repo, workflow, CI_PROOF_WORKFLOW));
  out.attested = [...(b.base ? [] : ["base"]), "tests.universeDigest"];
  out.expect = {
    repo, head: b.head, ...(eq(b.listed, b.head) ? {} : { runHead: b.listed }), base: b.base ? b.base(c) : typeof m.base === "string" ? m.base : "",
    checkout: { sha: c.sha, tree: c.tree },
    workflow: { path: CI_PROOF_WORKFLOW, sha: workflow }, policyVersion: CI_PROOF_POLICY,
    toolchain: { bun: bun ?? "", lockfileDigest: sha256(await port.file(repo, c.sha, LOCKFILE)) },
    testsUniverseDigest: typeof m.tests?.universeDigest === "string" ? m.tests.universeDigest : "", requiredChecks: subject.requiredChecks,
  };
  return bun ? out : { ...out, gaps: [`${CI_PROOF_WORKFLOW}@${short(workflow)} 没有唯一的 bun-version`] };
}

/** The PR's own pull_request run: it tested GitHub's merge of [main, head]. A train car's sits on the train's base instead. */
function ownRun(subject: CiProofSubject, port: CiProofPort, pr: CiProofPull): RunBinding {
  const head = pr.head, car = subject.car;
  return {
    head, listed: head, event: "pull_request", none: `head ${short(head)} 还没有 pull_request 的 CI run`,
    refuse: async (c, runId) => {
      const merged = c.parents.length === 2 && eq(c.parents[1], head);
      if (merged && (car ? await onTrainBase(port, subject.repo, c.parents[0]!, subject.base, car.heads) : eq(c.parents[0], subject.base))) return null;
      return `run ${runId} 测的集成提交 ${short(c.sha)} 不是 main ${short(subject.base)} + head ${short(head)}（main 已变或测的是别的内容）`;
    },
    // A car's manifest recorded the main its run was triggered on (the commit's first parent, checked above), not the live pulls API
    // base, which moves on with every member that merges. A serial PR's main has not moved, or the proof is void anyway.
    base: (c) => (car ? c.parents[0]! : pr.base), workflowSha: (c) => c.sha,
  };
}

/**
 * The SELECT1 full re-check of this PR (scheduler-ci-full-request.ts): a workflow_dispatch run triggered on main whose title names
 * the digest of exactly this binding (PR, head, the main of now, GitHub's test merge and its tree). The run's head is main, the
 * tested content is the test merge: both are checked, here against the Git API and in verifyCiProof against the manifest.
 * null = GitHub's test merge is not [this main, this head]: there is no such request to look for.
 */
async function recheckRun(subject: CiProofSubject, port: CiProofPort, pr: CiProofPull): Promise<RunBinding | null> {
  const { repo, base } = subject;
  if (!pr.merge || !base || !subject.pr) return null;
  const merge = await port.commit(repo, pr.merge), bound = (c: CiProofCommit) => c.parents.length === 2 && eq(c.parents[0], base) && eq(c.parents[1], pr.head);
  if (!bound(merge)) return null;
  const id = fullRequestId({ repo, pr: subject.pr, head: pr.head, base, merge: merge.sha, tree: merge.tree });
  return {
    head: pr.head, listed: base, event: "workflow_dispatch", title: fullRunTitle(id), none: `main ${short(base)} 上还没有补验 ${id} 的 run`, checkout: merge.sha,
    refuse: async (c, runId) => (bound(c) && eq(c.tree, merge.tree) ? null : `补验 run ${runId} 测的 ${short(c.sha)} 不是 main ${short(base)} + head ${short(pr.head)}`),
    base: () => base, workflowSha: () => base,
  };
}

/**
 * Binds the subject to a run and to the commit that run checked out. A serial PR whose own run does not prove it is asked again
 * through its SELECT1 re-check run, when one exists for the binding of now. Never throws except for a stop.
 */
export async function resolveCiProof(subject: CiProofSubject, port: CiProofPort): Promise<CiProofFacts> {
  const head = subject.head ?? "";
  try {
    if (subject.kind === "main") {
      return await bindRun(subject, port, { head, listed: head, event: "push", none: `head ${short(head)} 还没有 main push 的 CI run`,
        refuse: async () => null, workflowSha: () => head });
    }
    const pr = await port.pull(subject.repo, subject.pr ?? 0);
    if (pr.state !== "open") return unbound(subject, `PR 状态 ${pr.state}，不是 open`, false);
    if (subject.head && !eq(pr.head, subject.head)) return unbound(subject, `PR head 已变成 ${short(pr.head)}，不是被核的 ${short(subject.head)}`, false);
    const own = await bindRun(subject, port, ownRun(subject, port, pr));
    if (subject.car || ciProofVerdict("merge", "on", true, own).proven) return own;
    const recheck = await recheckRun(subject, port, pr), again = recheck ? await bindRun(subject, port, recheck) : null;
    return again && again.runId !== null ? again : own;
  } catch (e) {
    if (stopped(e)) throw e;
    return unbound(subject, `${UNREAD}：${failText(e)}`, true);
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
    `  run：${facts.runId ?? "无"}${facts.evidence ? ` attempt ${facts.evidence.attempt}，${facts.evidence.status}/${facts.evidence.conclusion ?? "?"}` : ""}` +
      (facts.event === "workflow_dispatch" ? `（SELECT1 补验，在 main ${short(x?.runHead ?? facts.subject.base)} 上触发）` : ""),
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
  /**
   * PR + head → the subject this pass saw proven: a train member's car, null = the serial subject (the PR onto the main of now).
   * It only says what to ask again at the merge call, never that the proof still holds.
   */
  passed: Map<string, Car | null>;
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
 * observe: one ledger note per distinct action key; on: one log line. A waiting card is asked every pass, so what was already said
 * is not said again. A note that cannot be written never changes the path's answer (only a stopping pass ends it).
 */
async function say(g: Gate, where: { project: string; taskId: string }, mode: CiCoverageGateMode, actionKey: string, action: string, data: Record<string, unknown>,
  line = action): Promise<void> {
  const said = `${mode} ${where.taskId} ${actionKey}`;
  if (logged.has(said)) return;
  if (logged.size >= 500) logged.clear();
  logged.add(said);
  if (mode === "on") return void console.log(`🧾 [ci-proof] ${where.taskId} ${line}`);
  try {
    await g.record({ project: where.project, mechanism: "ciCoverageGate", target: where.taskId, actionKey, action, data });
  } catch (e) {
    if (stopped(e)) throw e;
    console.error(`⚠️ [ci-proof] ${where.taskId} 观察记录没写下（不影响合并路径；本会 ${action}）：${failText(e)}`);
  }
}

/** The would-wait of one unproven check (observe: a ledger note; on: a log line). */
async function note(g: Gate, where: { project: string; taskId: string }, v: CiProofVerdict, facts: CiProofFacts): Promise<void> {
  if (v.proven || v.mode === "off") return;
  const why = v.reasons.join("；").slice(0, 400), head = short(facts.head);
  // an unreadable GitHub words its failure differently every time: one key for all of them, or each retry would be a new note
  const actionKey = `${v.stage}:${facts.head ? head : "nohead"}:${why.startsWith(UNREAD) ? "unread" : sha256(why).slice(7, 19)}`;
  await say(g, where, v.mode, actionKey, `on 会等待 full 证明（${v.stage}，head ${head}）：${why}`,
    { stage: v.stage, head: facts.head, runId: facts.runId, checkout: facts.expect?.checkout.sha ?? null, pending: facts.pending, reasons: v.reasons },
    `${v.stage} 等 full 证明（head ${head}）：${why}`);
}

const prKey = (prRef: string, head: string) => `${prRef}\n${head.toLowerCase()}`;
function prOf(prRef: string): { repo: string; pr: number } {
  const m = PR_URL.exec(prRef);
  if (!m) throw new Error("PR URL 不合法");
  return { repo: m[1]!, pr: Number(m[2]) };
}

/** The serial subject (the PR merged onto the main of right now) or a train car's (its own PR merged onto the train's base). */
type Car = { pr: number; base: string; heads: string[] };
async function mergeFacts(g: Gate, run: Pick<MergeRun, "prRef" | "reviewedHead" | "requiredChecks">, car?: Car): Promise<CiProofFacts> {
  const { repo, pr } = prOf(run.prRef), requiredChecks = run.requiredChecks.split(",").filter(Boolean);
  if (car) return resolveCiProof({ kind: "pr", repo, pr: car.pr, base: car.base, requiredChecks, car: { heads: car.heads } }, g.port);
  const subject: CiProofSubject = { kind: "pr", repo, pr, head: run.reviewedHead, requiredChecks };
  try {
    return await resolveCiProof({ ...subject, base: await g.port.mainHead(repo) }, g.port);
  } catch (e) {
    if (stopped(e)) throw e;
    return unbound(subject, `${UNREAD}：${failText(e)}`, true);
  }
}

/** true = hold the run as it is this tick. An unreadable GitHub holds under on and changes nothing under observe (it is recorded). */
async function mergeHold(g: Gate | undefined, run: MergeRun, car?: Car | { gap: string }): Promise<boolean> {
  const mode = g?.mode(run.project) ?? "off";
  if (!g || mode === "off") return false;
  const key = prKey(run.prRef, run.reviewedHead), gap = car && "gap" in car ? car.gap : null, of = car && !("gap" in car) ? car : undefined;
  g.passed.delete(key);
  const facts = gap === null ? await mergeFacts(g, run, of) : unbound({ kind: "pr", repo: "", requiredChecks: [] }, gap, false);
  const v = ciProofVerdict("merge", mode, true, facts);
  await note(g, run, v, facts);
  if (v.proven) g.passed.set(key, of ?? null);
  return !v.allow;
}

/**
 * Under on, right before the merge API: the proof is read again in full for the subject this pass proved (the serial one when the
 * pass proved none). main, the run's latest attempt, its artifact and the reuse revocations can all change without the PR's green
 * checks changing, so the pass's earlier answer is never what sends a merge. A proof that is gone sends nothing.
 */
async function assertProven(g: Gate | undefined, project: string | undefined, prRef: string, head: string, requiredChecks: readonly string[]): Promise<void> {
  if (!g || !project || g.mode(project) !== "on") return;
  const key = prKey(prRef, head), car = g.passed.get(key) ?? undefined;
  g.passed.delete(key);
  const v = ciProofVerdict("merge", "on", true, await mergeFacts(g, { prRef, reviewedHead: head, requiredChecks: requiredChecks.join(",") }, car));
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
 * of the green car that carried it: the car's PR as its run tested it, on the train's fixed base or on that base plus merges of
 * this train's cleared members (main moves on as they merge; the train's own recheckCleared still judges main right before each
 * merge). Any other train answer passes through untouched.
 */
export async function ciProofTrain(answer: TrainGate, state: TrainState | null, run: MergeRun): Promise<TrainGate> {
  const g = gates.get(run.project);
  if (answer !== "cleared" || !state || !g || g.mode(run.project) === "off") return answer;
  const car = state.cars.find((c) => c.status === "green" && c.pr !== null && c.members.includes(run.taskId));
  const heads = state.members.filter((m) => state.cleared.includes(m.taskId)).map((m) => m.head);
  const subject = car ? { pr: car.pr!, base: state.base, heads } : { gap: `列车 ${state.id} 里没有带 ${run.taskId} 的绿色车厢，无从核组合证明` };
  return await mergeHold(g, run, subject) ? "wait" : answer;
}

/**
 * go: the deploy may be submitted; `pin` (on only) = the main commit whose full proof was just read, the one commit the job may
 * deploy. Otherwise `wait` = main's run for that commit may still deliver its proof; not wait = it will not (or
 * DEPLOY_PROOF_WAIT_MS passed) and `why` is the reason for the tick to settle with.
 */
export type CiProofDeploy = { go: true; pin: string | null } | { go: false; wait: boolean; why: string };

/**
 * The deploy tick's entry, asked right before a deploy is claimed and again right before a claimed one is submitted (a claim found
 * after a restart was never proven by this pass). on: the proven main commit is handed to the job as its fixed target, so a main
 * that moves on afterwards is not deployed. observe: nothing changes; the note says what on would wait for or pin.
 */
export async function ciProofDeploy(policy: ProjectSchedule | undefined, merge: { intentId: string; project: string; taskId: string; prRef: string }): Promise<CiProofDeploy> {
  const g = policy && gates.get(names.get(policy) ?? ""), mode = g?.mode(merge.project) ?? "off";
  if (!g || !policy || mode === "off") return { go: true, pin: null };
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
  if (v.proven && mode === "observe") {
    await say(g, merge, mode, `deploy-pin:${short(facts.head)}`, `on 会固定部署到 main ${short(facts.head)}（已有 full 证明）`, { stage: "deploy", head: facts.head, runId: facts.runId });
  }
  if (v.allow) { deployWaits.delete(merge.intentId); return { go: true, pin: mode === "on" ? facts.head : null }; }
  const since = deployWaits.get(merge.intentId) ?? g.now();
  deployWaits.set(merge.intentId, since);
  const why = `main ${short(facts.head)} 没有全量证明：${v.reasons.join("；").slice(0, 300)}`;
  if (facts.pending && g.now() - since <= DEPLOY_PROOF_WAIT_MS) return { go: false, wait: true, why };
  deployWaits.delete(merge.intentId);
  return { go: false, wait: false, why };
}

/** PM manual operations: the same evidence and gaps as the gate would see for this PR at this head, read through a plain gh port. */
export async function ciProofPreflight(input: { project: string; prRef: string; head: string; requiredChecks: readonly string[] },
  port: CiProofPort, policy: RecoveryPolicyPort = recoveryPolicy): Promise<string[]> {
  const { repo, pr } = prOf(input.prRef);
  const facts = await resolveCiProof({ kind: "pr", repo, pr, head: input.head, base: await port.mainHead(repo), requiredChecks: input.requiredChecks }, port);
  return ciProofReport(facts, ciCoverageGateMode(policy(input.project, "ciCoverageGate").mode));
}
