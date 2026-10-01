/**
 * i28-W5 zero-peer parity: with no usable peer (no pool facts, remote off, empty borrow, or only proto-1 peers without a
 * fresh hello) the planner must decide exactly as it did before the shared slot pool. GOLDEN below was recorded from the
 * planner at origin/main b16efddb, before scheduler-placement.ts existed (`git log -S "i28-W5 zero-peer parity"`).
 * A proto-1 peer still follows the i28-R9 overflow rule, so its rows are part of the parity set too.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}, text = ""): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text, dedupKey: null });
const entry = (stage: Stage, round = 1, from: Stage = "build"): LedgerEvent => event(10 + round, "stage", { from, to: stage, round, specRev: 1 }, "复述");
const task = (stage: Stage, round = 0): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "W5", kind: "code", stage, stageBefore: null, round,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: "https://github.com/o/r/pull/7",
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow = (template: TaskWorkflow["template"] = "code", version = 2): TaskWorkflow => ({
  taskId: "T1", project: "p", template, templateVersion: version, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1,
});
const snapshot = (stage: Stage, round = 0, template: TaskWorkflow["template"] = "code", version = 2): PlannerSnapshot => ({
  task: task(stage, round), workflow: workflow(template, version),
  events: [event(1, "task", { op: "new" }), ...(stage === "spec" ? [] : [entry(stage, round, stage === "restate" ? "spec" : "build")])],
  intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const delivery = (seq: number, round: number): LedgerEvent => event(seq, "deliver", { round, headSHA: HEAD });
const finding = (family: string, severity: "P0" | "P1" | "P2" = "P1") => ({ findingId: `${family}-${severity}`, family, severity, probe: `probe ${family}` });
const review = (seq: number, round: number, findings: ReturnType<typeof finding>[], verdict = "changes"): LedgerEvent =>
  event(seq, "review", { round, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family,
    path: `reviews/T1-r${round}/report.md`, verdict, findings, p0: findings.filter((f) => f.severity === "P0").length,
    p1: findings.filter((f) => f.severity === "P1").length, p2: findings.filter((f) => f.severity === "P2").length });
const intent = (node: string, action: SchedulerIntent["action"], status: SchedulerIntent["status"], seq: number, recipient: string | null = null): SchedulerIntent => ({
  id: `i${seq}`, taskId: "T1", project: "p", node, action, recipient, causalSeq: seq, eventSeq: seq + 1, taskRev: 1, specRev: 1, head: HEAD,
  templateVersion: 2, status, attempts: 0, receipt: null, reason: "x", createdAt: seq, updatedAt: seq,
});
const sentReview = (round: number, seq: number): SchedulerIntent => ({ ...intent("adversarial_review", "review", "done", seq - 1),
  id: `review-r${round}`, eventSeq: seq, recipient: reviewer.agent });
const proof = (round: number, intentSeq: number) => ({ intentId: `review-r${round}`, round, head: HEAD,
  reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: intentSeq + 1 });

const OFF = { mode: "off" as const, roles: ["review" as const], poolTimeoutMin: 15 };
const OVERFLOW = { mode: "overflow" as const, roles: ["review" as const], poolTimeoutMin: 15 };
/** Pool facts as poolFacts() built them before W5: proto-1 peers only (no lend_peers row), so no fresh hello anywhere. */
const facts = (over: Partial<PoolFacts> = {}): PoolFacts =>
  ({ remote: OVERFLOW, localReviewers: 0, peers: [{ peer: "mate", open: 0, maxOpen: 1 }], repo: "o/r", lastPeer: null, ...over });
const POOLS: Record<string, PoolFacts | null | undefined> = {
  absent: undefined, null: null, off: facts({ remote: OFF }), noBorrow: facts({ peers: [] }), proto1Room: facts(),
};

const add = (s: PlannerSnapshot, ...more: LedgerEvent[]): void => { s.events = [...s.events, ...more]; };
const edit = (s: PlannerSnapshot, f: (s: PlannerSnapshot) => void): PlannerSnapshot => (f(s), s);
const reviewing = (template: TaskWorkflow["template"] = "code") => edit(snapshot("review", 1, template), (s) => { s.reviewer = null; add(s, delivery(19, 1)); });

