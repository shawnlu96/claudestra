# T60 ACP fork: adversarial selfcheck

One ephemeral `codex exec --sandbox read-only` review inspected the uncommitted
diff against `feat/t60-acp-prune-prep`, with emphasis on source thread safety,
new ID registration, Web clear behavior, peer continuity, and sandbox isolation.

## Finding and resolution

- **P2:** The Web `/clear` endpoint returned 409 for ACP, but a chat message
  containing `/clear` fell through the Codex command table and was sent as an
  ordinary ACP prompt. Fixed by checking ACP state before the command table
  fallback. Owner receives 409, guest receives 403, and neither path sends a
  tmux key. The Web test covers this path.

The reviewer found no other concrete regression. Its protocol review could not
verify the pinned adapter implementation because that source is not vendored.
The pinned upstream 2.0.0 source declares `fork`, implements `session/fork`, and
unsubscribes the new thread after forking; the bootstrap explicitly resumes it
before prompting:

- <https://github.com/agentclientprotocol/codex-acp/blob/v2.0.0/src/CodexAcpServer.ts>
- <https://github.com/agentclientprotocol/codex-acp/blob/v2.0.0/src/SessionFork.ts>

## Executor verification

- `GUARD_STRICT=1 bun run check`: 6,951 pass, 0 fail before the Web chat fix;
  a final strict run after the fix is recorded in the PR description.
- Six Bun entrypoint builds passed.
- Direct ACP stub process test: fork returned a distinct ID, resumed the new
  thread, and completed a subsequent prompt without reading Codex auth.
- Isolated sandbox on port 42689: ACP stub agent created; Web `/clear` returned
  HTTP 409, and a subsequent Web message returned HTTP 200 with a stub reply.
  The sandbox was cleaned.
- The sandbox forbids `manager resume`, so the manager's registry handoff is
  covered by a focused test that rejects a repeated or malformed fork ID.

## r5 rebase selfcheck

After rebasing onto the r5 #232 fixes, a second ephemeral read-only `codex
exec` review focused on the resolved `cmdResume` conflict. It found no fork
handoff or manual tmux rollback regression. It did find that Web chat
`/clear` with an attachment returned early before the ACP refusal, allowing
the text to be delivered as an ordinary prompt. The ACP `/clear` check now
runs before the general attachment bypass; owner receives 409 and guest 403
whether or not an attachment accompanies the command. The updated Web test
asserts both cases and no tmux injection.

The rebased branch passed a strict full check (6961 tests), eight entrypoint
builds, and a stub-only sandbox Web message (200) plus `/clear` refusal (409).
The sandbox was cleaned without copying or linking Codex credentials. The
final strict check after the attachment fix is recorded in the PR description.
