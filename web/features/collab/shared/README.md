# Shared planning surface (C4)

C5 can mount `SharedLedger` from `shared-ledger.tsx` with
`{ identity: { center, team, person, project, machine, homeInstanceId? }, language }`.
`machine` is the paired machine fingerprint used by the existing API client;
center/team/person/project are supplied by the caller's verified membership context.
These strings partition the browser cache; they do not authorize server access.
`homeInstanceId` supplies the registered planning home code when it differs from
the paired machine fingerprint; the new-feature form remains editable.
The bridge maps the actual identity/team and signs transport requests.

No production navigation is registered here. All traffic goes through the existing
API client to `/api/v1/shared-ledger/{features,features/:id,commands,commands/:requestId}`.
The injected `Transport` is for isolated tests and previews.

The session polls complete consistent snapshots every five seconds, reuses equal
watermarks, and refetches on watermark rollback. There is no paginated/delta endpoint
in the V1 contract. Changing identity remounts the UI and aborts old requests.
Staleness still updates when the server watermark remains unchanged.

A rewrite preserves bound nodes exactly. A 409 preserves the draft and its base,
displays the latest graph, and requires explicit rereading before another submit.
Rereading starts from the latest graph and replays local changes against the old
base. Teammate additions remain, bound nodes require the latest choice, and
concurrent edits/deletions require explicit per-node resolution before submission. A network/response failure keeps the request ID for receipt lookup;
no command is automatically resubmitted. Unknown receipts retain the draft.

Graph rendering and diff panels receive adapted props from the existing `dag/`
components. The diff compares the current in-session previous/base snapshot; the V1
wire contract has no historical-version endpoint. The UI never fabricates history.
The contract also has no machine heartbeat/presence field: source freshness and
unknown home presence are displayed separately.

Screenshot harness (ephemeral loopback server, no production bridge):

```sh
SHARED_LEDGER_SHOTS_DIR=<review-directory> \
  bun test tests/web-shared-ledger-browser.test.ts
```

Without that environment variable the browser test skips. It builds the standalone
`fixture-harness.tsx` with Bun and launches headless Chrome. It captures list/detail/
new/conflict in light/dark at 390/1400, checks horizontal overflow, locked fields,
disabled execution buttons, discard, reread-and-submit, and the actual session's
409 flow. `before-*` explicitly records that baseline `1307554e` has no shared UI;
`after-*` captures the implemented surface, not a production screenshot.
