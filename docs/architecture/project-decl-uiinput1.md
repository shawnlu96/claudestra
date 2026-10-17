# UIINPUT1 · UI evidence bound to the project's declared render inputs

Card generality-UIINPUT1 (feature generality, depends on PROJDECL1). Module:
`src/lib/project-ui-inputs.ts`. Tests: `tests/project-ui-inputs.test.ts` and the
UIINPUT1 block in `tests/scheduler-ui-review-carry.test.ts`.

## Why

The screenshot carries (UIR1 review carry, UIOWNCARRY1 owner carry, UICAR3
own-globs carry and the owner-fresh compare) judged "did the UI change" with
Floka's fixed inputs: `web/`, `src/bridge/`, a few asset directories and root
package / lock / config files, and treated a repository without `web/` as
unprovable. Another project's UI in `frontend/`, a shared package or a Go
template directory was invisible to that rule; a repository that happened to
have an unrelated `web/` would carry an old screenshot across a real UI change.

## What is read

The declaration is the version 1 `.floka/project.json` (PROJDECL1 schema) at
the carry's **target head** (the new head), read from Git objects only. Its
`ui.renderInputs` globs, the declaration file itself, its basis files, the
card's `fileGlobs`, and every dependency manifest or lockfile in a directory
at or above a declared input (npm / bun / yarn / pnpm, Go modules, Python
packaging, Cargo, Bundler, Composer, `.gitmodules`) form the inputs of a head.
The inputs of each evidence head (the approved head, the carry's old head, the
head the screenshots were registered at) are compared with the target's.

Globs are path segments, case-insensitive: `**` is any number of segments (so
`dir/**` also covers `dir`), `*` any run inside one segment, `?` one character.

Floka keeps its old rules as a built-in declaration of the same shape
(`FLOKA_UI_INPUTS`), selected only when the target has no declaration and the
repository passes PROJDECL1's built-in check (canonical remote plus shipped
verification ancestry). The built-in keeps the old "web/ must exist" rule.

## Complete and trusted, or a reason

A declaration carries a screenshot only when all of the following hold;
otherwise the carry refuses, asks for acceptance on the new head, and names
the reason code plus the manual entry `manager project-decl <project> explain`:

| Reason | Meaning |
| --- | --- |
| `UNDECLARED` | no declaration and not Floka; never inferred from directory names |
| `INVALID_DECLARATION` | unreadable, duplicate keys or not version 1 |
| `REPOSITORY_UNKNOWN` / `REPOSITORY_MISMATCH` | the project's origin cannot be established, or differs from the declared remote |
| `BASIS_MISSING` / `BASIS_STALE` | no basis, or a basis file hashes differently at the target head |
| `INFERRED` | some capability in the declaration is only inferred |
| `UNVERIFIED` | a verification head is not an ancestor of the target |
| `INPUTS_EMPTY` | `ui.renderInputs` is empty: the inputs are not declared complete |
| `DEPENDENCY_UNKNOWN` | a declared input matches nothing, or an input is a symlink / submodule |
| `READ_FAILED` | Git could not be read |

`fileGlobs` join the inputs but never make an undeclared project complete.
A missing `web/` is never an error for a declared project, and the absence of
UI paths is never taken to mean no UI acceptance is needed.

Every judgment carries a summary: repository identity, source
(target / builtin / none), declaration digest, basis state, trust, evidence
heads, target head, input digest and count, and a digest over all of them.
Under `on` the summary is added as `uiInputs` to the carry records.

## Paths

`uiInputsGate` is the single decision; review carry and owner carry pass the
approved and old heads, owner-fresh the screenshot head, and own-globs uses
`uiDeclComplete` (completeness and trust only: main may still touch UI inputs
there as long as it does not touch the card's files, as before). The review
layer, judged in the same carry, records the reason when own-globs refuses.

## Switch `projectUiInputs`

Safety class, default `observe` (`recovery-keys.ts`, `recovery-key-class.ts`).

- `on`: the declared-input judgment above decides.
- `observe`: the old judgment acts; each disagreement (carry vs not) is one
  `recordObserved` note with both outcomes, the reason and the summary,
  written after the path's own record so `carrySeq + 2` is unchanged.
- `off` (or an unreadable policy): exactly the old judgment, nothing new read.

Rollback: `ledger scheduler-recovery claude-orchestrator off --key projectUiInputs --reason ...`.
`off` stops only the new mechanism; it never turns a missing declaration,
unknown evidence or a manual state into a pass, and no existing gate is relaxed.

## Floka regression evidence

- Every fixture head of the existing UIR1 suite (src/lib-only, web/, root and
  web/ package.json, src/bridge/, i18n/, `*.config.*`, two-hop, symlink, the
  card's fileGlobs) gets the same outcome and the same digest from the
  built-in declaration as from the fixed rules; the head without `web/` and
  the symlink stay unprovable.
- On this repository's own HEAD the built-in declaration selects the same
  inputs (same count, same digest) as the fixed rules.
- With the switch at its default the existing UI carry suites pass unchanged.

## For the PM after release (24 h)

Check, per path (review / owner / own-globs / owner-fresh), the
`projectUiInputs` observation notes: input summary, reason code and the new
head acceptance prompt; compare against the two fixture stacks. On a misjudgment
switch the key off as above, keep the evidence, do not reset the state store.