/** Base snapshots, each planned once per POOLS variant. */
const CASES: Record<string, () => PlannerSnapshot> = {
  manual: () => edit(snapshot("build", 1), (s) => { s.workflow!.mode = "manual"; }),
  drift: () => edit(snapshot("build", 1), (s) => { s.workflow!.specRev = 2; }),
  terminal: () => snapshot("done", 1),
  blocked: () => snapshot("blocked", 1),
  frozen: () => edit(snapshot("build", 1), (s) => { s.queueFrozen = true; }),
  dependency: () => edit(snapshot("build", 1), (s) => { s.blockedBy = ["T0"]; }),
  specNoAuthor: () => edit(snapshot("spec"), (s) => { s.author = null; }),
  specDispatch: () => snapshot("spec"),
  specV3Dispatch: () => snapshot("spec", 0, "code", 3),
  restateV2Wait: () => snapshot("restate", 0),
  restateV2Approved: () => edit(snapshot("restate", 0), (s) => { add(s, event(30, "decision", { op: "restate_approved", specRev: 1 })); }),
  restateV3Recorded: () => snapshot("restate", 0, "code", 3),
  restateV3Hold: () => edit(snapshot("restate", 0, "code", 3), (s) => { add(s, event(30, "decision", { op: "restate_hold", specRev: 1 }, "看一下")); }),
  buildDispatch: () => snapshot("build", 1),
  buildCapacity: () => edit(snapshot("build", 1), (s) => { s.workerCount = 2; s.freeWorkerSlot = null; }),
  buildOwnSlot: () => edit(snapshot("build", 1), (s) => { s.workerCount = 2; s.freeWorkerSlot = null; s.heldResources = [{ taskId: "T1", resource: "slot:p:1" }]; }),
  buildBusy: () => edit(snapshot("build", 1), (s) => { s.heldResources = [{ taskId: "T2", resource: "src/lib/ledger-store.ts" }]; }),
  buildNoGlobs: () => edit(snapshot("build", 1), (s) => { s.fileGlobs = []; }),
  buildInFlight: () => edit(snapshot("build", 1), (s) => { s.intents = [intent("write", "dispatch", "submitted", 12)]; }),
  reviewEnsure: () => reviewing(),
  reviewEnsureFull: () => edit(reviewing(), (s) => { s.workerCount = 2; s.freeWorkerSlot = null; }),
  reviewLocal: () => edit(reviewing(), (s) => { s.reviewer = reviewer; }),
  reviewLocalBusy: () => edit(reviewing(), (s) => { s.reviewer = reviewer; s.heldResources = [{ taskId: "T2", resource: "reviewer:session-review" }]; }),
  reviewSecurity: () => reviewing("security"),
  reviewInFlight: () => edit(reviewing(), (s) => { s.intents = [intent("adversarial_review", "review", "pending", 12, "peer:mate")]; }),
  reviewStray: () => edit(reviewing(), (s) => { s.strayPoolOrders = ["L1"]; }),
  reviewTried: () => edit(reviewing(), (s) => { s.intents = [intent("adversarial_review", "review", "cancelled", 12, "peer:mate")]; }),
  reviewNoRepo: () => edit(reviewing(), (s) => { s.task.pr = null; }),
  reviewCodexAuthor: () => edit(reviewing(), (s) => { s.workflow!.authorFamily = "codex"; s.author = { ...author, family: "codex" }; }),
  reviewUnsolicited: () => edit(reviewing(), (s) => { s.reviewer = reviewer; add(s, review(20, 1, [finding("x")])); }),
  reviewToFix: () => edit(reviewing(), (s) => {
    s.reviewer = reviewer; add(s, review(20, 1, [finding("x")])); s.intents = [sentReview(1, 15)]; s.reviewDispatches = [proof(1, 15)];
  }),
  reviewPassToMerge: () => edit(reviewing(), (s) => {
    s.reviewer = reviewer; add(s, review(20, 1, [finding("y", "P2")], "pass")); s.intents = [sentReview(1, 15)]; s.reviewDispatches = [proof(1, 15)];
  }),
  fixDispatch: () => edit(snapshot("fix", 1), (s) => {
    add(s, delivery(19, 1), review(20, 1, [finding("x")]), event(25, "stage", { from: "review", to: "fix", round: 1 }));
  }),
  fixCapacity: () => edit(snapshot("fix", 1), (s) => {
    add(s, delivery(19, 1), review(20, 1, [finding("x")]), event(25, "stage", { from: "review", to: "fix", round: 1 }));
    s.workerCount = 2; s.freeWorkerSlot = null;
  }),
  mergeMissing: () => snapshot("merge", 1),
  mergeIntent: () => edit(snapshot("merge", 1), (s) => {
    s.events = [event(1, "task", { op: "new" }), entry("review", 1), delivery(19, 1), review(20, 1, [], "pass"), event(31, "stage", { from: "review", to: "merge", round: 1 })];
    s.intents = [sentReview(1, 15)]; s.reviewDispatches = [proof(1, 15)];
  }),
  mergeCancelled: () => edit(snapshot("merge", 1), (s) => {
    s.events = [event(1, "task", { op: "new" }), entry("review", 1), delivery(19, 1), review(20, 1, [], "pass"), event(31, "stage", { from: "review", to: "merge", round: 1 })];
    s.intents = [sentReview(1, 15), intent("merge_deploy", "merge", "cancelled", 32)]; s.reviewDispatches = [proof(1, 15)];
  }),
  intentInFlight: () => edit(snapshot("build", 1), (s) => { s.intents = [intent("other", "stage", "pending", 2)]; }),
};

