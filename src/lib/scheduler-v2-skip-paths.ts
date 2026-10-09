/**
 * S2D2 · the path inventory: every step of `schedulerPass` that can write the ledger for a card, open or drive a session,
 * touch git / GitHub or retire, with the gate that keeps a skip card (route `skip`, §2.2) at zero side effects. Plus every
 * ledger subcommand the scheduler sends, with how the unified gate (scheduler-v2-skip.ts) finds the card it is about.
 * tests/shared-ledger-v2-stage2-skip-paths.test.ts scans the code and fails when a step or a subcommand is not listed here.
 *
 * Gates:
 * - `pace`: the candidate loop asks `pace.skipTask` (S2D) before the card's first effect;
 * - `manager`: the pass manager is wrapped by `schedulerV2SkipManager` (scheduler-pass.ts), a skip card's write is held there;
 * - `hook`: the step reads facts and acts outside the pass manager, so a ≤3-line hook skips the card before any effect;
 * - `s2v`: retire side effects re-route per effect (S2V `withSchedulerV2Retire`), reused, not reimplemented;
 * - `featureless`: the step's cards never carry a feature (route is always local);
 * - `foreign`: the work belongs to another instance's ledger (lent orders), not to a card of this ledger;
 * - `none`: no card-bound effect.
 */

type SkipEffect = "ledger" | "session" | "git" | "gh" | "notice" | "retire" | "job";
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
    why: "agents bound to a skip card leave the supervision registry, so nothing is sent or restarted for them" },
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
  { step: "opts.retire", file: "scheduler-retire-deps.ts", fn: "retireStep", effects: ["ledger", "session", "git", "retire"], gates: ["manager", "s2v"],
    why: "scheduler-retire is held before any effect; central cards keep S2V's per-effect tenure check" },
  { step: "opts.lifecycle", file: "agent-lifecycle-deps.ts", fn: "lifecycleStep", effects: ["ledger", "session", "git", "retire", "notice"],
    gates: ["hook", "manager"], why: "a skip card counts as frozen: the planner keeps its worker and checkout" },
  { step: "opts.lend", file: "lend-deps.ts", fn: "lendStep", effects: ["session"], gates: ["foreign"],
    why: "orders lent to peers belong to their ledgers, not to this ledger's feature cards" },
];

/**
 * How the gate finds the card of a ledger subcommand. Every kind also scans the arguments for task / intent / feature ids.
 * - `card`: the scan alone (task id, intent id, `--intent`, JSON `taskId`);
 * - `autostart`: `claim <featureId>`, `settle|step <claimSeq>` → the claim event's feature;
 * - `lend-order`: `<orderId>` → lend_orders.taskId;
 * - `manual-claim`: `<project> --train <signal>` → the card of the queue turn;
 * - `project`: project level, no card (the scan still runs);
 * - `foreign`: the lend step's own bookkeeping for orders run for peers.
 */
export type SkipTargetKind = "card" | "autostart" | "lend-order" | "manual-claim" | "project" | "foreign";

export const SKIP_LEDGER_COMMANDS: Readonly<Record<string, SkipTargetKind>> = {
  "lend-ask": "foreign", "lend-close-asks": "foreign", "lend-inform": "foreign",
  "lend-takeover": "lend-order", "lend-takeover-refusal": "lend-order",
  "manual-merge-claim": "manual-claim",
  "memory-auto": "project", "note": "card", "order-taken": "card", "team-apply": "project", "peer-pr-intake": "project", "peer-pr-push-record": "card", "peer-pr-observe": "card",
  "scheduler-arbiter-delivery": "card", "scheduler-auto-resume": "card", "scheduler-autostart": "autostart",
  "scheduler-converge-notice": "card", "scheduler-convergence": "card", "scheduler-deploy-begin": "card", "scheduler-deploy-step": "card",
  "scheduler-fallback-manual": "card", "scheduler-family-wait": "card", "scheduler-fix-relay": "card", "scheduler-legacy-review-retire": "card", "scheduler-lock-yield": "card",
  "scheduler-manual-resume": "card", "scheduler-merge-begin": "card", "scheduler-merge-handoff": "card", "scheduler-merge-step": "card",
  "scheduler-model-inform": "card", "scheduler-model-outcome": "card", "scheduler-observe": "card", "scheduler-plan": "card", "scheduler-plan-rejected": "card", "scheduler-pool": "card",
  "scheduler-pool-refusal": "card", "scheduler-refusal-epoch": "card", "scheduler-retire": "card", "scheduler-review-downgrade": "card", "scheduler-review-hold": "card",
  "scheduler-review-snapshot": "card", "scheduler-review-swap": "card", "scheduler-sec-review-alarm": "card", "scheduler-session-bind": "card", "scheduler-session-retire": "card",
  "scheduler-settle": "card", "scheduler-spec-place": "card", "scheduler-stage": "card", "scheduler-supervise": "card",
  "scheduler-ui-ask": "card", "scheduler-unclaimed": "card", "scheduler-unclaimed-sent": "card", "scheduler-worker-retire": "card",
  "verify": "card",
};

/** Call sites whose subcommand is computed; each lists what it can send (all of them registered above). */
export const SKIP_LEDGER_DYNAMIC: Readonly<Record<string, readonly string[]>> = {
  "scheduler-auto-tick.ts": ["scheduler-stage", "scheduler-ui-ask"],
  "scheduler-model-wiring.ts": ["scheduler-legacy-review-retire", "scheduler-model-inform", "scheduler-model-outcome", "scheduler-refusal-epoch",
    "scheduler-review-snapshot"],
  "scheduler-recovery-ports.ts": ["scheduler-manual-resume", "scheduler-review-downgrade", "scheduler-review-hold"],
};
