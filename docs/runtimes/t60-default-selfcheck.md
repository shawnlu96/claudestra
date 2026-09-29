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
temporarily on tmux; an explicit `manager migrate` retries them.

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
