# Project memory relevance (坑不强占 + 跨卡无关降权)

Card agents-PMEMTUNE2. Baseline (PM, ledger window to 10-16): of 744 deduplicated write-order items, 82.4% were marked `irrelevant` and 16.5% `applied`. Pitfalls were 93.1% irrelevant and made up 83.5% of all irrelevant items. Every write order got exactly 4 items. Three causes:

- write orders reserved 2 pitfall slots, so a lower-ranked pitfall could push out a higher-ranked non-pitfall;
- the graph route admits adjacent-feature memories with no file or semantic relation;
- `irrelevant` never fed back into ranking (only `wrong` → dispute excluded a memory).

Code: `src/lib/memory-retrieve.ts` (selection), `src/lib/memory-feedback-prior.ts` (the prior, pure), `src/lib/memory-relevance-replay.ts` (read-only replay). Tests: `tests/memory-retrieve-relevance.test.ts`, `tests/memory-feedback-prior.test.ts`, `tests/memory-relevance-replay.test.ts`; the old rules stay covered by `tests/memory-retrieve*.test.ts`.

## Switches

Two recovery keys. Neither touches permissions or outbound traffic, so both default to `on` (OBSGATE1) and neither has a class. With `off`, selection is the pre-card code path word for word: no extra fields on `Scored`, no `selectionVersion` on `memory_rank`, and no refs query.

| key | on |
|-----|----|
| `memoryPitfallRelevance` | Write orders drop the reserved pitfall slots: every kind competes on one score. Anything below `RELATIVE_FLOOR` (0.35, one constant) × the best eligible score is left out, so a write order carries 0–4 items. On write and review orders alike, a pitfall whose only hit is a graph hop 3 (adjacent feature), with no file or vector hit, is left out. Review orders otherwise keep their rules: pitfalls only, ≤3 items, ≤1000 bytes, no relative threshold. |
| `memoryFeedbackPrior` | The ranking prior is multiplied by the cross-card feedback prior below. |

Drop reasons keep the existing kinds, so the `memory_rank` drop text is unchanged. The two new rules use `below_floor` with `rule: "relative" \| "far_graph"`.

`observe`: both selections are computed (current rules, and current rules with that key turned on) and the current one is injected. One `recordObserved` sample is written per order (card + specRev + write/review), carrying `oldIds`, `newIds`, `removed` (id + reason), `added`, and both versions. Samples are written outside transactions only. On the bridge's `query_only` reader (`LedgerReader`) a short-lived writer connection is opened for the sample, same as the ranking event in `memory-retrieve-order.ts`. Inside a transaction (the synchronous order assembly) nothing is written, because the out-of-transaction prepare pass for the same order has already written the sample. A sample write that fails is logged and never affects retrieval.

`memory_rank.selectionVersion` is `base`, `pitfall`, `feedback` or `pitfall+feedback` (whichever rules were applied). It is absent when both keys are off. `ledger memory-metrics` can split applied/irrelevant by it.

## Feedback prior

`feedbackPrior(marks, now)`, where marks are the `applied` / `irrelevant` entries from `memory` events with `op = refs` that **other** cards wrote for this memory:

- each mark is weighted `0.5^(age / 30 days)` × card relevance: 1 for the same nonempty feature or overlapping `extra.fileGlobs`, otherwise 0.25 (including missing cards). Both applied and irrelevant use this weight; the minimum sample count remains the raw count;
- smoothed value `s = (applied + 1) / (applied + irrelevant + 2)`, scaled against the no-information value 0.5: `prior = clamp(2·s, 0.2, 1)`;
- fewer than 3 marks → 1.

Why the ×2 scaling: unscaled, any memory with 3 or more marks would be demoted even if every mark was `applied` (≤0.8). Once its marks decayed, it would sit at 0.5 forever, while an unmarked memory stays at 1. Scaled, a memory with `applied ≥ irrelevant` is not demoted, and old marks fade back to 1.

The floor is 0.2, and the absolute score floor (`SCORE_FLOOR`, 1/70) is checked on the score **before** the feedback prior. The prior only moves a memory down the ranking and against the relative threshold, so it can never make a memory permanently unreachable. With the floor checked after the prior, even a three-route hit (3/61 × 0.2 < 1/70) would be excluded forever.

`wrong` stays on the existing path (`memory-tools-refs.ts` → dispute mark → excluded in `memoryCandidates`) and is ignored here.

The marks are read once per retrieval: `memoryCandidates` bulk-reads the project's refs events and card feature/file metadata and hands the result to `rankMemories` together with the modes (a context keyed by the candidate array). There is no per-memory lookup. Called directly with literal candidates and no `modes`, `rankMemories` applies the old rules.

## Replay (read-only)

`replayRelevance(path, project, since, until, overrides?)` opens the ledger `readonly` with `query_only`. For each write-order injection in the window:

- **old selection:** the injected `memoryIds`;
- **new selection:** the `memory_rank` items and dropped entries that were still eligible (`超条数` / `让坑位`), re-ranked under the new rules, using only refs from other cards written before that injection. Equal scores break the same way as `rankMemories` (shared `rankOrder`: newer `createdAt` first, then id).

Routes for the dropped entries are recomputed for graph and file from the current ledger; a vector hit is inferred when the score exceeds what graph and file explain. Labels come from the card's first refs event after the injection. Output: average items per order and counts by kind and route (old and new), the share of old `applied` items kept (target ≥ 90%), and the share of old `irrelevant` items removed.

Set `LEDGER_DB_PATH` to the ledger path on the PM machine. Run from the checkout. Defaults: relativeFloor 0.35, feedbackFloor 0.2, unrelatedWeight 0.25, count 4. `replaySweep` accepts an explicit array of override combinations, opens the database once, and reuses candidates, routes and contextual marks across all combinations. It returns `{params, result}` for each combination. No live-data result is claimed by the fixture tests. PM acceptance requires default applied retention ≥0.9 and irrelevant removal ≥0.5.

```sh
bun -e 'import {replayRelevance as r} from "./src/lib/memory-relevance-replay.ts"; console.log(JSON.stringify(r(process.env.LEDGER_DB_PATH!, "claude-orchestrator", Date.now()-7*864e5, Date.now())))'
bun -e 'import {replaySweep as r} from "./src/lib/memory-relevance-replay.ts"; const grid=[0.1,0.25,0.5].flatMap(unrelatedWeight=>[0.25,0.35].map(relativeFloor=>({unrelatedWeight,relativeFloor}))); for(const row of r(process.env.LEDGER_DB_PATH!, "claude-orchestrator", Date.now()-7*864e5, Date.now(),grid)) console.log(JSON.stringify(row))'
```

## Rolling back

`ledger scheduler-recovery <project> observe --key memoryPitfallRelevance --reason <why>` (or `off`), and the same for `memoryFeedbackPrior`.
