/**
 * S2D2 · every file the scheduler pass reaches (value imports from scheduler-pass.ts and its injected steps) that holds a
 * side-effect site (ledger call, SQL write, process, file write, notice, git / gh), filed under the gate that keeps a skip card at
 * zero effects, with its site counts. tests/shared-ledger-v2-stage2-skip-paths.test.ts rescans the code and turns red on any
 * new, moved or removed site (new file, new kind, one more site in an existing function) until it is registered here again.
 * Counts out of step with the code: run `bun run skip-effects` (it rewrites registered counts only); a new file's gate is chosen by a person.
 */

export type SkipEffectGate = "pace" | "manager" | "hook" | "s2v" | "featureless" | "foreign" | "writer" | "outside" | "infra";

/** gate → file → site counts (`ledger=1 sql=2`), as the scan in the paths test prints them. */
export const SKIP_EFFECT_FILES: Readonly<Record<SkipEffectGate, Readonly<Record<string, string>>>> = {
  /** card work run from a candidate loop that asks pace.skipTask (S2D) first */
  pace: {
    "fix-strategy-lifecycle.ts": "proc=1", "fix-strategy-remote-branch.ts": "vcs=1", "fix-strategy-remote-context.ts": "notice=2",
    "fix-strategy-runtime.ts": "proc=1 fs=2 vcs=1", "lend-fix-reassign-pr.ts": "proc=1 vcs=4", "lend-git.ts": "vcs=1", "pool-review-proof-raw.ts": "fs=2",
    "review-converge-followup.ts": "proc=1 fs=2 vcs=1", "review-converge-scope.ts": "proc=1 vcs=1", "review-main-carry-proof.ts": "proc=1 fs=1 vcs=3",
    "scheduler-author-rebuild-proof.ts": "vcs=6", "scheduler-author-rebuild.ts": "vcs=2",
    "scheduler-auto-deps.ts": "proc=1 notice=1", "scheduler-auto-ports.ts": "notice=1", "scheduler-create-retry-worktree.ts": "vcs=8",
    "scheduler-identity-notice.ts": "notice=1",
    "recovery-fix-local-swap-run.ts": "proc=1 vcs=1", // GATESWAP1: the commit-edge author-tree proof's synchronous git (treeProofSync)
    "scheduler-create-retry.ts": "vcs=2", "scheduler-deploy-job.ts": "fs=3", "scheduler-dispatch-recovery.ts": "ledger=4 stmt=2",
    "scheduler-existing-author.ts": "vcs=1", "scheduler-main-merge-carry.ts": "vcs=2", "scheduler-merge-external.ts": "vcs=3",
    "scheduler-merge-union-git.ts": "fs=4 vcs=1", // KEYUNION1: the merge driver's scratch-worktree union merge + push, under the merge tick's skipTask
    "scheduler-review-head.ts": "proc=1 vcs=4", "scheduler-review-rebase.ts": "stmt=1 proc=1 vcs=1", "scheduler-spec-resume-deps.ts": "proc=1 notice=1 vcs=1",
    "scheduler-ui-carry-proof.ts": "proc=1", "scheduler-ui-carry.ts": "fs=2", "scheduler-ui-gate.ts": "notice=1",
  },
  /** `ledger <sub>` calls through the pass manager, held by schedulerV2SkipManager */
  manager: {
    "fix-strategy-tick.ts": "ledger=8", "ledger-pool-refusal-tick.ts": "ledger=1", "lend-fix-reassign-tick.ts": "ledger=2",
    "recovery-fix-local-swap-tick.ts": "ledger=2", // GATESWAP1: `ledger scheduler-recovery-observe` / `scheduler-fallback-manual` through the pass manager
    "scheduler-author-rebuild-checkout.ts": "ledger=1 vcs=5", // AREB2: rebuildNote, the writer child for the rebuild's notes
    "lend-pr-takeover-refusal-request.ts": "ledger=1", "manual-merge-queue-pass.ts": "ledger=1", "memory-auto-tick.ts": "ledger=1",
    // merge-arch-SLA1: the one PM message of a batch, sent only for episodes whose `ledger scheduler-manual-case-sla <task> --phase claim` passed the manager gate
    "manual-case-sla-tick.ts": "notice=3",
    "merge-content-review-sink.ts": "ledger=1", // merge-arch-REVIEW1: `ledger scheduler-content-review` from the merge driver's carry, through the pass manager
    "scheduler-merge-union.ts": "ledger=1", // KEYUNION1: `ledger scheduler-recovery-observe` for mergeUnion notes, through the pass manager
    "observation-plan-tick.ts": "ledger=2", // PMAUTO1: `ledger observation-due` and its --sent ack through the pass manager
    "p2-backlog-notice.ts": "ledger=1", // PMAUTO1: `ledger p2-backlog-record` before the P2 diff notice, through the pass manager
    "review-converge-notice.ts": "ledger=4", "scheduler-auto-tick.ts": "ledger=8", "scheduler-autostart-resume.ts": "ledger=1", "scheduler-deploy-tick.ts": "ledger=6 notice=1",
    "scheduler-family-pick-notice.ts": "ledger=1", "scheduler-local-author.ts": "ledger=2 fs=1 vcs=5", "scheduler-local-runtime-queue.ts": "ledger=1 notice=4",
    "scheduler-lock-yield-deps.ts": "ledger=2", "scheduler-main-ci-wiring.ts": "ledger=3 notice=4", "scheduler-merge-handoff-tick.ts": "ledger=3 vcs=2", "scheduler-merge-pm-tick.ts": "ledger=1",
    "scheduler-merge-reclaim.ts": "ledger=1", "scheduler-model-wiring.ts": "ledger=8 sql=1 stmt=1", "scheduler-observe-tick.ts": "ledger=1",
    "scheduler-ci-proof-gate.ts": "ledger=1", // GATE1: `ledger scheduler-recovery-observe` (the observe note) through the pass manager
    "scheduler-pool-tick.ts": "ledger=1", "scheduler-post-verify.ts": "ledger=2", "scheduler-recovery-ports.ts": "ledger=5", "scheduler-review-pm-tick.ts": "ledger=1",
    "scheduler-review-swap-runtime.ts": "ledger=1 proc=1", "scheduler-sec-review.ts": "ledger=1", "scheduler-service.ts": "ledger=6 proc=1", "merge-deploy-outbox.ts": "ledger=1",
    "scheduler-spec-resume.ts": "ledger=3", "scheduler-spec-wait.ts": "ledger=1 stmt=1",
  },
  /** a ≤3-line S2D2 hook (or the module the hooked step drives) skips the card before the effect */
  hook: {
    "spec-lint-observation.ts": "fs=2",
    "scheduler-deploy-reconcile-facts.ts": "vcs=1", "scheduler-deploy-reconcile.ts": "ledger=1 notice=1",
    "agent-lifecycle-backoff.ts": "vcs=1", "agent-lifecycle-cleanup-archive.ts": "fs=1", "agent-lifecycle-cleanup-gate.ts": "fs=1",
    "agent-lifecycle-cleanup-scan.ts": "vcs=1", "agent-lifecycle-cleanup.ts": "fs=1 vcs=1", "agent-lifecycle-deps.ts": "ledger=1 proc=2 fs=1",
    "agent-lifecycle-run.ts": "proc=1 fs=3", "agent-supervisor-deps.ts": "ledger=2 proc=1 notice=3", "ledger-scheduler-lease-finished.ts": "sql=7 stmt=7",
    "lend-pr-takeover-gh.ts": "vcs=4", "lend-pr-takeover.ts": "ledger=1", "scheduler-autostart-deps.ts": "ledger=2 proc=2 fs=2 notice=1 vcs=1",
    "scheduler-autostart-run.ts": "ledger=3 notice=4", "scheduler-merge-train-gh.ts": "fs=1 vcs=1", "scheduler-merge-train-tick.ts": "fs=1 notice=2",
    "scheduler-merge-train.ts": "notice=2", "session-archive.ts": "fs=1",
  },
  /** retire effects re-route per effect (S2V withSchedulerV2Retire) after scheduler-retire passed the gate */
  s2v: {
    // scheduler-retire-tmp fs=3 counts the TmpCleaner signature `rm(path: string): Promise<void>;` as one site (comments are not scanned)
    "scheduler-retire-deps.ts": "proc=1 fs=1 notice=1", "scheduler-retire-tmp.ts": "fs=3 alias=2", "scheduler-retire.ts": "ledger=4 stmt=1 vcs=1",
    "scheduler-v2-retire-guard.ts": "sql=4 stmt=5", "scheduler-v2-retire.ts": "fs=1",
  },
  /** peer PR cards carry no feature, so their route is always local */
  featureless: {
    "peer-pr-github.ts": "proc=1 vcs=4", "peer-pr-hold.ts": "vcs=1", "peer-pr-intake.ts": "ledger=1", "peer-pr-ledger.ts": "stmt=2", "peer-pr-notice.ts": "ledger=2", "peer-pr-observe.ts": "ledger=1",
    "peer-pr-tick.ts": "notice=2",
  },
  /** lent orders run for peers: their ledgers and the lend journal, not this ledger's feature cards */
  foreign: {
    "lend-claude-worker-capacity.ts": "proc=1", "lend-claude-worker.ts": "fs=4", "lend-clone.ts": "proc=1 fs=2 vcs=14", "lend-config-failure.ts": "notice=2",
    "lend-delivery-amend.ts": "fs=1", "lend-deps.ts": "ledger=3 proc=3 vcs=1", "lend-disk-preserve.ts": "fs=5", "lend-drive.ts": "notice=1",
    "lend-evidence.ts": "fs=4", "lend-usage-report.ts": "sql=1 stmt=2",
    "lend-grant-spawn.ts": "stmt=2 proc=1", "lend-journal.ts": "sql=9 stmt=12 fs=1", "lend-notice.ts": "notice=2", "lend-pane-archive.ts": "fs=3",
    "lend-proc-reap.ts": "proc=1", "lend-push.ts": "stmt=1 proc=1 fs=2 vcs=10", "lend-quota-line-config.ts": "fs=1", "lend-reborrow-preserve.ts": "proc=1 fs=3 vcs=1",
    "lend-receipts.ts": "fs=2", "lend-session-archive.ts": "stmt=1", "lend-trash.ts": "fs=4 alias=1", "lend-update-gap-host.ts": "proc=1 vcs=1",
    "lend-watchdog.ts": "stmt=1", "lend-sandbox.ts": "fs=2", "sandbox-order-owner.ts": "proc=1 fs=3",
  },
  /** SQL of the ledger writer layer: it runs inside a `ledger <sub>` transaction or the gated step that drives it */
  writer: {
    "scheduler-review-stale.ts": "sql=1 stmt=1",
    "agent-lifecycle-schema.ts": "stmt=1", "agent-lifecycle-store.ts": "sql=6 stmt=6", "fix-strategy-remote-order.ts": "sql=1 stmt=1",
    "fix-strategy-remote.ts": "sql=1 stmt=1 notice=1", "fix-strategy-session.ts": "sql=4 stmt=4", "fix-strategy-task-write.ts": "sql=1 stmt=1",
    "ledger-asks-schema.ts": "sql=4 stmt=2", "ledger-asks.ts": "sql=6 stmt=6", "ledger-audit-store.ts": "sql=9 stmt=8",
    // N8B8 dag-write-scrub: read-only `git cat-file --batch-check` (which heads are real commits; argv from peer-pr-github.ts commitQuery), run by the DAG write points below inside their transaction
    "dag-write-scrub.ts": "proc=1",
    // PMAUTO1 observation-plan: mkdir of the plans file's directory, only inside withPlans (the `ledger observation-*` writers); the tick imports its read side
    "observation-plan.ts": "fs=1",
    "ledger-dag-write.ts": "sql=10 stmt=9", "ledger-deploy-schema.ts": "stmt=1", "ledger-feature-schema.ts": "sql=6 stmt=7", "ledger-feature-write.ts": "sql=5 stmt=5",
    "ledger-lend-lease.ts": "sql=2 stmt=2", "ledger-lend-peers-ttl.ts": "sql=1 stmt=1", "ledger-lend-peers.ts": "sql=4 stmt=4", "ledger-lend-queue-schema.ts": "stmt=1",
    "ledger-lend-queue.ts": "sql=5 stmt=5", "ledger-lend-relay-schema.ts": "stmt=3", "ledger-lend-relay.ts": "sql=10 stmt=10", "ledger-lend-schema.ts": "sql=7 stmt=5",
    "ledger-lend.ts": "sql=7 stmt=7",
    // S2F6: the central pool step writes the home row / claim projection only on a central route (skip cards return before it)
    "ledger-lend-central-home.ts": "sql=2 stmt=2", "ledger-memory-schema.ts": "stmt=1", "ledger-memory.ts": "sql=3 stmt=2", "ledger-origin.ts": "sql=1 stmt=1",
    "ledger-pool-refusal.ts": "sql=2 stmt=2", "ledger-scheduler-lease-notice.ts": "sql=4 stmt=4", "ledger-scheduler-lease-sync.ts": "sql=2 stmt=2",
    "ledger-scheduler-lease.ts": "sql=3 stmt=3", "ledger-scheduler-schema.ts": "sql=6 stmt=13", "ledger-scheduler-settle.ts": "sql=2 stmt=2",
    "ledger-scheduler-write.ts": "sql=7 stmt=7", "ledger-steps-write.ts": "sql=3 stmt=3", "ledger-write.ts": "sql=4 stmt=4", "lend-author-family.ts": "sql=1 stmt=1",
    "lend-config-failure-pool.ts": "sql=2 stmt=2", "lend-fix-reassign-start.ts": "sql=1 stmt=1", "lend-fix-start.ts": "sql=1 stmt=1 proc=1 vcs=3",
    "lend-peer-cooldown.ts": "sql=7 stmt=7", "lend-pr-takeover-ledger.ts": "sql=1 stmt=1", "lend-reclaim-scheduler.ts": "sql=4 stmt=4 notice=1",
    // CIRES1: the GitHub read of the leased `ledger scheduler-manual-resume --mechanism ci-manual-resume` (a skip card never reaches that call)
    "manual-recovery-ci-read.ts": "vcs=1",
    "manual-merge-queue.ts": "sql=3 stmt=3", "scheduler-deploy.ts": "sql=6 stmt=6", "scheduler-merge-ci-behind.ts": "sql=1 stmt=1 vcs=1",
    "scheduler-merge-ci-rerun.ts": "sql=2 stmt=2 vcs=1", "scheduler-merge-conflict.ts": "sql=3 stmt=3", "scheduler-merge-handoff.ts": "sql=1 stmt=1",
    "scheduler-merge-train-hold.ts": "sql=3 stmt=3", "scheduler-merge.ts": "sql=11 stmt=11", "scheduler-review-swap.ts": "sql=3 stmt=3",
    "scheduler-sessions.ts": "sql=7 stmt=10", "scheduler-ui-review-carry.ts": "sql=2 stmt=2", "shared-ledger-v2-write-gate-state.ts": "sql=8 stmt=13",
  },
  /** bridge / MCP order tools and owner CLI switches: reachable by import, run for a worker's or the owner's own call, never by the pass */
  outside: {
    // security-pool fs=3: only setSecurityPoolMode writes (the owner's `security-pool` command); the pass only reads the switch
    "security-pool.ts": "fs=3",
    "codex-thread.ts": "proc=1 notice=4", "memory-tools-refs.ts": "ledger=1 sql=1", "memory-vectors.ts": "sql=1 stmt=2 fs=2", "order-deliver-pr.ts": "vcs=2",
    "order-deliver-scope-git.ts": "proc=2", "order-deliver.ts": "ledger=1 vcs=1", "order-ledger-exit.ts": "ledger=2", "order-mark.ts": "ledger=1",
  },
  /** process, file, tmux, store and notice plumbing with no card of its own; its callers are the gated paths */
  infra: {
    // Project CI reads have no card; response writes use the guarded scheduler CLI, never the pass read connection.
    "ci-main-failure-response-runtime.ts": "ledger=1 fs=1 vcs=2",
    "account-usage-refresh.ts": "stmt=1", "acp-turn-gate.ts": "notice=2", "agent-settings.ts": "fs=9", "archive-copy.ts": "fs=3", "bridge-client.ts": "notice=1",
    // card-repo: gitOriginRepo reads the local origin (callers: autostart privateGate after the S2D2 feature hook, spec-resume / local-author
    // under pace); repo-submodules: `submodule update` run by lend-clone (foreign), local-author and review-worktree (pace) with their own git
    "card-repo.ts": "proc=1 vcs=1", "repo-submodules.ts": "vcs=1",
    // scheduler-foreign-repo proc=1: `git config --get remote.origin.url` of the project's repoDir (read only, no card); card callers in the
    // pass are the planner's stageStep from Card.step (auto-tick, after pace.skipTask) and the deploy tick's foreignMerged (after pace.skipTask)
    "scheduler-foreign-repo.ts": "proc=1", "scheduler-main-ci-wiring-gh.ts": "vcs=1", // MAINCIW: read-only gh api of main / its checks
    // GATE1: GET-only gh api of runs / artifacts / commits (no card of its own; asked by the merge driver and the deploy tick after
    // pace.skipTask); fs=2 is the private temp directory an artifact archive is unzipped from
    "scheduler-ci-proof-port.ts": "fs=2 vcs=3",
    "bun-path.ts": "proc=1", "caller-cred.ts": "fs=5", "dag-tools-steps.ts": "stmt=1", "file-lock.ts": "fs=7", "github-release.ts": "proc=1 vcs=1",
    "inbound-ledger.ts": "sql=4 stmt=6", "instance-id.ts": "fs=4", "key-file.ts": "fs=3", "ledger-backup.ts": "stmt=1 fs=2", "ledger-read.ts": "stmt=2",
    "ledger-scheduler-lease-worker.ts": "proc=1", "ledger-store.ts": "sql=5 stmt=8 fs=1", "ledger-tx.ts": "sql=1", "log-paths.ts": "fs=4",
    "media-outbound.ts": "sql=2 stmt=4 fs=4", "memory-retrieve-head.ts": "proc=1 vcs=1", "notify.ts": "notice=1", "pm-notify.ts": "notice=2", "pm-slim.ts": "fs=1",
    "projects.ts": "proc=1 vcs=1", "quota-keychain.ts": "proc=2", "quota-scheduler.ts": "stmt=4", "recovery-machine-policy.ts": "fs=1", "recovery-policy.ts": "fs=1",
    "run-bounded.ts": "proc=2", "run-manager.ts": "proc=2", "sandbox-pi-fs.ts": "fs=3", "scheduler-central-journal.ts": "fs=2",
    // S2F6: the lend outbox file plumbing; callers are the central-route pool step and the bridge's central delivery
    "ledger-lend-central-state.ts": "fs=2",
    "scheduler-local-author-queue.ts": "stmt=3", "scheduler-local-runtime-slots.ts": "stmt=1", "scheduler-local-runtime-start.ts": "stmt=1",
    "scheduler-maintenance.ts": "fs=1", "scheduler-review-worktree.ts": "proc=3 fs=2 vcs=3", "scheduler-yield.ts": "fs=2",
    "shared-ledger-center-claims.ts": "fs=1", "shared-ledger-contract-v2-transaction.ts": "stmt=2", "shared-ledger-mode.ts": "stmt=1 fs=2", "sqlite-migrate.ts": "stmt=2",
    // N8B8: reachable through dag-write-scrub's read of the mirror state (readSharedLedgerMirrors); their writes belong to `shared-mirror` and the cron mirror loop
    "shared-ledger-client-transport.ts": "fs=1", "shared-ledger-mirror.ts": "fs=2",
    "state-file.ts": "fs=7", "sys-memory.ts": "proc=1", "tmux-helper.ts": "stmt=3 proc=24 fs=1", "unmanaged-archive.ts": "fs=4", "update-inflight.ts": "proc=2 fs=2",
    "usage-store.ts": "sql=32 stmt=44 fs=1", "worker-liveness.ts": "proc=1",
  },
};
