/**
 * S2D2 · the path inventory: every awaited step of `schedulerPass`, its card-bound effects and the gate that keeps a skip card
 * (route `skip`, §2.2) at zero of them; and every ledger subcommand the pass can send, with the argument that names its card.
 * tests/shared-ledger-v2-stage2-skip-paths.test.ts scans the code and fails on anything unregistered (effect sites per file:
 * scheduler-v2-skip-effects.ts).
 */

type SkipEffect = "ledger" | "session" | "git" | "gh" | "notice" | "retire" | "job";
/**
 * pace: the candidate loop asks `pace.skipTask` (S2D); manager: the pass manager is wrapped by `schedulerV2SkipManager`;
 * hook: a ≤3-line hook skips the card before the step's first effect; s2v: retire effects re-route per effect (S2V);
 * featureless: the cards never carry a feature; foreign: another instance's ledger (lent orders); none: no card-bound effect.
 */
type SkipGate = "pace" | "manager" | "hook" | "s2v" | "featureless" | "foreign" | "none";

export interface SchedulerPassPath {
  /** Callee as written after `await` in schedulerPass (`opts.x` for an injectable step). */
  step: string;
  file: string;
  fn: string;
  effects: readonly SkipEffect[];
  gates: readonly SkipGate[];
  why: string;
}

export const SCHEDULER_PASS_PATHS: readonly SchedulerPassPath[] = [
  { step: "acquireMaintenance", file: "scheduler-maintenance.ts", fn: "acquireMaintenance", effects: [], gates: ["none"],
    why: "the service's own maintenance lease" },
  { step: "opts.peerPr", file: "peer-pr-tick.ts", fn: "peerPrStep", effects: ["ledger", "gh", "git", "notice"], gates: ["featureless", "manager"],
    why: "peer PR cards are created by peer-pr-intake with no feature; their ledger writes still pass the gate" },
  { step: "trainTick", file: "scheduler-merge-train-tick.ts", fn: "mergeTrainPass", effects: ["gh", "notice"], gates: ["hook"],
    why: "train gh calls go through its own port: skip cards never become candidates, a live train carrying one is not stepped" },
  { step: "mergeTick", file: "scheduler-service.ts", fn: "mergeTick", effects: ["ledger", "gh"], gates: ["pace", "manager"], why: "S2D hook" },
  { step: "deployTick", file: "scheduler-deploy-tick.ts", fn: "deployTick", effects: ["ledger", "job"], gates: ["pace", "manager"], why: "S2D hook" },
  { step: "reclaimLentSlots", file: "scheduler-merge-reclaim.ts", fn: "reclaimLentSlots", effects: ["ledger"], gates: ["manager"],
    why: "its only effect is scheduler-merge-step on the lender's intent" },
  { step: "manual.claim", file: "manual-merge-queue-pass.ts", fn: "manualMergeGate().claim", effects: ["ledger"], gates: ["manager"],
    why: "manual-merge-claim is resolved to the queue turn's card" },
  { step: "schedulerObserveTick", file: "scheduler-observe-tick.ts", fn: "schedulerObserveTick", effects: ["ledger"], gates: ["pace", "manager"],
    why: "paceCards filters; memory-auto is project level" },
  { step: "opts.supervise", file: "agent-supervisor-deps.ts", fn: "superviseStep", effects: ["ledger", "session", "notice"], gates: ["hook", "manager"],
    why: "agents of a skip card (cardWorkerIndex) leave the registry it reads; its own ledger is the gated manager" },
  { step: "auto.resume", file: "scheduler-autostart-resume.ts", fn: "autoResumeTick", effects: ["ledger"], gates: ["pace", "manager"], why: "S2D hook" },
  { step: "specResumeStep", file: "scheduler-spec-resume-deps.ts", fn: "specResumeStep", effects: ["ledger"], gates: ["pace", "manager"], why: "S2D hook" },
  { step: "opts.lockYield", file: "scheduler-lock-yield-deps.ts", fn: "lockYieldStep", effects: ["ledger", "notice"], gates: ["manager"],
    why: "every write is scheduler-lock-yield <taskId>; the PM notice follows only a recorded contend" },
  { step: "schedulerAutoTick", file: "scheduler-auto-tick.ts", fn: "schedulerAutoTick", effects: ["ledger", "session", "git", "gh", "notice"],
    gates: ["pace"], why: "paceCards (S2D); central cards go to S2I through autoTickDeps" },
  { step: "auto.start", file: "scheduler-autostart-run.ts", fn: "autostartTick", effects: ["ledger", "session", "git", "notice"],
    gates: ["hook", "manager"], why: "a migrating or execution feature is never picked, so no preflight git and no claim" },
  { step: "lendTakeoverStep", file: "lend-pr-takeover.ts", fn: "lendTakeoverStep", effects: ["ledger", "gh"], gates: ["hook", "manager"],
    why: "gh reads and PR creation come before the ledger write: the order's card is checked first" },
  { step: "opts.retire", file: "scheduler-retire-deps.ts", fn: "retireStep", effects: ["ledger", "session", "git", "retire"], gates: ["hook", "manager", "s2v"],
    why: "the finished-lease sweep skips skip cards (ledger-scheduler-lease-finished.ts); scheduler-retire is held before any effect; S2V per effect" },
  { step: "opts.lifecycle", file: "agent-lifecycle-deps.ts", fn: "lifecycleStep", effects: ["ledger", "session", "git", "retire", "notice"],
    gates: ["hook", "manager"], why: "a skip card counts as frozen at planning; every effect re-checks the route (scheduler-v2-skip-lifecycle.ts)" },
  { step: "opts.lend", file: "lend-deps.ts", fn: "lendStep", effects: ["session"], gates: ["foreign"],
    why: "orders lent to peers belong to their ledgers, not to this ledger's feature cards" },
];

