# Recovery key defaults (新开关缺省 on，高风险先 observe)

Card agents-OBSGATE1. Before this card every recovery key that neither its project's `keys` nor the project `mode` set read `observe`, so each new switch went live as observe and PM had to schedule a follow-up to turn it on. Now the fallback is per key, and every key must be able to leave observe samples.

Code: `src/lib/recovery-key-defaults.ts` (`defaultRecoveryMode`, the frozen lists, the `recovery_default_on` note), `src/lib/recovery-key-defaults-scan.ts` (sample-sink scan), `src/lib/recovery-key-class.ts` (high-risk classes, from OBSAUTO1), `src/lib/recovery-policy.ts` (reader and gate). Tests: `tests/recovery-key-defaults.test.ts`, `tests/recovery-key-sample-sink.test.ts`, `tests/recovery-policy*.test.ts`.

## Effective mode

`keys[key]` → project `mode` → `defaultRecoveryMode(key)`. Only the last step is new; an explicit key mode or project mode wins exactly as before, and an unknown key or an unreadable `recovery-policy.json` still answers `off`.

| key | default |
|-----|---------|
| in `LEGACY_OBSERVE_KEYS` (every key on main when this card merged; frozen, never grows) | observe (unchanged) |
| in a high-risk class of `recovery-key-class.ts` (safety / permission / delete-data / schema) | observe |
| any other key added later | on |

A new high-risk switch goes into `HIGH_RISK_RECOVERY_KEYS` in the same card that adds the key; its spec names the class.

## Rolling back

No new command. One key: `ledger scheduler-recovery <project> off --key <key> --reason <why>` (or `observe`). A whole project: `ledger scheduler-recovery <project> observe --reason <why>` (or `off`) — the project mode outranks the per-key default.

## Seeing what is on by default

The first time `gateRecovery` reads a key that is `on` only through `defaultRecoveryMode` (no `keys[key]`, no project mode, read from the file), it appends one project-level note `op=recovery_default_on`, `mechanism=<key>`, dedup per project + key. An injected policy port that does not come from `recoveryPolicy`, an explicit `on`, and any observe / off read write nothing. The note is bookkeeping: a failed write (a `query_only` connection) never changes the gate's outcome and is retried on the next read. The per-connection memo that skips the repeat write is kept only when the write committed on its own; inside an outer transaction (which could roll the note back) the next read writes again and the ledger dedup keeps it to one.

## Sample sinks (enforced by test)

`tests/recovery-key-sample-sink.test.ts` scans `src/lib` and fails, with "新开关要有样本记录口：用 gateRecovery 包动作，或 recordObserved 记 observe 样本", for any key in `RECOVERY_KEYS` that has no sink and is not in `LEGACY_NO_SAMPLE_KEYS`. A key has a sink when a file names it — a string literal, its own `const X = "<key>"`, or such a constant imported from the file that exports it — and the same file writes samples: `gateRecovery(`, `recordObserved(`, `op: "recovery_observe"`, the scheduler identity's `"scheduler-recovery-observe"` command, or an injected observe port (the file uses `ObservedAction` in code outside its imports *and* calls something named `observe*` / `*Observe*` / `*Observed*`; neither alone counts); or `observation-plan-evidence.ts` has a `"recovery:<key>"` adapter.

The write is matched on code only. One lexer pass blanks comments (including comments inside a template's `${}`), then string, template-text and regex bodies, keeping `${}` expressions as code; the two sink tokens that are strings (`"recovery_observe"`, `"scheduler-recovery-observe"`) are kept whole. So a bare `import type { ObservedAction }`, `"recordObserved(db, a)"` written as text, or `${/* recordObserved( */ 1}` is no sink; a real call inside `${}` is. Only call expressions count: a `function` / `abstract` head, a name followed by a body or return type (`recordObserved() {`, `recordObserved(): void`), or a member of an `interface` / `type X = {` body is a declaration, not a write; the same goes for the observe port's call. `"scheduler-recovery-observe"` counts only as the first or second argument of a call (`o.ledger("ledger", "scheduler-recovery-observe", …)`), not as a bare constant, list entry or table key. `recovery-keys.ts`, `recovery-key-class.ts` and `recovery-key-defaults*.ts` list every key and are not mechanisms.

`LEGACY_NO_SAMPLE_KEYS` may only shrink: it must stay a subset of `LEGACY_OBSERVE_KEYS` (so no new key, high-risk or not, can be exempted), no longer than the merge-time count pinned in the test, and a key that gains a sink must leave it. A scan miss (a key passed in some other way) is fixed by teaching the scan, never by exempting the key.
