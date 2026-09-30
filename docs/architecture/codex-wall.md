# Codex usage wall

When a Codex account hits its usage limit, Claudestra stops waking the Codex agents on that account, recognises by itself when usage is back, and then picks up where things stopped. It is the Codex counterpart of the Claude Code quota wall (`lib/quota-wall.ts`, `bridge/quota-wall.ts`), kept separate so the CC wall's behaviour stays exactly as it was.

Code: `src/lib/codex-wall.ts` (pure state machine), `src/bridge/codex-wall.ts` (runtime, all dependencies injected), `src/bridge/codex-wall-wiring.ts` (production wiring), `src/manager/codex-wall.ts` (CLI). Tests: `tests/codex-wall.test.ts`, `tests/codex-wall-runtime.test.ts`.

## One wall per Codex account

A machine is logged into one Codex account at a time, so there is a single wall that records which account it belongs to (the quota scheduler's `current.codex` key, an HMAC). If the logged-in account changes, the wall is considered gone. State lives in `codex-wall.json`, separate from `quota-wall.json`, and survives bridge restarts.

## Entering

- A Codex turn ends with the ⛔ usage-limit entry (`assistant_text` with `rateLimited: true` from the watcher). This covers both ACP failures and tmux Codex rollouts, so nothing under `lib/acp/` is touched. A limit on a single model ("reached your gpt-5 limit") is not an account wall.
- The quota scheduler's `codex_usage` view shows ≥100% or `limitReached`. After a manual clear or a timed exit, usage has to be seen below 100% once before it can re-enter from usage, so a stale 100% does not immediately close the wall again.

When entering, the wall snapshots which agents were waiting on that Codex agent (the pending-call book plus the callers that opened the turn), because the ⛔ turn settles their reply slots right afterwards.

## Holding

While the wall is up, agent and bridge messages to a Codex agent are held in the existing held queue with reason `codex_quota_wall`. Messages from people still go through, using the same rule as the CC wall (`gatesAsHuman`). Held items with either wall reason are never aged out. The CC wall's release, count and channel functions only look at `quota_wall`, and the Codex wall only at `codex_quota_wall`. Senders see a `heldBy: "codex_quota_wall"` outcome.

## Recognising recovery

Every 15 seconds the wall reads the scheduler's view, which makes no request. While the wall is up, `codex_usage` is also refreshed every 5 minutes, again once when the try-again time from the ⛔ text has passed, and right away when the held reset-credit count drops (the owner redeemed a card). The scheduler's own interval, backoff and cooldowns still apply. The wall exits when:

- `usage`: a reading newer than the wall shows below 100% and `limitReached` is false;
- `account`: a different Codex account is now logged in;
- `cli`: `manager codex-wall clear` (a file mailbox, like `quota-wall clear`);
- `resets_at`: no reading could be taken (the quota service is off, credentials failed, or the scheduler is backing off) and the try-again time plus 60 seconds has passed, or 5 hours have passed when the ⛔ text gave no time. If the account is still out, it simply hits the wall again.

## Recovery (in a fixed order, recorded step by step, resumed after a restart)

1. **flush**: held wall messages go back to normal held status and are delivered.
2. **resume**: each agent whose turn failed inside the wall gets "Codex 额度已恢复，继续你被打断的任务；先核对做到哪一步再动手". Agents woken by a delivered message from an insider are skipped, and so are agents already running. The original turn is never replayed automatically.
3. **cards**: Codex quota cards still open are dismissed. This means both the in-memory ACP cards and the open ledger asks with `extra.quota`.
4. **callers**: every agent that received the ⛔ is told the Codex agent is back. The ⛔ settled its reply slot, so it has to ask again if it still needs the result.
5. **owner**: a summary goes out through the same owner channel as the CC wall's notices (`controlChannelSender`, which web clients see as well). It is an inform, and it is retried on the next tick if sending failed.

Steps 2–4 only run when recovery is confirmed, meaning usage dropped (including the re-check after a card was redeemed), a manual `clear`, or a newly logged-in account whose usage is below the limit. A `resets_at` exit, or an account switch where the new account is also full, only runs step 1. The owner notice then says recovery was not confirmed and lists the interrupted agents that still need someone to resume them. Sending the resume message there would let every interrupted agent hit the wall again if usage is still out.

If the wall is re-entered mid-recovery, the old recovery stops, and any agents it had not resumed yet carry over into the new wall.

Not done automatically: redeeming cards, switching models, and replaying the interrupted turn. Pi is out of scope.
