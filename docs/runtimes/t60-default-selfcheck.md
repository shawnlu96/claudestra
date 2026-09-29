# T60 default ACP migration: adversarial self-check

One read-only `codex exec --sandbox read-only --ephemeral` review examined the
uncommitted default ACP and migration diff. It found two actionable paths:

1. **P1: ordinary restart could strand an ACP agent.** The adapter hash and
   `app-server --help` can pass while `session/load` fails. Before the fix,
   `restart` killed the old host, reported failure, and kept `transport: acp`;
   only `migrate` tried tmux. The restart path now stops the failed ACP host,
   records a pending migration, and starts the same thread through tmux. A
   regression injects an ACP launch timeout and checks that tmux starts and
   the retry marker clears only after readiness.
2. **P2: manual tmux on a legacy record was not sticky.** With no transport
   field, `transport old tmux` compared equal after normalization and saved
   nothing. The next update migrated it back to ACP. The command now persists
   an explicit `tmux` value even when the effective mode was already tmux.
   The regression runs the manual choice and then the migration planner to
   check that the owner's rollback is preserved.

Additional checks cover old CLI help output that exits 0, fixed-version
adapter installation failure, failed ACP migration restart with a tmux retry,
an idempotent second migration, and sandbox protection against running real
Codex TUI. A live sandbox with the repository ACP stub created a Codex agent
without `--transport`, sent a message, simulated a legacy registry entry,
ran `migrate`, resumed the same session, and saw a no-op on the second run.
No production credentials were copied or linked into the sandbox.

The update sequence now defers ACP host restarts until the new bridge is
listening. Tests check project migration runs first and that a project
migration error does not suppress ACP migration. Startup skips agents already
temporarily on tmux; an explicit `manager migrate --acp` retries them.

The manual `transport <agent> acp` command reports the registry's actual
transport after restart. If the ACP start falls back to tmux, it reports the
fallback and an error instead of claiming ACP succeeded. Six Bun entrypoint
builds and the strict check passed after these changes.

The owner-reported Codex tmux interruption/queue failure is covered by an ACP
busy-message regression. The bridge interrupt gate emits no Esc and no
"interrupted" status for a busy Codex ACP channel. A real ACP host, stub
adapter, channel-server and tool proxy then receive a second human message
while the first turn is paused: steering injects it into that turn, the reply
confirms receipt, the original turn ends normally, and exactly one Stop is
reported. The stub's short pause keeps this path deterministic in CI.

Follow-up inspection also found that a new agent created with explicit
`--transport tmux` needs the same sticky registry value as a manual rollback;
the create path now writes it. A failed ACP launch in the sandbox cannot fall
back to a real Codex TUI, and the sandbox command gate rejects that switch.

An isolated bridge restart also exercised the automatic peer upgrade path:
after removing `transport` from a sandbox Codex record, the restarted bridge
restored `acp` with the same sessionId, and the API returned another stub
reply. The sandbox and its temporary token were removed. A later audit found
that a thrown restart subprocess error would have stopped migration before
later agents; the migration now records that agent as failed, keeps its retry
marker, and continues. A regression covers the sequence.

## r5 repair check

The old updater invokes bare `migrate` before daemon reload. A repair keeps
that invocation limited to worker→agent migration; only `--startup` (after the
new bridge listens) and `--acp` run ACP migration. Existing ACP agents are
left alone by automatic migration and transient readiness failures. The
reviewer's original #232 probe now passes, as do new command-dispatch and
active-agent regressions.

The r5 delivery probes found that a poisoned entry made the bridge reject an
entire batch forever, duplicating earlier text on every retry. The bridge now
acknowledges processed entries with a loss count, including sequence gaps;
the host bounds retries and reports StopFailure for any loss. A bridge epoch
distinguishes cumulative loss counters across bridge restarts. Busy slash
commands queue as an independent prompt turn; steering has no local 30-second
timeout, so a delayed result cannot turn into a second prompt. ACP slash
commands on Discord are refused with a Web instruction.

A fresh read-only ephemeral `codex exec` review found three edge cases. The
bridge-epoch and Discord findings were fixed; the epoch has a regression test,
and the Discord path is guarded before any tmux key injection.
The remaining case is an adapter that holds an open connection forever but
never answers steering: the turn queue must wait because retrying or opening
another prompt could duplicate or overlap a turn the adapter already began.
The adapter exit path resolves the wait; an indefinitely live, unresponsive
adapter still needs an explicit recovery protocol. This is recorded as a
remaining availability limit, with delivery kept conservative.

The same pass fixed the r5 resume P2: resuming a same-name agent now preserves
an explicit manual tmux choice, including fork resume; a temporary tmux
fallback remains eligible for ACP when conditions recover.

An isolated stub-only sandbox created a default ACP Codex agent and sent a
second Web message during a paused first turn. Both requests returned 200;
the first reply confirmed one inserted message and the first turn completed.
The sandbox was cleaned, with no auth file copied or linked.