/** Proto-1 rows where the i28-R9 overflow rule pools: local reviewer capacity full, or a re-review back to the answering peer. */
const LEGACY: Record<string, () => PlannerSnapshot> = {
  proto1Full: () => edit(reviewing(), (s) => { s.pool = facts({ localReviewers: 2 }); }),
  proto1ZeroWorkers: () => edit(reviewing(), (s) => { s.maxWorkers = 0; s.pool = facts(); }),
  proto1Rereview: () => edit(reviewing(), (s) => { s.pool = facts({ lastPeer: "mate", peers: [{ peer: "b", open: 0, maxOpen: 1 }, { peer: "mate", open: 0, maxOpen: 1 }] }); }),
  proto1RereviewGone: () => edit(reviewing(), (s) => { s.pool = facts({ localReviewers: 2, lastPeer: "mate", peers: [{ peer: "b", open: 0, maxOpen: 1 }] }); }),
  proto1PeerFull: () => edit(reviewing(), (s) => { s.pool = facts({ localReviewers: 2, peers: [{ peer: "mate", open: 1, maxOpen: 1 }] }); }),
  proto1Tried: () => edit(reviewing(), (s) => {
    s.pool = facts({ localReviewers: 2 }); s.intents = [intent("adversarial_review", "review", "cancelled", 12, "peer:mate")];
  }),
  proto1Security: () => edit(reviewing("security"), (s) => { s.pool = facts({ localReviewers: 2 }); }),
  proto1BoundReviewer: () => edit(reviewing(), (s) => { s.reviewer = reviewer; s.pool = facts({ localReviewers: 2 }); }),
};

/** Key-sorted JSON, so the digest pins every field's value but not the order the planner happened to build the object in. */
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v) ?? "undefined";
/** Readable head (kind, code or action, recipient) plus a digest of the whole decision: any changed field changes the row. */
const summary = (d: PlannerDecision): string =>
  `${d.kind} ${"code" in d ? d.code : d.action} ${"recipient" in d ? d.recipient ?? "-" : "-"} ${createHash("sha256").update(canonical(d)).digest("hex").slice(0, 16)}`;

function decisions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, make] of Object.entries(CASES)) {
    for (const [variant, pool] of Object.entries(POOLS)) {
      const s = make();
      if (pool !== undefined) s.pool = pool;
      out[`${name}/${variant}`] = summary(planScheduler(s));
    }
  }
  for (const [name, make] of Object.entries(LEGACY)) out[name] = summary(planScheduler(make()));
  return out;
}

