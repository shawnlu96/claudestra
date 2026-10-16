# Reviewer fallback (RVF-1)

When the cross-family reviewer's family cannot run, an auto card no longer goes to PM: the round falls back to an
**adversarial reviewer of the author's family**, and the card stays with the scheduler. Code: `lib/scheduler-review-fallback.ts`
(rules, pure reads), `lib/scheduler-recovery-write.ts` `writeReviewFallback` (the only writer), wiring in
`lib/scheduler-model-wiring.ts` and `lib/scheduler-auto-tick.ts`. Tests: `tests/scheduler-review-fallback.test.ts`.

## Triggers

| Path | Fires when | Read from |
|---|---|---|
| Review turn failed | MODEL classifies it `capacity` (quota / rate limit) or recoverable `host` (offline, refused send, transport), the failed reviewer is the card's current local binding, and no other authorized placement differs from the author family — the case MODEL plans as `model_recovery_manual`「没有符合跨模型要求的去处」 | the turn's failure, through `ledger scheduler-model-outcome` after MODEL's own record |
| Reviewer create failed | the ensure_session was settled `未建：建会话失败，现场已清理…` (retryCleanCreate: nothing left behind) and either the receipt is quota-class (`classifyModelOutcome`, the same recognition MODEL uses) — **first failure** — or it is the `CREATE_FAIL_LIMIT` (3)rd such failure in a row | the receipt on the ledger, re-read by the writer |

The create path covers both the card's first reviewer (`Card.ensure`) and a replacement reviewer built by the swap runtime
(`createReplacement` now goes through `retryCleanCreate` too, so a clean failure backs off instead of stopping as unknown).

Never a fallback: an author's failure (its family is the workflow's, MODEL's own path); a policy refusal (MODELX's exemption);
a card with an open safety hold or refusal continuation; a reviewer that is already the author's family.

## The epoch

A `reviewer_swap` event (dedup `review-fallback:<failed intent>`) with a `fallback` field — the same shape as MODELX's refusal
epoch, so `scheduler-review-swap.ts` reads both through `refusalEpoch` / `exemptBind` / `exemptVerdict` / `refusalRebind` /
`refusalBindMarks` / `refusalEpochLapse`:

```json
{ "op": "reviewer_swap", "intentId": "<failed order>", "fromFamily": "codex", "toFamily": "claude", "agent": "agent-rv-t1" | null,
  "sessionId": "s-rv" | null, "round": 1, "head": "<sha>", "specRev": 1,
  "fallback": { "trigger": "review_capacity|review_host|create_quota|create_streak", "reason": "<host text, ≤600>",
    "failedAgent": "...", "exemption": "跨模型审查豁免:跨族审查员不可用，本轮降级同族对抗审查", "crossModel": false,
    "placement": { "family": "claude", "machine": "local" } } }
```

- A failed binding is retired in the same transaction (row and history kept, the old session neither woken nor killed); a create
  failure had none (`sessionId: null`, bound later through `freshFallbackEpoch`).
- The replacement is created by the swap runtime in its own checkout `rv-<task>-fb` as `agent-task-rv-<task>-r<round>-fb`,
  bound with `fallbackEpoch / crossModel: false / exemption`, and gets the ordinary adversarial review order — same prompt,
  same read-only rules.
- Its verdict passes the verdict gate, both merge gates and `manual-merge-request` through `exemptVerdict` (no approval to check;
  the epoch is the record). It is never counted cross-model.
- A reviewer create failure streak restarts at the epoch (`createRetryBackoff`), so the fallback reviewer is created at once.

## Rounds

- One fallback per head / spec / round window, and none next to a refusal epoch: if the fallback reviewer fails too, the card goes
  to PM as before. No switching back within the round, even if the cross family recovers.
- The next round starts cross-family again: the fallback session is author-family, so FAM1a's family swap retires it and creates
  a reviewer of the other family. Still unavailable → that round falls back again with its own epoch.

## Merge paths

- **mergeHandoff** projects: the handoff evidence's `review.fallback` carries `{ epochSeq, trigger, reason, crossModel: false,
  note: "本机跨族审查降级，跨族交仓库方队列" }`, and the handoff event's text ends with the note: the repository owner's queue does the
  cross-family review.
- **localMerge** projects: unchanged — the card stops at `local_merge_ready` and PM runs `ledger local-merge`; nothing merges a
  fallback verdict by itself.
- Plain PR projects merging on this machine: the fallback verdict counts like MODELX's exemption. Keep `reviewFallback` at observe
  there if a cross-family review must precede every merge.

## Switch: `reviewFallback`

A recovery key (`recovery-policy.json`, `ledger scheduler-recovery <project> <mode> --key reviewFallback --reason …`), classed
`safety` so it defaults to **observe** (`lib/recovery-key-class.ts`):

| Mode | Effect |
|---|---|
| `off` | nothing recorded; the card goes to PM / backs off as before |
| `observe` (default) | one `recovery_observe` note per failed order: 「本会 … 第 N 轮改派 claude 独立对抗审查 …」, with `reviewFallback: { trigger, from, to, reason }`; nothing else changes |
| `on` | the epoch above |

It is independent of `modelOutcome`: MODEL keeps its own record (and mode) for the failed turn either way.