/**
 * Which argument names the card (or feature) of a ledger subcommand; the gate reads only that one, never flags such as --to or
 * --reason. task / intent: the first argument after the subcommand; task-or-none: same, `-` = none; autostart: by verb;
 * lend-order: lend_orders.taskId; manual-claim: the queue head of the project; supervise: `--data` JSON `target`;
 * worker-retire: `--wire` JSON `taskId`; project / foreign: no card. Matches S2Q's targets (tests).
 */
export type SkipTargetKind = "task" | "intent" | "task-or-none" | "autostart" | "lend-order" | "manual-claim" | "supervise" | "worker-retire"
  | "project" | "foreign";

export const SKIP_LEDGER_COMMANDS: Readonly<Record<string, SkipTargetKind>> = {
  "deliver": "task", "lend-ask": "foreign", "lend-close-asks": "foreign", "lend-inform": "foreign",
  "lend-takeover": "lend-order", "lend-takeover-refusal": "lend-order", "manual-merge-claim": "manual-claim", "memory-auto": "project", "memory-refs": "intent",
  "note": "task-or-none", "order-taken": "intent", "peer-pr-intake": "project", "peer-pr-push-record": "task-or-none", "peer-pr-observe": "task",
  "scheduler-arbiter-delivery": "intent", "scheduler-auto-resume": "task", "scheduler-autostart": "autostart", "scheduler-converge-notice": "task",
  "scheduler-convergence": "intent", "scheduler-deploy-begin": "intent", "scheduler-deploy-step": "intent", "scheduler-fallback-manual": "task",
  "scheduler-family-wait": "task", "scheduler-fix-relay": "task", "scheduler-legacy-review-retire": "task", "scheduler-lock-yield": "task",
  "scheduler-manual-resume": "task", "scheduler-merge-begin": "intent", "scheduler-merge-handoff": "task", "scheduler-merge-step": "intent",
  "scheduler-model-inform": "task", "scheduler-model-outcome": "intent", "scheduler-observe": "task", "scheduler-plan": "task", "scheduler-plan-rejected": "task",
  "scheduler-pool": "intent", "scheduler-pool-refusal": "task", "scheduler-refusal-epoch": "task", "scheduler-retire": "task", "scheduler-review-downgrade": "task",
  "scheduler-review-hold": "task", "scheduler-review-snapshot": "intent", "scheduler-review-swap": "intent", "scheduler-sec-review-alarm": "task",
  "scheduler-session-bind": "task", "scheduler-session-retire": "task", "scheduler-settle": "intent", "scheduler-spec-place": "task", "scheduler-stage": "intent",
  "scheduler-supervise": "supervise", "scheduler-ui-ask": "intent", "scheduler-unclaimed": "intent", "scheduler-unclaimed-sent": "intent",
  "scheduler-worker-retire": "worker-retire", "verify": "task",
};

/** Call sites whose subcommand is computed; each lists what it can send (all of them registered above). */
export const SKIP_LEDGER_DYNAMIC: Readonly<Record<string, readonly string[]>> = {
  "order-ledger-exit.ts": ["deliver", "memory-refs"],
  "scheduler-auto-tick.ts": ["scheduler-stage", "scheduler-ui-ask"],
  "scheduler-model-wiring.ts": ["scheduler-legacy-review-retire", "scheduler-model-inform", "scheduler-model-outcome", "scheduler-refusal-epoch",
    "scheduler-review-snapshot"],
  "scheduler-recovery-ports.ts": ["scheduler-manual-resume", "scheduler-review-downgrade", "scheduler-review-hold"],
};
