# Reviewer fallback (RVF-1)

When the cross-family reviewer's family cannot run, an auto card no longer goes to PM: the round falls back to an
**adversarial reviewer of the author's family**, and the card stays with the scheduler. Code: `lib/scheduler-review-fallback.ts`
(rules, pure reads), `lib/scheduler-recovery-write.ts` `writeReviewFallback` (the only writer), wiring in
`lib/scheduler-model-wiring.ts` and `lib/scheduler-auto-tick.ts`. Tests: `tests/scheduler-review-fallback.test.ts`.

## Triggers

| Path | Fires when | Read from |
|---|---|---|
| Review turn failed | MODEL's recognition says `capacity` — the host reported quota / rate limit — the failed reviewer is the card's current local binding, and no other authorized placement differs from the author family (the case MODEL plans as `model_recovery_manual`「没有符合跨模型要求的去处」) | the turn's failure, through `ledger scheduler-model-outcome`, **before** MODEL's record: a round that fell back gets no MODEL escalation (no 「容量不足」 push to PM) |
| Reviewer create failed | the ensure_session was settled `未建：建会话失败，现场已清理…` (retryCleanCreate: nothing left behind) and either the error is quota-class (`classifyModelOutcome`, the same recognition MODEL uses) — **first failure** — or it is the `CREATE_FAIL_LIMIT` (3)rd such failure in a row | the receipt on the ledger, re-read by the writer |

Quota is judged on the failure's own text only (`failureText`): the receipt's prefix and the card id (inside agent names and
checkout dirs) are cut out first, so a card like `CI-429` never reads as quota.

Any other review-turn failure (input too long, transport, a refusal worded past MODEL's patterns) does **not** fall back: one
failure must not cost the round its cross-family review, and refused content must never reach another family around MODELX.

The create path covers the card's first reviewer (`Card.ensure`) and, on a card that already has a fallback epoch, a replacement
built by the swap runtime (`createReplacement` goes through `retryCleanCreate` only there; FAM1a / MODELX swaps on any other card
create exactly as before, a clean failure still stopping as unknown).

Never a fallback: an author's failure (its family is the workflow's, MODEL's own path); a policy refusal (MODELX's exemption);
a card with an open safety hold or refusal continuation; a reviewer that is already the author's family.

## The epoch

A `reviewer_swap` event (dedup `review-fallback:<failed intent>`) with a `fallback` field — the same shape as MODELX's refusal
epoch, so `scheduler-review-swap.ts` reads both through `refusalEpoch` / `exemptBind` / `exemptVerdict` / `refusalRebind` /
`refusalBindMarks` / `refusalEpochLapse`:

```json
{ "op": "reviewer_swap", "intentId": "<failed order>", "fromFamily": "codex", "toFamily": "claude", "agent": "agent-rv-t1" | null,
  "sessionId": "s-rv" | null, "round": 1, "head": "<sha>", "specRev": 1,
  "fallback": { "trigger": "review_capacity|create_quota|create_streak", "reason": "<host text, ≤600>",
    "failedAgent": "...", "exemption": "跨模型审查豁免:跨族审查员不可用，本轮降级同族对抗审查", "crossModel": false,
    "placement": { "family": "claude", "machine": "local" } } }
```

- A failed binding is retired in the same transaction (row and history kept, the old session neither woken nor killed); a create
  failure had none (`sessionId: null`, bound later through `freshFallbackEpoch`).
- The replacement is created by the swap runtime in its own checkout `rv-<task>-fb` as `agent-task-rv-<task>-r<round>-fb`,
  bound with `fallbackEpoch / crossModel: false / exemption`, and gets the ordinary adversarial review order — same prompt,
  same read-only rules.
- Its verdict passes the verdict gate, both merge gates and `manual-merge-request` through `exemptVerdict` (no approval to check;
  the epoch is the record) while the switch is not off. It is never counted cross-model. The review event itself carries
  `fallback: { epochSeq, trigger, reason, crossModel: false, exemption }` (`reviewFallbackMark`, written by `recordReview`).
- A reviewer create failure streak restarts at the epoch (`createRetryBackoff`), so the fallback reviewer is created at once.

## Rounds

- One fallback per head / spec / round window, and never together with a refusal epoch either way (a round with a refusal epoch
  does not fall back; a round that fell back opens no refusal epoch): if the fallback reviewer fails too, the card goes to PM. No switching back within the round, even if the cross family recovers.
- The next round starts cross-family again: the fallback session is author-family, so FAM1a's family swap retires it and creates
  a reviewer of the other family. Still unavailable → that round falls back again with its own epoch.

## Merge paths

Nothing merges a fallback verdict without a person or the repository owner's cross-family queue. Every PM notice says
「本机跨族审查降级为同族（原因），没有跨族审查」 (`fallbackNotice`).

- **mergeHandoff** projects: the handoff evidence's `review.fallback` carries `{ epochSeq, trigger, reason, crossModel: false,
  note: "本机跨族审查降级，跨族交仓库方队列" }`, the handoff event's text ends with the note, and PM's handoff notice says so: the
  repository owner's queue does the cross-family review. No PR comment is posted (the handoff has no comment channel).
- **localMerge** projects: the card stops at `local_merge_ready` and PM runs `ledger local-merge`; the notice names the fallback.
- Plain PR projects merging on this machine: the auto tick plans no merge intent for a fallback verdict — the card goes to PM
  (「同族降级、无跨族审查：不自动合并…」) at `merge`, and PM merges through the manual merge queue if it agrees.

## Switch: `reviewFallback`

A recovery key (`recovery-policy.json`, `ledger scheduler-recovery <project> <mode> --key reviewFallback --reason …`), classed
`safety` so it defaults to **observe** (`lib/recovery-key-class.ts`):

| Mode | Effect |
|---|---|
| `off` | nothing recorded; the card goes to PM / backs off as before. An epoch already written is withdrawn: no fallback reviewer is created or sent any more (`fallbackLapse` → the card goes to PM) and its verdict passes no gate |
| `observe` (default) | one `recovery_observe` note per failed order: 「本会 … 第 N 轮改派 claude 独立对抗审查 …」, with `reviewFallback: { trigger, from, to, reason }`; nothing else changes |
| `on` | the epoch above |

The effective mode is CFG's: `keys.reviewFallback` → the project's `mode` → the key's default. A project whose `mode` is set
(say `on`) runs the fallback at that mode unless `keys.reviewFallback` says otherwise — the observe default applies only to a
project with neither.

It is independent of `modelOutcome`: MODEL records the failed turn under its own mode whenever the round did not fall back.

## Known limits

- The next round's cross-family replacement uses the ordinary `rv-<task>` checkout, which the reviewer retired by the fallback
  may still occupy: that session is retired on the ledger but neither archived nor stopped (idle, so the risk is low; MODELX's
  `-ex` avoids the same sharing).
