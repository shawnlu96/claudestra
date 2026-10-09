/**
 * S2D2 · every file the scheduler pass reaches (value imports from scheduler-pass.ts and its injected steps) that holds a
 * side-effect site (ledger call, SQL write, process, file write, notice, git / gh), filed under the gate that keeps a skip card at
 * zero effects, with its site counts. tests/shared-ledger-v2-stage2-skip-paths.test.ts rescans the code and turns red on any
 * new, moved or removed site (new file, new kind, one more site in an existing function) until it is registered here again.
 */

export type SkipEffectGate = "pace" | "manager" | "hook" | "s2v" | "featureless" | "foreign" | "writer" | "outside" | "infra";

/** gate → file → site counts (`ledger=1 sql=2`), as the scan in the paths test prints them. */
export const SKIP_EFFECT_FILES: Readonly<Record<SkipEffectGate, Readonly<Record<string, string>>>> = {
  /** card work run from a candidate loop that asks pace.skipTask (S2D) first */
  pace: {
    "fix-strategy-lifecycle.ts": "proc=1", "fix-strategy-remote-branch.ts": "vcs=1", "fix-strategy-remote-context.ts": "notice=2", "fix-strategy-runtime.ts": "proc=1 fs=2 vcs=1",
    "lend-fix-reassign-pr.ts": "proc=1 vcs=4", "lend-git.ts": "vcs=1", "pool-review-proof-raw.ts": "fs=2", "review-converge-followup.ts": "proc=1 fs=2 vcs=1",
    "review-converge-scope.ts": "proc=1 vcs=1", "review-main-carry-proof.ts": "proc=1 fs=1 vcs=3", "scheduler-author-rebuild-checkout.ts": "vcs=4", "scheduler-author-rebuild-proof.ts": "vcs=6",
    "scheduler-author-rebuild.ts": "vcs=2", "scheduler-auto-deps.ts": "proc=1 notice=1", "scheduler-auto-ports.ts": "notice=1", "scheduler-create-retry-worktree.ts": "vcs=8",
    "scheduler-create-retry.ts": "vcs=2", "scheduler-deploy-job.ts": "fs=3", "scheduler-main-merge-carry.ts": "vcs=2", "scheduler-merge-external.ts": "vcs=3",
    "scheduler-review-head.ts": "proc=1 vcs=4", "scheduler-review-rebase.ts": "proc=1 vcs=1", "scheduler-spec-resume-deps.ts": "proc=1 notice=1 vcs=1", "scheduler-ui-carry-proof.ts": "proc=1",
    "scheduler-ui-carry.ts": "fs=2", "scheduler-ui-gate.ts": "notice=1",
  },
  /** `ledger <sub>` calls through the pass manager, held by schedulerV2SkipManager */
  manager: {
    "fix-strategy-tick.ts": "ledger=8", "ledger-pool-refusal-tick.ts": "ledger=1", "lend-fix-reassign-tick.ts": "ledger=2", "lend-pr-takeover-refusal-request.ts": "ledger=1",
    "manual-merge-queue-pass.ts": "ledger=1", "memory-auto-tick.ts": "ledger=1", "review-converge-notice.ts": "ledger=4", "scheduler-auto-tick.ts": "ledger=8",
    "scheduler-autostart-resume.ts": "ledger=1", "scheduler-deploy-tick.ts": "ledger=5", "scheduler-family-pick-notice.ts": "ledger=1", "scheduler-local-author.ts": "ledger=2 fs=1 vcs=4",
    "scheduler-local-runtime-queue.ts": "ledger=1 notice=4", "scheduler-lock-yield-deps.ts": "ledger=2", "scheduler-merge-handoff-tick.ts": "ledger=3 vcs=2",
    "scheduler-merge-pm-tick.ts": "ledger=1", "scheduler-merge-reclaim.ts": "ledger=1", "scheduler-model-wiring.ts": "ledger=8 sql=1", "scheduler-observe-tick.ts": "ledger=1",
    "scheduler-pool-tick.ts": "ledger=1", "scheduler-post-verify.ts": "ledger=2", "scheduler-recovery-ports.ts": "ledger=3", "scheduler-review-pm-tick.ts": "ledger=1",
    "scheduler-review-swap-runtime.ts": "ledger=1 proc=1", "scheduler-sec-review.ts": "ledger=1", "scheduler-service.ts": "ledger=6 proc=1", "scheduler-spec-resume.ts": "ledger=3",
    "scheduler-spec-wait.ts": "ledger=1",
  },
  /** a ≤3-line S2D2 hook (or the module the hooked step drives) skips the card before the effect */
  hook: {
    "agent-lifecycle-backoff.ts": "vcs=1", "agent-lifecycle-cleanup-archive.ts": "fs=1", "agent-lifecycle-cleanup-gate.ts": "fs=1", "agent-lifecycle-cleanup-scan.ts": "vcs=1",
    "agent-lifecycle-cleanup.ts": "fs=1 vcs=1", "agent-lifecycle-deps.ts": "ledger=1 proc=2 fs=1", "agent-lifecycle-run.ts": "fs=1", "agent-supervisor-deps.ts": "ledger=2 proc=1 notice=3",
    "ledger-scheduler-lease-finished.ts": "sql=7", "lend-pr-takeover-gh.ts": "vcs=4", "lend-pr-takeover.ts": "ledger=1", "scheduler-autostart-deps.ts": "proc=2 fs=2 notice=1 vcs=1",
    "scheduler-autostart-run.ts": "ledger=3 notice=4", "scheduler-merge-train-gh.ts": "vcs=1", "scheduler-merge-train-tick.ts": "fs=1 notice=1", "scheduler-merge-train.ts": "notice=2",
    "session-archive.ts": "fs=1",
  },
  /** retire effects re-route per effect (S2V withSchedulerV2Retire) after scheduler-retire passed the gate */
  s2v: {
    "scheduler-retire-deps.ts": "proc=1 fs=1 notice=1", "scheduler-retire-tmp.ts": "fs=3", "scheduler-retire.ts": "ledger=4 vcs=1", "scheduler-v2-retire-guard.ts": "sql=4",
    "scheduler-v2-retire.ts": "fs=1",
  },
  /** peer PR cards carry no feature, so their route is always local */
  featureless: {
    "peer-pr-github.ts": "proc=1 vcs=4", "peer-pr-hold.ts": "vcs=1", "peer-pr-intake.ts": "ledger=1", "peer-pr-notice.ts": "ledger=2", "peer-pr-observe.ts": "ledger=1",
    "peer-pr-tick.ts": "notice=2",
  },
  /** lent orders run for peers: their ledgers and the lend journal, not this ledger's feature cards */
  foreign: {
    "lend-claude-worker-capacity.ts": "proc=1", "lend-claude-worker.ts": "fs=4", "lend-clone.ts": "proc=1 fs=2 vcs=9", "lend-config-failure.ts": "notice=2", "lend-delivery-amend.ts": "fs=1",
    "lend-deps.ts": "ledger=3 proc=3 vcs=1", "lend-drive.ts": "notice=1", "lend-evidence.ts": "fs=4", "lend-grant-spawn.ts": "proc=1", "lend-journal.ts": "sql=9 fs=1",
    "lend-notice.ts": "notice=2", "lend-pane-archive.ts": "fs=3", "lend-proc-reap.ts": "proc=1", "lend-push.ts": "proc=1 fs=2 vcs=9", "lend-quota-line-config.ts": "fs=1",
    "lend-reborrow-preserve.ts": "proc=1 fs=3 vcs=1", "lend-receipts.ts": "fs=2", "lend-trash.ts": "fs=4", "lend-update-gap-host.ts": "proc=1 vcs=1",
  },
  /** SQL of the ledger writer layer: it runs inside a `ledger <sub>` transaction or the gated step that drives it */
  writer: {
    "agent-lifecycle-store.ts": "sql=6", "fix-strategy-remote-order.ts": "sql=1", "fix-strategy-remote.ts": "sql=1 notice=1", "fix-strategy-session.ts": "sql=4",
    "fix-strategy-task-write.ts": "sql=1", "ledger-asks-schema.ts": "sql=4", "ledger-asks.ts": "sql=6", "ledger-audit-store.ts": "sql=9", "ledger-dag-write.ts": "sql=10",
    "ledger-feature-schema.ts": "sql=6", "ledger-feature-write.ts": "sql=5", "ledger-lend-lease.ts": "sql=2", "ledger-lend-peers-ttl.ts": "sql=1", "ledger-lend-peers.ts": "sql=4",
    "ledger-lend-queue.ts": "sql=5", "ledger-lend-relay.ts": "sql=10", "ledger-lend-schema.ts": "sql=7", "ledger-lend.ts": "sql=7", "ledger-memory.ts": "sql=3", "ledger-origin.ts": "sql=1",
    "ledger-pool-refusal.ts": "sql=2", "ledger-scheduler-lease-notice.ts": "sql=4", "ledger-scheduler-lease-sync.ts": "sql=2", "ledger-scheduler-lease.ts": "sql=3",
    "ledger-scheduler-schema.ts": "sql=6", "ledger-scheduler-settle.ts": "sql=2", "ledger-scheduler-write.ts": "sql=7", "ledger-steps-write.ts": "sql=3", "ledger-write.ts": "sql=4",
    "lend-author-family.ts": "sql=1", "lend-config-failure-pool.ts": "sql=2", "lend-fix-reassign-start.ts": "sql=1", "lend-fix-start.ts": "sql=1 proc=1 vcs=3", "lend-peer-cooldown.ts": "sql=7",
    "lend-pr-takeover-ledger.ts": "sql=1", "lend-reclaim-scheduler.ts": "sql=4 notice=1", "manual-merge-queue.ts": "sql=3", "scheduler-deploy.ts": "sql=6",
    "scheduler-merge-ci-behind.ts": "sql=1 vcs=1", "scheduler-merge-ci-rerun.ts": "sql=2 vcs=1", "scheduler-merge-conflict.ts": "sql=3", "scheduler-merge-handoff.ts": "sql=1",
    "scheduler-merge-train-hold.ts": "sql=3", "scheduler-merge.ts": "sql=11", "scheduler-review-swap.ts": "sql=3", "scheduler-sessions.ts": "sql=7", "scheduler-ui-review-carry.ts": "sql=2",
    "shared-ledger-v2-write-gate-state.ts": "sql=9",
  },
  /** bridge / MCP order tools: reachable by import, run for a worker's own call, never by the pass */
  outside: {
    "codex-thread.ts": "proc=1 notice=4", "memory-tools-refs.ts": "ledger=1 sql=1", "memory-vectors.ts": "sql=1 fs=2", "order-deliver-pr.ts": "vcs=2", "order-deliver-scope-git.ts": "proc=1",
    "order-deliver.ts": "ledger=1 vcs=1", "order-ledger-exit.ts": "ledger=2", "order-mark.ts": "ledger=1",
  },
  /** process, file, tmux, store and notice plumbing with no card of its own; its callers are the gated paths */
  infra: {
    "acp-turn-gate.ts": "notice=2", "agent-settings.ts": "fs=9", "archive-copy.ts": "fs=3", "bridge-client.ts": "notice=1", "bun-path.ts": "proc=1", "caller-cred.ts": "fs=5",
    "file-lock.ts": "fs=7", "github-release.ts": "proc=1 vcs=1", "inbound-ledger.ts": "sql=4", "instance-id.ts": "fs=4", "key-file.ts": "fs=3", "ledger-backup.ts": "fs=2",
    "ledger-scheduler-lease-worker.ts": "proc=1", "ledger-store.ts": "sql=5 fs=1", "ledger-tx.ts": "sql=1", "log-paths.ts": "fs=4", "media-outbound.ts": "sql=2 fs=4",
    "memory-retrieve-head.ts": "proc=1 vcs=1", "notify.ts": "notice=2", "pm-notify.ts": "notice=2", "projects.ts": "proc=1 vcs=1", "quota-keychain.ts": "proc=2",
    "recovery-machine-policy.ts": "fs=1", "recovery-policy.ts": "fs=1", "run-bounded.ts": "proc=2", "run-manager.ts": "proc=2", "sandbox-pi-fs.ts": "fs=3", "scheduler-central-journal.ts": "fs=2",
    "scheduler-lease-env.ts": "proc=1", "scheduler-maintenance.ts": "fs=1", "scheduler-pass.ts": "proc=1", "scheduler-review-worktree.ts": "proc=3 fs=2 vcs=3", "scheduler-yield.ts": "fs=2",
    "shared-ledger-center-claims.ts": "fs=1", "shared-ledger-mode.ts": "fs=2", "state-file.ts": "fs=7", "sys-memory.ts": "proc=1", "tmux-helper.ts": "proc=25 fs=1", "unmanaged-archive.ts": "fs=4",
    "update-inflight.ts": "proc=2 fs=2", "usage-store.ts": "sql=28 fs=1", "worker-liveness.ts": "proc=1",
  },
};
