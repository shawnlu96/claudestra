# Service rename plan

`createServicePlan(id, plistInput)` describes the four daemon labels and renders
staged plists through the existing `daemon-plist.ts` generator. The hardening
CLI/CLIP/PLIST split is retained: no installer or wrapper entry is changed.
Importing this package has no machine-path, filesystem or process side effects.

`runServicePlan({ plan, rename: { services }, controller, action })` defaults to
`off`. Unknown switch values also fail closed to `off`. `observe` returns the
pure plan without even reading the controller, acquiring a lock or writing a
journal. `on` operates only through injected ports. There is no host adapter or
configuration/CLI wiring in this package; enabling a real switch is future work.

## Ordering

All four daemons cross each barrier before the next stage:

1. Audit retired autostart/web; reject missing/unknown/live/restartable legacy jobs.
2. Prepare immutable old-config backups and new staged plists, without loading.
3. Unload old registrations and disable their automatic restart sources.
4. Confirm all old PIDs (including tracked descendants/orphans) have exited.
5. Load new labels; recheck the entire old set before each individual load.
6. Verify all new instances and their health; only then commit.

Rollback first records its durable intent, then unloads all new jobs and confirms
exit. It also quiesces any remaining old jobs before restoring the old backups.
Only after restoration does it load old labels, verify health and commit the old
side. Launcher is last within each stage. Rollback never re-enters forward work.

## Adapter obligations

- One machine/service-set lock and journal must cover all transaction IDs. Other
  installers and restart actors must honor the same lock and active journal. A real implementation
  should reuse the repository lock helper; its lease must cover in-flight calls.
- Journal saves are atomic and durable. The plan identity includes all rendered
  bytes. Changed plans, corrupt cursors and unknown versions are refused. A
  different transaction cannot replace the journal, even after completion;
  retiring it is a separate operation outside this package.
- All mutations must be idempotent by transaction/service. A rejected promise
  can mean the effect already happened. In particular, prepare must never
  overwrite the original backup on replay, and load must be bounded and safe
  when its previous reply was lost. Restore is a no-op if nothing was prepared.
- Unload must prevent KeepAlive and other automatic restart sources, rather than
  merely killing a PID. It retains configurations even if prepare did not finish,
  so an early rollback can reload untouched old settings. Inspect includes tracked processes even
  when a registration is absent. Unknown observations are explicit `null`.
- Preparing/restoring configurations never loads them. Commit retains backups
  and recovery metadata. A real controller must validate staged plist identity
  against the supplied label before making it eligible to load.

## Recovery

The durable cursor names the next operation. It is saved before effects and
advanced only after a successful step. Errors return `blocked` with diagnostics;
no unprotected or speculative compensation follows an uncertain result. Resume
rereads the journal under the lock and rechecks live facts. A loaded target is
reused after a lost load reply; stale exit and health evidence never authorizes
a fresh load or commit. Failed health can be retried or explicitly rolled back.

| Failure boundary | Next invocation |
| --- | --- |
| Before/after preparation or unload | Repeat the idempotent operation |
| PID exit unknown, pending, or job still registered | Stay blocked; load neither opposite label |
| Load succeeded but reply/checkpoint lost | Inspect registration; reuse existing target |
| Health failed or commit reply lost | Recheck current health, repeat idempotent commit |
| Rollback restore/load failed | Continue rollback from its cursor |
| Journal save uncertain or lease lost | Stop; reacquire lock and reread durable journal |

The fake-controller suite injects failures before and after every semantic
effect and checkpoint in both directions, asserting one live PID and exclusive
KeepAlive registrations after each operation. No real service command is used.
