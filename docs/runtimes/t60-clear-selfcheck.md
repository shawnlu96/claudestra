# T60 ACP `/clear` — adversarial selfcheck

Scope: `feat/t60-acp-clear`, rebased onto current main `c6dea30a`. A single ephemeral `codex exec --sandbox read-only --ignore-user-config` reviewed the uncommitted diff without editing files or running tests. Its report named three concrete issues:

1. **P1, adapter restart race.** The adapter could exit while the new thread was awaiting registry commit. Its restart timer would attach the old ID, then `/clear` would commit the new ID and report success. The host now defers adapter restart until rotation ends, then attaches the committed ID. Regression: `tests/acp-host.test.ts`, “写 registry 前适配器退出”.
2. **P2, watcher handoff.** A queued new-thread prompt could run before the bridge replaced the old watcher; the old watcher could acknowledge its output under the wrong session. The host now waits for `acp_rebind` acknowledgment after the bridge has installed the watcher. Every outbound batch carries its session ID, and a mismatched watcher refuses it. If rebind is unavailable after registry commit, the call reports incomplete and retries in the background. Regressions: `tests/acp-host.test.ts` and `tests/acp-link.test.ts`.
3. **P2, pinned config.** A rejected model or effort change on the new thread previously logged and continued. `/clear` now requires those settings to apply before bootstrap and registry commit; otherwise it reconnects to the old thread. Regression: `tests/acp-host.test.ts`, “新线程拒绝钉住的模型”.

The first sandbox pass exposed a missing `acp_rebind` dispatch in `bridge.ts`; it was fixed before the final pass. The final isolated sandbox used the repository ACP stub, with no auth file copied or linked: `/clear` returned 200 with a different session ID, registry reported that ID, and a following Web API prompt received a reply. Busy clear returned 409; a wrong expected old ID could not overwrite registry. The isolated sandbox was stopped and cleaned.

Residual limit: the live test uses the stub rather than the pinned external `codex-acp` adapter. Real adapter stability remains a rollout gate before the tmux fallback is removed.

## Restart checkpoint after r5 rebase

The worktree was rebased onto #236 head `cdb0204e` and the stash was reapplied. The focused ACP host/link/slash tests, TypeScript, and strict guard pass. The full strict check reached 6,968 pass and one unrelated multi-process Web build lock race failure (`/tmp/t60-r5-clear-check.log`); that focused lock suite passed 11/11 immediately afterward. A clean full rerun is still required before push. An isolated stub sandbox on port 42695 created an ACP agent, then was cleaned before the planned deployment; the post-rebase live /clear flow still needs a fresh pass.

A second ephemeral, read-only `codex exec` review (`/tmp/t60-clear-r5-audit.md`) found three concrete defects. After rebasing onto deployed main `bc94660d`, all three were addressed:

1. **P1, old result across agents / bridge epochs.** ACP call IDs now include a random bridge epoch; pending calls bind to both channel and socket. A wrong channel, old epoch, or replaced socket cannot complete another call. Disconnect settles the pending call as indeterminate. Regression: `tests/acp-link.test.ts`, two-agent and reconnect cases.
2. **P2, Web chat clear stays pending.** Successful Web chat `/clear` returns a clear result and resets the old messages, cache, and thinking state. Regression: `tests/acp-link.test.ts` for the API response and `tests/web-clear-send.test.ts` for the view transition.
3. **P2, timeout mismatch and unsafe retry.** Clear stages are bounded at 50s new + two 20s configs + 60s bootstrap + 30s registry + 30s watcher = 210s. The bridge call waits 225s, Web clients 230s, and HTTP idle limit 240s. A timeout, disconnect, or post-commit watcher failure reports `clear_result_unknown` (504) and Web chat disables one-click retry; the user checks the current session first. Regressions cover timeout policy, error classification, and post-commit uncertainty.

The post-rebase stub sandbox, strict full check, and entrypoint builds are recorded in the final verification below.

## Follow-up adversarial review

A further ephemeral read-only Codex review (/tmp/t60b-clear-final-audit.md) found four /clear integration gaps and one existing ACP Stop gap:

- Watcher rebind failure after registry commit no longer releases queued human turns. The host resumes them only after the background rebind succeeds; tests/acp-host.test.ts holds the watcher down and verifies the queued reply waits.
- Web chat clear completion acts only when the same agent is still active; tests/web-clear-send.test.ts switches agents before completion.
- The watcher install now has an explicit generation gate (src/bridge/acp-watcher-generation.ts). A delayed registration lookup cannot overwrite a newer clear rebind; a later legitimate registry session change still installs. tests/acp-watcher-generation.test.ts covers both ordering paths.
- The clear response carries the previous session ID. Web chat and the clear button mark it retired, so replayed old-session text/tools/notices are ignored even when the old history cursor did not cover them; later sessions remain allowed. tests/web-clear-send.test.ts covers the fence.
- The review also found that the deployed bridge may report an active ACP turn idle after its own restart, preventing Stop from sending session/cancel. This predates /clear and will be a separate T60b PR. It is a known operational limitation for this PR.

## Final static re-review and live probe

A third ephemeral read-only Codex pass (/tmp/t60b-clear-rereview.md) confirmed the request-ID and watcher-generation fixes, then identified four P2 edge cases. Each has a focused regression:

- The clear button preserves human messages queued during rotation and new-session output; tests/web-clear-send.test.ts checks both.
- A buffered old-session text segment is checked again when its delayed flush runs; retiring the session before that flush cannot put old text back into the cleared view.
- A successful rebind prunes old-session tagged events from the bridge replay ring while retaining queued human messages and new-session events for every Web device; tests/event-bus.test.ts.
- A clear with an initial message refuses to send that message after the user switches agents; the clear itself remains committed and the response says the initial message was not sent.

The final isolated sandbox used only the repository ACP stub on port 42699, with no auth file copied or linked. It verified normal Web API reply (200), clear endpoint (200, distinct new ID and correct previous ID), follow-up reply (200), busy clear (409), and scoped-token Web chat clear refusal (403). The sandbox was cleaned. Owner Web chat clear success is covered through the bridge result test and Web state transition tests because the sandbox token is intentionally not an owner principal.

The Stop finding was narrowed by source inspection: the Web Stop button and API interrupt use the manual gate and still send the ACP abort. A human stop-word request uses the busy probe and can be missed after bridge restart; it remains a separate T60b fix.

## Final verification

- GUARD_STRICT=1 bun run check: 7,201 pass, 0 fail; strict guard green after rebase onto c6dea30a (/tmp/t60b-clear-c6-check.log).
- Eight Bun entrypoints built; Web static build passed with Next Webpack (/tmp/t60b-clear-web-postaudit.log). Turbopack cannot resolve this isolated worktree's node_modules symlink, an environment constraint unrelated to the source.
- The final stub-only sandbox probe on port 42699 passed the normal reply, committed clear with previous/new session IDs, post-clear reply, busy refusal, and scoped-token refusal. The sandbox was stopped and removed.
- The remaining Stop-word-after-bridge-restart issue is in deployed code and will be handled in its own T60b PR. Already-sent old SSE packets on another device may briefly render before history reconciliation; the server replay ring now excludes them after rebind.

The final PR branch was rebased onto c6dea30a; the session-archive call in manager/set-session.ts uses the current runtime-aware archiveAgentSession helper.
