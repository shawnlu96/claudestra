# T60 PR #227: adversarial self-check and r4 probe results

Checked at `6125d6aa` before the follow-up changes in this PR. The one-time
`codex exec --sandbox read-only --ephemeral` review examined stream delivery,
permission lifecycle, and failure reporting. Its three findings were reproduced
with isolated fixtures and fixed here:

1. **Bridge restart could stall a surviving host forever.** A new bridge lost
   its sequence watermark and rejected a host that continued at sequence 2 or
   later. `acp-link.ts` now accepts the first batch from a previously unseen
   host at its current sequence. The host marks any mid-turn disconnect as
   uncertain, so that turn still ends with `StopFailure` and a channel warning.
2. **A watcher lock timeout could acknowledge unseen entries.** A concurrent
   retry could arrive while Discord I/O held the watcher lock; after five
   seconds the watcher returned without processing, but the bridge replied
   `true`. ACP batches now serialize per channel and the watcher returns
   `false` on timeout or processing error. Tests hold Discord I/O while a
   retry adds text and verify that the text is delivered before acknowledgement.
3. **An aborted turn could still accept a permission.** `session/cancel` left
   the pending permission in the host. Abort and turn completion now revoke
   pending permissions. The regression test clicks the old card after abort
   and verifies that it cannot authorize a tool call.

The original r4 probes from `T60-codex-pr2-r1` were also run against
`6125d6aa` in an isolated temporary copy:

- P1-1 stale permission card: probe passed (old card returns 409).
- P1-2 entries acknowledgement: the original fixture hit Bun's five-second
  test timeout because it used the production 90-second drain. With only the
  fixture drain shortened to 60 ms, its old `Stop` expectation failed:
  the host now reports `StopFailure` when delivery cannot be confirmed.
- P1-3 sandbox stub spoofing: the old assertion failed because the host
  selected the repository stub rather than arbitrary supplied argv.
- P2 permission timeout: the existing r4 regression passes (old card 409).

This follow-up also checks separate generations for same-text quota failures,
both Discord and Web permission answers, bounded queue overflow, host restart,
bridge restart, and a warning in the agent channel when entries may be lost.
No production credentials were used in the sandbox run.
