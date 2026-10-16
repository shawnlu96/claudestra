export const SCHEDULER_SERVICE_COMMANDS = new Set([
  "scheduler-priority-stall",
  "scheduler-priority-now",
  "scheduler-manual-resume", "scheduler-review-hold", "scheduler-review-downgrade",
  "scheduler-convergence", "scheduler-arbiter-delivery",
  "scheduler-plan", "scheduler-plan-rejected", "scheduler-settle", "scheduler-session-bind", "scheduler-session-retire", "scheduler-merge-begin", "scheduler-merge-step", "scheduler-merge-handoff",
  "scheduler-observe", "scheduler-fallback-manual", "scheduler-stage", "scheduler-ui-ask", "lend-ask", "lend-inform", "lend-close-asks", "lend-terminal-asks", "scheduler-pool",
  "scheduler-deploy-begin", "scheduler-deploy-step", "verify",
  "scheduler-center-deploy",
  "scheduler-deploy-reconcile",
  "scheduler-unclaimed", "scheduler-unclaimed-sent", "scheduler-supervise", "peer-pr-intake", "peer-pr-observe", "peer-pr-push-record",
  "scheduler-autostart", "scheduler-auto-resume", "scheduler-retire", "scheduler-review-swap", "lend-takeover", "scheduler-family-wait", "scheduler-fix-relay", "scheduler-sec-review-alarm",
  "lend-takeover-refusal",
  "scheduler-spec-place", "memory-auto", "scheduler-converge-notice", "scheduler-worker-retire",
  "scheduler-review-snapshot", "scheduler-model-outcome", "scheduler-refusal-epoch", "scheduler-model-inform", "scheduler-legacy-review-retire", // MODELXW (manager/ledger-model-cmds.ts)
  "scheduler-pool-refusal", // MODELXP2 (manager/ledger-pool-refusal-cmds.ts)
  "scheduler-lend-author-retire",
  "scheduler-author-rebuild-note", // AREB2 (lib/scheduler-author-rebuild-cmds.ts)
  "scheduler-content-review", // merge-arch-REVIEW1 (manager/ledger-merge-content-review-cmds.ts)
  "scheduler-main-ci", // MAINCIW (manager/ledger-main-ci-cmds.ts)
  "scheduler-recovery-observe", // AUDW1 (manager/ledger-scheduler-recovery-cmds.ts)
  "scheduler-priority-sample", // PRIO2 (lib/scheduler-priority-order-cmd.ts)
  "scheduler-manual-case-default", // OWN1 (manager/ledger-manual-case-cmds.ts)
  "scheduler-manual-case-sla", // SLA1 (manager/ledger-manual-case-cmds.ts)
  "scheduler-local-merge-ready", // ONB-2 (manager/ledger-local-merge-cmds.ts)
  "scheduler-ui-evidence-redo", // UIEVID2 (lib/scheduler-ui-evidence-notice.ts)
]);
