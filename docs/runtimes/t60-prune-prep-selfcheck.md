# T60 ACP source extraction: adversarial selfcheck

Reviewed the uncommitted diff against `feat/t60-acp-default` with one ephemeral
`codex exec --sandbox read-only` invocation. The reviewer inspected runtime adapter
method inheritance, shared Codex session source and control, imports, transport
selection, sandbox behavior, and peer paths without editing files.

## Reviewer result

> No concrete regressions found in the uncommitted ACP extraction against
> `feat/t60-acp-default`.

The reviewer found that the ACP adapter retains session reading and ACP control
while dropping tmux lifecycle methods. It found no new import cycle or changed
transport, sandbox, or peer routing path. Its residual risk was that the review
itself was source-only; it did not execute the runtime or cross-version peer calls.

## Executor verification

- `GUARD_STRICT=1 bun run check`: 6,948 pass, 0 fail; strict guard passed.
- Bun builds of `bridge`, `channel-server`, `manager`, `launcher`, `cron`, and `setup`: passed.
- Isolated sandbox on port 42688: ACP stub Codex agent created with `transport: "acp"`;
  Web API message returned HTTP 200 and a stub reply. Sandbox was cleaned.
- Cross-version peer calls remain a separate integration gate for the transport
  migration PR; this extraction does not change peer APIs or routing.
