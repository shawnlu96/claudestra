# Agent-to-agent messaging: delivery, inbox, return routing

How a `send_to_agent` message reaches a busy agent, and how the answer finds its way back. Code: `src/bridge/held-queue.ts`, `held-flush.ts`, `inbox.ts`, `agent-calls.ts`, `peer-call-book.ts`, `lib/held-pac.ts`.

## Why messages are held

Claude Code silently drops a channel notification that arrives while a turn is starting (verified 2026-08-28). So when the target is in a turn (or compacting), `deliverToLocal` does not `ws.send` an agent→agent message — it **holds** it and tells the sender `queued` ("the other agent is busy, queued"). Human / API messages are not held: they interrupt (C-c) and are delivered.

## Held queue (`held-queue.ts`)

- Persisted to `~/.claude-orchestrator/held-messages.json` (ws stripped; the current connection is looked up by channel id at delivery), so a bridge restart loses nothing.
- `hold()` is idempotent per envelope object: re-holding the item being delivered (flush hands `deliverToLocal` the queued env itself) keeps the original, with its first-held time. Not keyed by `message_id` — button clicks on one Discord message share it.
- Nothing is dropped on a timer: after 30 min the sender is told it is still queued; after 24 h it gives up and says so.

## Flush (`held-flush.ts`)

Triggered on Stop, on compaction end and by a one-minute sweep. One deliverer per channel (`claim`), iterates a snapshot, and:

- skips while compacting; while the target is working only human messages go through;
- skips items leased by `check_inbox` (below);
- re-checks each item is still queued before and during delivery (`stillWanted` inside `deliverToLocal`) — items removed by kill cleanup or the 24 h give-up are neither sent nor re-held;
- if the target turned busy again (`note: "queued"`), stops and leaves the original in place;
- touches the return slot of that message's sender **before** dequeuing, then dequeues.

Delivery is **at least once**: a crash between send and dequeue re-sends; receivers see the same `message_id`. There is no runtime dedup.

## `check_inbox` (`inbox.ts`)

Lets an agent in a long turn pull what is queued for it, as a tool result.

- **Lease, not dequeue**: a batch (`inbox_<uuid>`) is leased; `check_inbox({ ack })` confirms it (dequeues) and takes the next batch. An unconfirmed batch is not delivered by flush during the 15 min lease, then is delivered normally (same `message_id`).
- Calling without `ack` while a batch is unconfirmed returns that batch again (no new lease) — covers a lost tool result or a cancelled turn.
- Budget: ≤ 10 messages, ≤ 15 000 chars of bodies. A longer message is not batched; it gets a 2 000-char preview (max 3 per result) and can be read in 12 000-char pages with `check_inbox({ read: <message_id>, page })`, which leases it on first read. Bridge-generated ids are `prefix_<ms>_<rand>` (`newMessageId`); a `thread_id` is still accepted, and paging hints echo whichever id was passed.
- A leased request counts as **seen** by the target for return routing (`unseenFrom` only lists unleased items).

## Return routing (`agent-calls.ts`)

`send_to_agent` records who is waiting for whom, so the target's answer is pushed back to the caller without polling.

- One slot per **(target, caller)**; inside it, **one entry per request** (`message_id`, `expecting`, reply channel). Persisted to `pending-agent-calls.json`; old formats migrate on load.
- A request counts as seen once it is no longer held (or is leased). Answers only ever consume the requests the target has seen.
- **Explicit answer** (target `send_to_agent`s the caller, or replies into the caller's channel): consumes the caller's seen requests.
- **Unaddressed answer** (target replies in its own channel, or ends the turn with text): pushed back only if exactly one caller has seen requests. With several callers waiting, nobody gets it (no guessing, no broadcast) and the target is told once to answer each with `send_to_agent`.
- Several seen requests from the same caller share one answer (their `expecting`s are joined); unseen ones stay for a later answer. There is no explicit per-request reply id yet.
- Expiry is per request: each one expires 2 h after it was actually delivered (`deliveredAt`, not when it was sent); requests still held never expire, and a slot survives as long as it has requests left. Entries from older files without `deliveredAt` fall back to the slot timestamp. Killing / taking over a channel drops its slots.

## Cross-machine calls (`http-peer.ts`, `peer-call-book.ts`)

After the peer accepts a request and returns a thread id, the bridge polls it (30 s, up to 2 h). Polling state is persisted, so a restart resumes it with the original deadline. Each poll re-reads the peer (token rotation) and checks its stable identity (`instanceId`, else base URL); a deleted or replaced peer ends the call with a notice. Cancelling (user takeover / kill) removes the record immediately. The answer is pushed back even if the caller is offline or the push fails — it goes to the held queue. Push-back message ids derive from the call id.

## Known limits

At-least-once delivery without runtime dedup; nothing sent can be recalled; a crash between the peer accepting a POST and the thread id being saved loses the thread (needs an idempotency key on the peer side); no explicit reply id per request; no mid-turn hint yet (a PostToolUse hook that only announces unread counts — it needs hook registration via launch `--settings` with a migration).
