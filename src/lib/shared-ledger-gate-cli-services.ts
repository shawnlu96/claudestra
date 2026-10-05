export const SCHEDULER_SERVICE_COMMANDS = new Set([
  "scheduler-convergence", "scheduler-arbiter-delivery",
  "scheduler-plan", "scheduler-plan-rejected", "scheduler-settle", "scheduler-session-bind", "scheduler-session-retire", "scheduler-merge-begin", "scheduler-merge-step",
  "scheduler-observe", "scheduler-fallback-manual", "scheduler-stage", "scheduler-ui-ask", "lend-ask", "lend-inform", "lend-close-asks", "scheduler-pool",
  "scheduler-deploy-begin", "scheduler-deploy-step", "verify",
  "scheduler-unclaimed", "scheduler-unclaimed-sent", "scheduler-supervise", "peer-pr-intake", "peer-pr-observe", "peer-pr-push-record",
  "scheduler-autostart", "scheduler-auto-resume", "scheduler-retire", "scheduler-review-swap", "lend-takeover", "scheduler-family-wait", "scheduler-fix-relay", "scheduler-sec-review-alarm",
  "scheduler-spec-place", "memory-auto", "scheduler-converge-notice", "scheduler-worker-retire",
]);