const GOLDEN: Record<string, string> = {
  "manual/absent": "wait manual - 446486a1e7f1a159",
  "manual/null": "wait manual - 446486a1e7f1a159",
  "manual/off": "wait manual - 446486a1e7f1a159",
  "manual/noBorrow": "wait manual - 446486a1e7f1a159",
  "manual/proto1Room": "wait manual - 446486a1e7f1a159",
  "drift/absent": "escalate workflow_drift - 338e567173bb436c",
  "drift/null": "escalate workflow_drift - 338e567173bb436c",
  "drift/off": "escalate workflow_drift - 338e567173bb436c",
  "drift/noBorrow": "escalate workflow_drift - 338e567173bb436c",
  "drift/proto1Room": "escalate workflow_drift - 338e567173bb436c",
  "terminal/absent": "wait terminal - c68d8030928a76bf",
  "terminal/null": "wait terminal - c68d8030928a76bf",
  "terminal/off": "wait terminal - c68d8030928a76bf",
  "terminal/noBorrow": "wait terminal - c68d8030928a76bf",
  "terminal/proto1Room": "wait terminal - c68d8030928a76bf",
  "blocked/absent": "wait blocked - d75b0ea38fc6e0d8",
  "blocked/null": "wait blocked - d75b0ea38fc6e0d8",
  "blocked/off": "wait blocked - d75b0ea38fc6e0d8",
  "blocked/noBorrow": "wait blocked - d75b0ea38fc6e0d8",
  "blocked/proto1Room": "wait blocked - d75b0ea38fc6e0d8",
  "frozen/absent": "wait queue_frozen - a47ffb659ca23254",
  "frozen/null": "wait queue_frozen - a47ffb659ca23254",
  "frozen/off": "wait queue_frozen - a47ffb659ca23254",
  "frozen/noBorrow": "wait queue_frozen - a47ffb659ca23254",
  "frozen/proto1Room": "wait queue_frozen - a47ffb659ca23254",
  "dependency/absent": "wait dependency - 4478dab3347b7216",
  "dependency/null": "wait dependency - 4478dab3347b7216",
  "dependency/off": "wait dependency - 4478dab3347b7216",
  "dependency/noBorrow": "wait dependency - 4478dab3347b7216",
  "dependency/proto1Room": "wait dependency - 4478dab3347b7216",
  "specNoAuthor/absent": "intent ensure_session - c9d3eeaa35641d31",
  "specNoAuthor/null": "intent ensure_session - c9d3eeaa35641d31",
  "specNoAuthor/off": "intent ensure_session - c9d3eeaa35641d31",
  "specNoAuthor/noBorrow": "intent ensure_session - c9d3eeaa35641d31",
  "specNoAuthor/proto1Room": "intent ensure_session - c9d3eeaa35641d31",
  "specDispatch/absent": "intent dispatch agent-author 13780f1dec9661a0",
  "specDispatch/null": "intent dispatch agent-author 13780f1dec9661a0",
  "specDispatch/off": "intent dispatch agent-author 13780f1dec9661a0",
  "specDispatch/noBorrow": "intent dispatch agent-author 13780f1dec9661a0",
  "specDispatch/proto1Room": "intent dispatch agent-author 13780f1dec9661a0",
  "specV3Dispatch/absent": "intent dispatch agent-author 13780f1dec9661a0",
  "specV3Dispatch/null": "intent dispatch agent-author 13780f1dec9661a0",
  "specV3Dispatch/off": "intent dispatch agent-author 13780f1dec9661a0",
  "specV3Dispatch/noBorrow": "intent dispatch agent-author 13780f1dec9661a0",
  "specV3Dispatch/proto1Room": "intent dispatch agent-author 13780f1dec9661a0",
  "restateV2Wait/absent": "wait pm_restate - bf15d6f82969ecb5",
  "restateV2Wait/null": "wait pm_restate - bf15d6f82969ecb5",
  "restateV2Wait/off": "wait pm_restate - bf15d6f82969ecb5",
  "restateV2Wait/noBorrow": "wait pm_restate - bf15d6f82969ecb5",
  "restateV2Wait/proto1Room": "wait pm_restate - bf15d6f82969ecb5",
  "restateV2Approved/absent": "intent stage - d8c9c79f6edc9564",
  "restateV2Approved/null": "intent stage - d8c9c79f6edc9564",
  "restateV2Approved/off": "intent stage - d8c9c79f6edc9564",
  "restateV2Approved/noBorrow": "intent stage - d8c9c79f6edc9564",
  "restateV2Approved/proto1Room": "intent stage - d8c9c79f6edc9564",
  "restateV3Recorded/absent": "intent stage - d8c9c79f6edc9564",
  "restateV3Recorded/null": "intent stage - d8c9c79f6edc9564",
  "restateV3Recorded/off": "intent stage - d8c9c79f6edc9564",
  "restateV3Recorded/noBorrow": "intent stage - d8c9c79f6edc9564",
  "restateV3Recorded/proto1Room": "intent stage - d8c9c79f6edc9564",
  "restateV3Hold/absent": "wait restate_hold - 34b1a6e4cd54c49f",
  "restateV3Hold/null": "wait restate_hold - 34b1a6e4cd54c49f",
  "restateV3Hold/off": "wait restate_hold - 34b1a6e4cd54c49f",
  "restateV3Hold/noBorrow": "wait restate_hold - 34b1a6e4cd54c49f",
  "restateV3Hold/proto1Room": "wait restate_hold - 34b1a6e4cd54c49f",
  "buildDispatch/absent": "intent dispatch agent-author 13bbb1f8ef8ac0f4",
  "buildDispatch/null": "intent dispatch agent-author 13bbb1f8ef8ac0f4",
  "buildDispatch/off": "intent dispatch agent-author 13bbb1f8ef8ac0f4",
  "buildDispatch/noBorrow": "intent dispatch agent-author 13bbb1f8ef8ac0f4",
  "buildDispatch/proto1Room": "intent dispatch agent-author 13bbb1f8ef8ac0f4",
  "buildCapacity/absent": "wait capacity - 5e334cb18c682dff",
  "buildCapacity/null": "wait capacity - 5e334cb18c682dff",
  "buildCapacity/off": "wait capacity - 5e334cb18c682dff",
  "buildCapacity/noBorrow": "wait capacity - 5e334cb18c682dff",
  "buildCapacity/proto1Room": "wait capacity - 5e334cb18c682dff",
  "buildOwnSlot/absent": "intent dispatch agent-author 493c4372ad5114cd",
  "buildOwnSlot/null": "intent dispatch agent-author 493c4372ad5114cd",
  "buildOwnSlot/off": "intent dispatch agent-author 493c4372ad5114cd",
  "buildOwnSlot/noBorrow": "intent dispatch agent-author 493c4372ad5114cd",
  "buildOwnSlot/proto1Room": "intent dispatch agent-author 493c4372ad5114cd",
  "buildBusy/absent": "wait resource_busy - d7ac9a968d927396",
  "buildBusy/null": "wait resource_busy - d7ac9a968d927396",
  "buildBusy/off": "wait resource_busy - d7ac9a968d927396",
  "buildBusy/noBorrow": "wait resource_busy - d7ac9a968d927396",
  "buildBusy/proto1Room": "wait resource_busy - d7ac9a968d927396",
  "buildNoGlobs/absent": "escalate file_scope - 224faa7af92e3e6d",
  "buildNoGlobs/null": "escalate file_scope - 224faa7af92e3e6d",
  "buildNoGlobs/off": "escalate file_scope - 224faa7af92e3e6d",
  "buildNoGlobs/noBorrow": "escalate file_scope - 224faa7af92e3e6d",
  "buildNoGlobs/proto1Room": "escalate file_scope - 224faa7af92e3e6d",
  "buildInFlight/absent": "wait in_flight - d63d3dc3897b2da7",
  "buildInFlight/null": "wait in_flight - d63d3dc3897b2da7",
  "buildInFlight/off": "wait in_flight - d63d3dc3897b2da7",
  "buildInFlight/noBorrow": "wait in_flight - d63d3dc3897b2da7",
  "buildInFlight/proto1Room": "wait in_flight - d63d3dc3897b2da7",
  "reviewEnsure/absent": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsure/null": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsure/off": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsure/noBorrow": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsure/proto1Room": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsureFull/absent": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsureFull/null": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsureFull/off": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsureFull/noBorrow": "intent ensure_session - 124b9695f01f205b",
  "reviewEnsureFull/proto1Room": "intent ensure_session - 124b9695f01f205b",
  "reviewLocal/absent": "intent review agent-review 04ac11662a797af9",
  "reviewLocal/null": "intent review agent-review 04ac11662a797af9",
  "reviewLocal/off": "intent review agent-review 04ac11662a797af9",
  "reviewLocal/noBorrow": "intent review agent-review 04ac11662a797af9",
  "reviewLocal/proto1Room": "intent review agent-review 04ac11662a797af9",
  "reviewLocalBusy/absent": "wait resource_busy - 3c876ca0363cd94f",
  "reviewLocalBusy/null": "wait resource_busy - 3c876ca0363cd94f",
  "reviewLocalBusy/off": "wait resource_busy - 3c876ca0363cd94f",
  "reviewLocalBusy/noBorrow": "wait resource_busy - 3c876ca0363cd94f",
  "reviewLocalBusy/proto1Room": "wait resource_busy - 3c876ca0363cd94f",
  "reviewSecurity/absent": "intent ensure_session - 124b9695f01f205b",
  "reviewSecurity/null": "intent ensure_session - 124b9695f01f205b",
  "reviewSecurity/off": "intent ensure_session - 124b9695f01f205b",
  "reviewSecurity/noBorrow": "intent ensure_session - 124b9695f01f205b",
  "reviewSecurity/proto1Room": "intent ensure_session - 124b9695f01f205b",
  "reviewInFlight/absent": "wait in_flight - fe2aa101bcd6309a",
  "reviewInFlight/null": "wait in_flight - fe2aa101bcd6309a",
  "reviewInFlight/off": "wait in_flight - fe2aa101bcd6309a",
  "reviewInFlight/noBorrow": "wait in_flight - fe2aa101bcd6309a",
  "reviewInFlight/proto1Room": "wait in_flight - fe2aa101bcd6309a",
  "reviewStray/absent": "escalate pool_order_open - 0d388e0b39a99368",
  "reviewStray/null": "escalate pool_order_open - 0d388e0b39a99368",
  "reviewStray/off": "escalate pool_order_open - 0d388e0b39a99368",
  "reviewStray/noBorrow": "escalate pool_order_open - 0d388e0b39a99368",
  "reviewStray/proto1Room": "escalate pool_order_open - 0d388e0b39a99368",
  "reviewTried/absent": "intent ensure_session - 6b6d383063890608",
  "reviewTried/null": "intent ensure_session - 6b6d383063890608",
  "reviewTried/off": "intent ensure_session - 6b6d383063890608",
  "reviewTried/noBorrow": "intent ensure_session - 6b6d383063890608",
  "reviewTried/proto1Room": "intent ensure_session - 6b6d383063890608",
  "reviewNoRepo/absent": "intent ensure_session - 124b9695f01f205b",
  "reviewNoRepo/null": "intent ensure_session - 124b9695f01f205b",
  "reviewNoRepo/off": "intent ensure_session - 124b9695f01f205b",
  "reviewNoRepo/noBorrow": "intent ensure_session - 124b9695f01f205b",
  "reviewNoRepo/proto1Room": "intent ensure_session - 124b9695f01f205b",
  "reviewCodexAuthor/absent": "intent ensure_session - 08effde08c60d6b2",
  "reviewCodexAuthor/null": "intent ensure_session - 08effde08c60d6b2",
  "reviewCodexAuthor/off": "intent ensure_session - 08effde08c60d6b2",
  "reviewCodexAuthor/noBorrow": "intent ensure_session - 08effde08c60d6b2",
  "reviewCodexAuthor/proto1Room": "intent ensure_session - 08effde08c60d6b2",
  "reviewUnsolicited/absent": "escalate review_unsolicited - c1107bc1a9756563",
  "reviewUnsolicited/null": "escalate review_unsolicited - c1107bc1a9756563",
  "reviewUnsolicited/off": "escalate review_unsolicited - c1107bc1a9756563",
  "reviewUnsolicited/noBorrow": "escalate review_unsolicited - c1107bc1a9756563",
  "reviewUnsolicited/proto1Room": "escalate review_unsolicited - c1107bc1a9756563",
  "reviewToFix/absent": "intent stage - b54aa1108ca17cfc",
  "reviewToFix/null": "intent stage - b54aa1108ca17cfc",
  "reviewToFix/off": "intent stage - b54aa1108ca17cfc",
  "reviewToFix/noBorrow": "intent stage - b54aa1108ca17cfc",
  "reviewToFix/proto1Room": "intent stage - b54aa1108ca17cfc",
  "reviewPassToMerge/absent": "intent stage - 9dc910b5b6ae86ab",
  "reviewPassToMerge/null": "intent stage - 9dc910b5b6ae86ab",
  "reviewPassToMerge/off": "intent stage - 9dc910b5b6ae86ab",
  "reviewPassToMerge/noBorrow": "intent stage - 9dc910b5b6ae86ab",
  "reviewPassToMerge/proto1Room": "intent stage - 9dc910b5b6ae86ab",
  "fixDispatch/absent": "intent dispatch agent-author 4551a38699ca544c",
  "fixDispatch/null": "intent dispatch agent-author 4551a38699ca544c",
  "fixDispatch/off": "intent dispatch agent-author 4551a38699ca544c",
  "fixDispatch/noBorrow": "intent dispatch agent-author 4551a38699ca544c",
  "fixDispatch/proto1Room": "intent dispatch agent-author 4551a38699ca544c",
  "fixCapacity/absent": "wait capacity - 5e334cb18c682dff",
  "fixCapacity/null": "wait capacity - 5e334cb18c682dff",
  "fixCapacity/off": "wait capacity - 5e334cb18c682dff",
  "fixCapacity/noBorrow": "wait capacity - 5e334cb18c682dff",
  "fixCapacity/proto1Room": "wait capacity - 5e334cb18c682dff",
  "mergeMissing/absent": "escalate merge_review_missing - c66d2cc546b2975c",
  "mergeMissing/null": "escalate merge_review_missing - c66d2cc546b2975c",
  "mergeMissing/off": "escalate merge_review_missing - c66d2cc546b2975c",
  "mergeMissing/noBorrow": "escalate merge_review_missing - c66d2cc546b2975c",
  "mergeMissing/proto1Room": "escalate merge_review_missing - c66d2cc546b2975c",
  "mergeIntent/absent": "intent merge - 76ab7a7df747c9c8",
  "mergeIntent/null": "intent merge - 76ab7a7df747c9c8",
  "mergeIntent/off": "intent merge - 76ab7a7df747c9c8",
  "mergeIntent/noBorrow": "intent merge - 76ab7a7df747c9c8",
  "mergeIntent/proto1Room": "intent merge - 76ab7a7df747c9c8",
  "mergeCancelled/absent": "escalate merge_retry_requires_pm - 7f3f8f63539d88e1",
  "mergeCancelled/null": "escalate merge_retry_requires_pm - 7f3f8f63539d88e1",
  "mergeCancelled/off": "escalate merge_retry_requires_pm - 7f3f8f63539d88e1",
  "mergeCancelled/noBorrow": "escalate merge_retry_requires_pm - 7f3f8f63539d88e1",
  "mergeCancelled/proto1Room": "escalate merge_retry_requires_pm - 7f3f8f63539d88e1",
  "intentInFlight/absent": "wait intent_in_flight - c1efd64fdc69422a",
  "intentInFlight/null": "wait intent_in_flight - c1efd64fdc69422a",
  "intentInFlight/off": "wait intent_in_flight - c1efd64fdc69422a",
  "intentInFlight/noBorrow": "wait intent_in_flight - c1efd64fdc69422a",
  "intentInFlight/proto1Room": "wait intent_in_flight - c1efd64fdc69422a",
  "proto1Full": "intent review peer:mate 6d22c38706aab1ed",
  "proto1ZeroWorkers": "intent review peer:mate 6d22c38706aab1ed",
  "proto1Rereview": "intent review peer:mate c2e57fc0678e496a",
  "proto1RereviewGone": "intent ensure_session - 124b9695f01f205b",
  "proto1PeerFull": "intent ensure_session - 124b9695f01f205b",
  "proto1Tried": "intent ensure_session - 6b6d383063890608",
  "proto1Security": "intent ensure_session - 124b9695f01f205b",
  "proto1BoundReviewer": "intent review agent-review 04ac11662a797af9",
};

describe("i28-W5 zero-peer parity", () => {
  test("every recorded snapshot plans exactly as before the slot pool", () => {
    const now = decisions();
    expect(Object.keys(now).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [k, v] of Object.entries(GOLDEN)) expect({ k, v: now[k] }).toEqual({ k, v });
  });
});
