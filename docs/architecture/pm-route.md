# PM push routing

`pm-route` adds independent classification at the existing, final active PM delivery entry. The four labels are `auto` (approved facts needing no action), `digest`, `judge` and `owner`. `owner` still goes to the active PM; it creates no new owner notification or decision mechanism. Non-PM destinations use the existing route unchanged.

## Controls

- `ledger pm-route-mode off|observe|on --project <id>` requires the real PM, master or owner, just like `pm-digest-mode`.
- `ledger pm-digest --project <id>` stays read-only. Its `routeMode` and `route` fields expose class and rule totals for that project's last 24 hours. Statistics contain no message bodies.
- The independent mode lives in `pm-digest-mode.json` under `routeProjects[project]`. Existing `projects[project]` values keep their PMDIG meaning. Either writer preserves the other setting. Missing or damaged route configuration means `observe`; enabling the old PMDIG switch never enables suppression.
- For old PMDIG `off` with no explicit route setting, no route-only record is created. An explicit route `observe` or `on` enables independent accounting even if PMDIG is off.

`off` directly calls the existing PMDIG classifier. `observe` annotates its existing atomic record write and leaves envelope bytes, queues, ordering and windows unchanged. If explicitly enabled with PMDIG off, observe writes a route-only record and sends the original envelope. `on` removes approved auto facts, uses the existing PMDIG mode for digest decisions, and sends protected items immediately. Old queues are never retrospectively deleted.

## Approved facts

The pure rule table is in `src/lib/pm-route-rules.ts`, used by `classifyPmRoute` in `pm-route.ts`. It matches complete existing wire templates after verifying the source, rather than looking for arbitrary substrings.

| Source | Complete event or item | Label |
| --- | --- | --- |
| local `scheduler`, oneShot | train form with consistent member count and 12-character main SHA | auto |
| same | train done | auto |
| same | void explicitly reporting combination red already split or bounced (reserved; no current sender) | auto |
| same | exact routine train hold reason (reserved; currently only stored as an event) | digest |
| same | exact bisect progress or car CI red report | digest |
| bridge `ledger-audit` | `ship_stalled` at merge with the exact queued train annotation | auto |
| same | `merge_ready_idle` whose only reported blocker is the exact queued train annotation | auto |
| same | `orphan_executor` with confirmed lent or relay-session annotation | auto |

The current audit wire has no explicit rule field. Matching verifies the complete suggestion, detail, target and annotation to infer the item type. An optional `[rule_name]` prefix is accepted only when it agrees with that exact template. A queue annotation alongside freeze, owner hold, missing gate evidence or unknown merge results does not qualify. Unknown/no-heartbeat lent states stay visible. Queue phases are merge-run phases: `ready`, `updating`, `await_review`, `await_ci` and `merging`.

Human messages, card answers, responses, explicit owner decisions, PMDIG3 halt/recheck protection, questions, deliveries, failures and incidents precede auto rules. A train timeout, alarm meaning, release request or unrecognized void remains judge. Normal hold's fixed “申请合并槽” phrase and a structurally verified ready item's fixed “实际阻塞” label are not action requests; any extra action or fault text prevents auto matching. The ready field label is ignored for protection even when the item is not auto; real blocker and suggestion text still receive the full protection check. Approved car CI red progress may include ordinary failed-test logs and still enter digest; accompanying alarms, halt/recheck facts, freezes or action requests remain protected. Recognized train digest records use PMDIG's existing kind if available, including `train`; on the older base they use `sync`.

Unknown classifications retain the original PMDIG delivery choice. A malformed audit keeps the whole original envelope and original PMDIG choice, even if some visible rows resemble auto items.

## Audit filtering and persistence

The parser requires the exact header, count, contiguous numbering, single-line rows and tail command. On a valid mixed audit, it removes only auto rows, renumbers the remaining original rows, rebuilds the count and retains the tail. Protected remaining rows are sent with their full original details; other rows follow PMDIG. An all-auto audit produces only a record. The PM transfer header is retained. A standalone PM digest bypasses routing to prevent a loop.

Optional `route` tags are appended to the existing `pm-digest.json` log. Each tag contains class, stable rule ID and reason; audit tags also contain the original ordinal and inferred type. Removed bodies, suggestions and card IDs are not retained. A synchronous scoped annotation lets the original classifier atomically persist both its record and any digest entry, without changing PMDIG detail extraction. Route-only rows are excluded from old PMDIG counters. Suppressed auto facts stay route-only. Protected immediate deliveries are normal `now` records when PMDIG is on or observe, retaining existing now/source/reason accounting; with PMDIG off they only contribute route statistics.

Deduplication uses `(project, messageId)` in the existing 24-hour log, including after restart; no additional recovery key is created. Repeat deliveries retain the old PMDIG behavior but contribute route counts once. Atomic persistence must succeed before an auto message is suppressed. A write failure restores the whole unfiltered envelope and takes the existing immediate-send fallback. Old records without route fields and old queues remain valid; carried/stale-send settlement stays owned by PMDIG.

## Verification and rollout

The new `tests/pm-route*.test.ts` suites cover actual `deliverPmLocal` routing, final-PM redirects, full/mixed/malformed audits, source protection, mode parity, window sends, duplicate IDs after restart, old state compatibility, failed writes, and the real manager command. Existing PMDIG urgent, detail, queue, restart and stale-send expectations are unchanged. The initial integration tests failed on the base because routine train pushes were delivered and the whole audit entered the digest.

The reserved void-red and hold rules remain for the approved specification, but their counters are not rollout evidence: the current train sender never emits a combination-red void, and hold reasons go only to `store.event`, without PM notification.

Start with observe. Review the first auto examples and per-rule totals, approve the rules, then explicitly switch on. Compare wake counts and source cost over the same PMCOST1 window. The feature adds no new handlers for judge or owner.
