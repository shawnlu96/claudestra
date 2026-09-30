# T60b: migration after a turn, without interrupting it

Bridge startup previously restarted every active legacy Codex record. Updating while a turn was running could truncate the work. Startup now only marks active legacy records as tmux + acpPending; inactive records can be migrated without a process restart. Existing ACP sessions and explicit manual tmux choices are untouched.

A non-overlapping 30-second sweep retries pending records. It holds all new channel messages in the existing durable queue and waits for the receiver to finish in-flight sink deliveries. A receiver without the drain handshake is conservatively deferred. The exit path requires two empty current prompts, excludes busy/dialog/draft states, and only sends /quit + Enter. It never sends Esc/C-c or force-kills. The launch path parks the old window and starts ACP with a direct new-window command, retaining the thread ID. Failed launches remain eligible for safe retry; strict window/PID discovery never treats failed inspection as confirmed absence.

The same PR fixes the four #249 review items: ACP dispatch and inbound metadata moved out of bridge.ts; event-bus additive-only/R6 contract restored; bootstrap permissions automatically denied and logged; default HTTP idle timeout restored to 30 seconds with only POST /api/v1/agents/:name/clear receiving 240 seconds. Manager list now queries the ACP host's real loop state and matches the session ID, treating unknown status as busy.

## Decisions for owner review / 已定（待 owner 复核）

- Unsupported legacy receivers keep their working tmux session and acpPending. Doctor points to manual migration after the turn; there is no unsafe guessed drain fallback. This preserves peer upgrades even when the old running process cannot understand the new handshake.
- Parked old shell windows remain available. They are not automatically killed, because owner could have started another process there during migration. Cleanup can be manual or a separate retirement change.
- Concurrent direct terminal typing during the final TUI /quit submission is outside the bridge message hold; remote messages are queued. No destructive fallback is used, and draft/busy states visible in either capture defer migration.
- PM-to-ACP steering is a separate PR so message classification and principal/role authorization receive their own review.

## Adversarial selfcheck

Ephemeral read-only codex exec reviews were run against the entire implementation, with production state and secrets excluded. Reports: /tmp/t60b-migration-audit2.md through audit5.md. Tests requiring temporary writes were inspected rather than executed inside the read-only review sandbox.

Round 2 found two P1s and a P2: generic restart could interrupt a replacement process; the message hold did not drain the legacy receiver; failed restart-pending ACP records were stranded. All three were fixed with a separate launch path, a receiver drain barrier, and safe retry eligibility.

Round 3 found two P1s and a P2: a historical empty prompt could submit a current draft; a launch command could be typed into a replacement in the same window; failed process inspection could mean empty. Fixed by checking the last current prompt and trailing multiline content, direct new-window launch with preserved old window, and strict process inspection.

Round 4 found a P1 in non-strict window enumeration. All automatic migration lookups now use strict discovery, and a regression distinguishes query failure from confirmed absence. The sandbox also caught a rename-window argv mistake; positional syntax was corrected and recovery succeeded.

Round 5 confirmed the fixes with 0 P0/P1. Read-only source/test inspection only; the executor runs the tests below.

## Validation

- Focused safety tests cover busy/draft/menu refusal, current-prompt races, no forceful exit fallback, drain blocking and stale acknowledgments, all message sources held, old receiver refusal, write-lock failure, safe retry, host-backed idle status, strict window/PID errors, and scoped HTTP timeout.
- Stub-only sandbox: startup while busy changes only migration bookkeeping, no restart; manager list reports idle=false while busy and idle=true after completion; human message steers into the current turn; original reply, clear, and post-clear reply succeed.
- A fake legacy TUI plus receiver drain handshake verifies zero keys while busy, then migration to ACP on the same session after idle. No auth file was copied or linked and no real Codex adapter/TUI was used in the sandbox.
- Seven Bun entrypoint builds passed. Final GUARD_STRICT=1 bun run check: 7,295 pass / 0 fail, typecheck and strict guard green. Guard also passed against explicit PR base 4ae748b3. One prior legacy-web random-port collision failed; that file passed 6/0 on rerun, then the entire check passed. Final selfcheck: 0 P0/P1.

Remaining work: PM agent messages steer; retry horizon 24s versus watcher 60s; permission claim lost acknowledgment; host exit fallback; interruption details; remaining tmux retirement. These are not changed by this PR.
