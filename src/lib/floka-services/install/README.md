# CLI and service maintenance

`rename.services` and `rename.cli` default to `off`. Either `observe` produces
a plan and performs no installation. Services `on` requires CLI `on`; CLI alone
installs identical `floka` and `claudestra` wrappers using the legacy services.
Custom absolute wrapper locations can be retained through `rename.cliPaths`.
Existing product wrappers found on PATH are retained automatically.

The STATE2 maintenance panel supplies owner approval buttons for services,
runtime and config. Its existing HMAC key protects the new buttons. Grants are
single use and bind the action and transaction. `state-maintenance services
<txId> [resume|rollback|retire] --grant <token>` dispatches the service operation;
runtime/config each use their own explicit transaction through CONFIG1.

The parent consumes the grant and submits a temporary `ai.floka.maintenance.*`
job through `lib/launchd-oneshot.ts`, shared with deployment. The runner checks
its XPC service identity and refuses the four daemon main PIDs. Each job and
request executes at most once. Results precede bootout and plist cleanup; a new
grant creates a new job to resume an interrupted transaction.

The shared STATE2 executor lock excludes legacy installers and concurrent
maintenance. The service snapshot, original CLI entries, immutable old plist
backups, process identities and durable journal live outside state/runtime
roots. Preparation does not put new plists in LaunchAgents or load them.
Old CLI paths gain a transaction guard before any old service is unloaded.
Wrappers repair only the committed side, reject opposite registrations and
refuse attach during a transaction. Install/update never initiate a switch.

Before the first target load, two STATE2 scans confirm old jobs and other
writers stopped; the unchanged tmux server and already-running target jobs are
allowed. Identity and runtime socket proofs are checked again. Main processes
count instances; tracked descendants still block exit confirmation. Bridge
health checks both HTTP and listener ownership. Rollback restores CLI/plist
configuration while preserving current application data. Explicit terminal
retirement retains the snapshot/journal and permits a fresh transaction ID.

All acceptance executes against temporary homes and fake launchd/process ports.
No install-cli command or real launchd mutation is used for verification.
The approval buttons currently require Discord; web approval is a separate PM card.
