# Peer PR auto review (i28-A2)

The scheduler takes a configured peer's GitHub PR in as an auto card, has it reviewed on this machine by a cross-model
review session, pushes the redacted report back to the peer with an HTTP receipt, re-reviews every new head the peer pushes
(the same review session, at most `maxRounds`), and lets a PR with only P2 left into the existing merge queue. Everything it
cannot handle goes back to the PM through the existing `scheduler-fallback-manual`; nothing in this path merges, deploys or
touches the merge intents itself.

## Switch: `peer-prs.json`

`~/.claude-orchestrator/peer-prs.json` (PM writes it; no names or accounts live in code). Missing or `"enabled": false` =
the peer step makes **zero** calls. Unreadable or invalid = the step is skipped and reported in the pass's `failed` list —
never a partial guess. It is read fresh by every reader (the tick, the intake CLI, the bridge sender).

```json
{
  "enabled": true,
  "project": "<scheduler.json project>",
  "fromNumber": 311,
  "pollSec": 60, "headSettleSec": 90, "maxOpen": 2, "maxRounds": 2,
  "replyTo": "<agent>@<my peer name>",
  "extraSecurityGlobs": ["src/lib/ledger-*.ts"],
  "peers": [{ "peer": "<peers.json name>", "fp": "xxxx-xxxx-xxxx-xxxx", "agent": "<their agent>",
              "githubLogins": ["<login>"], "authorFamily": "claude" }]
}
```

`repoDir`, required checks and deploy come from `scheduler.json` (`lib/peer-pr-config.ts`). The step only runs when
`scheduler.json` has `autoDispatch: true`.

## Lifecycle

| Step | Where | What |
|---|---|---|
| Poll | `peer-pr-tick.ts` | once per `pollSec`: `gh pr list` in `repoDir` (GH_REPO dropped, prompts off, 30 s cap) |
| Classify | `peer-pr-intake.ts` `classifyPr` | unconfigured author → skip; fork / other head owner, base ≠ main, odd branch → tell PM once; draft, `maxOpen` reached, head moved within `headSettleSec` → wait |
| Intake | `ledger peer-pr-intake --number --head` | the caller names only the number and the head it fetched; the command reads the PR from GitHub itself (`verifiedIntake`: this repo's URL, open, same head, configured author, same head owner / not a fork, base main, branch, not draft) and refuses with nothing written on any miss. Then one transaction: card `PR<n>` (assignee = the peer agent, `extra.peerPr`, `extra.delegate`), spec written to `ledger/peer-prs/PR<n>.md`, workflow **security v2 auto**, spec→restate→build as PM, build→review delivered as the peer at the PR head |
| Surface | `peer-pr-surface.ts` (inside intake) | the PR's file list → `security` / `plain` (rules are data; unreadable / >300 files = security) |
| Review | existing auto tick | reviewer session of the other family; the head must already be a local commit (`refs/claudestra/peer-pr/<n>`, fetched by the peer tick) |
| Push | `peer-pr-push.ts` → bridge `peer_pr_push` → `bridge/peer-pr-send.ts` | every verdict, every `merged` merge phase, every queued drift note |
| Hold | `peer-pr-hold.ts` (auto tick hook) | after a verdict the planner waits until the peer tick re-read the PR and saw the same head; a card in `fix` always waits for the peer |
| New head | `peer-pr-observe.ts` → `ledger peer-pr-observe` | stable new head: fix → delivered as the peer (next round, same reviewer session); review with this round's verdict → review→fix first |
| Exit | `fallbackOnce` | PR closed / merged outside the queue / base changed / turned cross-repo / still P1 at `maxRounds` / drift after the last round → manual + one PM notice |

A new head while the card is in `merge` only tells PM and the peer (the merge queue stops on the head mismatch itself).

## What leaves the machine

`redactPeerPr` (`peer-pr-redact.ts`): `sanitizeForeign` first, then temp paths, `-Users-<name>-` project dirs, this host's
name and user, and every 32+ hex value that is not a commit of `repoDir`. `peerPrSecretHit` then runs on the masked text
(placeholders never count; invisible characters dropped, blanks read through — inside a key prefix too, `s k - …`); a hit
refuses the push. The bridge repeats every check on the exact text before its one signed
POST: peer-prs.json re-read, (peer, fp, agent) must be configured, peers.json must have that peer enabled, fully
handshaken and on the same fp, size ≤ 64 KiB, the gate again with commits re-checked in `repoDir`. Any miss = a typed
`rejected` and zero bytes out. A report over the size cap is not truncated: PM gets one notice with the local path.

## Delivery semantics

Each push is one ledger `note` (`data.op = "peer_pr_push"`, invisible to peers) per state: `claimed` → `sent` (2xx only) /
`failed` (retried 30 s → 10 min) / `refused` (gate, terminal) / `abandoned` (24 h after the first claim, terminal).
Terminal results share one dedup key, so a key is never delivered twice by the scheduler. PM hears once at 15 min, once on
giving up, once per refusal. PM notices are written first, then sent, then marked sent (`noticeOnce`); every pass rescans the
notices without a sent mark (`retryNotices`), so a notice whose push is already terminal or whose card went back to manual is
still delivered after an outage.

## Hooks in existing files

`scheduler-pass.ts` (one call before the merge tick), `scheduler-auto-tick.ts` (the hold), `scheduler-auto-deps.ts`
(reviewer worktree from `repoDir`, head-present check before pinning), `ledger-write.ts` (`moveStage` `asPm`, peer cards
only), `ledger-scheduler-write.ts` (`setWorkflow` intake mode: security + auto + peer card only), `manager/ledger.ts`
(three scheduler-only commands), `bridge.ts` (one `case`). Non-peer cards take none of these branches.

Tests: `tests/peer-pr-*.test.ts` (`peer-pr-tick.test.ts` drives the whole loop against the real ledger and auto tick).
