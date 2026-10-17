# Project declarations (version 1)

`manager project-decl <project> show|validate|explain [repoDir] [targetBranch]`
is a read-only inspection interface. All three views include the selected source,
immutable target head, local restrictions, provenance, capability availability,
and structured reasons. `validate` exits 2 when the declaration needs attention;
`show` and `explain` exit 0 when inspection succeeds, including degraded results.
Invalid arguments or unreadable project configuration exit 2 for every action.
Command arguments are represented by their count in these views. Environment
references contain names only. No command from a declaration is executed. A single first import in manager
dispatches this command family before legacy daemon imports can initialize or
rotate logs; its command module exits after producing the result.

## Repository and source selection

The task supplies a project and an exact repository/worktree root. The Git common
directory must equal one of that project's registered repositories. An umbrella
parent directory does not establish repository identity. Linked worktrees qualify
through their common directory; another clone does not qualify just because its
remote has the same name. Multi-repository projects require explicit `repoDir`.
The loader never uses the host application's repository root.

An explicit `targetBranch` is trusted caller input and resolves `refs/heads/…`.
When absent, the target is the local `refs/remotes/origin/HEAD` symbolic ref.
This is a local snapshot: the loader does not fetch or claim remote freshness.
If no such target commit can be fixed, it reports `TARGET_HEAD_UNAVAILABLE`.
A declaration or PR head cannot select the target. The branch ref is resolved
once; subsequent content and basis reads use that commit's Git objects.
Git replacement objects and lazy fetching are disabled. Worktree edits, including
uncommitted declarations, are never read. Missing paths, symlinks and submodule
boundaries in explicitly addressed path components are rejected. Globs are
repository-relative metadata; this module does not expand or execute them.

Selection order is a declaration merged at the target head, otherwise a Floka
built-in declaration, otherwise `UNDECLARED`. A malformed target declaration
blocks fallback. The built-in requires both the canonical Floka remote and the
shipped verification commit in the repository's ancestry. Merely changing a
foreign repository's origin does not qualify. GitHub shorthand, HTTPS Git hosts,
and Git SSH host/path names are accepted; embedded credentials are rejected.
Local configuration applies only as restrictions on the selected declaration.

## Closed schema

Duplicate JSON keys, including escaped spellings, are rejected before schema
validation. All objects are strict: unknown versions, unknown properties, authority fields,
ambiguous IDs, control characters, unsafe paths and invalid timeout values fail
validation. IDs use letters, digits, underscore and hyphen. Paths are relative,
with `.` denoting the root. Parent traversal, absolute paths and alternate path
separators are forbidden. Globs support star expressions; brace, bracket and
negation expressions are rejected. Timeouts are integral seconds from 1 to
86400. `argv` is a nonempty array of nonempty strings, interpreted as direct
arguments by any future consumer, never as a shell string.

The complete version 1 shape is:

- `version: 1`.
- `repository: {remote, defaultBranch, targetBranch}`. The remote and target
  branch must match the separately established repository and target.
- `validation: {author: Command[], review: Command[], build: Command[]}`.
- `tests: {rules: TestRule[], globs: string[]}`. A test rule has command fields,
  uses `dir` instead of `cwd`, and has `fullWhen: string[]` plus an optional
  `classifier: Command`.
- `ci: {provider: string, workflows: string[], requiredChecks: string[],
  testAdapter: Command|null, reports: string[], fullScope?: string[],
  proof?: Basis[]}`. The provider is an identifier (for example `github`, `gitlab` or `none`);
  it conveys no CI success. Proof entries are content hashes, never authorization.
- `ui: {renderInputs: string[]}` and `verification: {probes: Command[]}`.
- `deploy: {adapter: "floka"|"none", provenance}`.
- `basis: Basis[]`, with each basis entry `{path, sha256}`.

`Command` is `{id, argv, cwd, env?, timeoutSec, provenance}`.
Environment entries have the form `CI: {from: "CI"}`: both sides must be safe
variable names. Literal environment values are not accepted or persisted.
Every executable item, including classifiers, adapters and probes, has
`provenance: {status: "verified"|"inferred", verifiedHead?, verifiedAt?}`.
Verified items require a full commit digest and ISO timestamp. Verification must
refer to an ancestor of the target and must not be dated in the future. There
is no arbitrary time-to-live: expiration follows changes to the content basis.
A nonempty basis must match both the target and the verification commit.

The effective result keeps the declaration and required gates intact, alongside
separate capabilities with `available` and `wouldBeAvailable`. Inferred items
are unavailable. Missing or changed basis invalidates the whole declaration
because version 1 has no capability-to-basis dependency map. A mismatched
historic verification basis disables its affected capability. No data is cached
between calls; temporary Git tree/hash reuse is confined to one load.

## Local restrictions and recovery

`ProjectDef.projectDecl` survives existing project read/edit/write operations.
It accepts only `{disabled?, deny?, timeoutSec?, paths?, deploy?}`:

- `disabled: true` disables all declared capabilities.
- `deny` lists exact capability identities such as `validation.author.check`,
  `tests.rules.suite`, `tests.rules.suite.classifier`, `ci.testAdapter`,
  `verification.probes.health` or `deploy`.
- `timeoutSec` maps exact command identities to ceilings no larger than the
  selected declaration's timeout.
- `paths` is an allowed subtree list. Every declared path must fit within it;
  otherwise the entire capability set is unavailable with `LOCAL_PATH_RESTRICTION`. Required checks and test
  gates are retained, never silently removed.
- `deploy` can only be `"none"`.

Unknown identities, increased timeouts, added adapters or commands, provenance
changes, and authorization metadata fail closed. Invalid restrictions are kept
through the legacy whitelist so they cannot silently disappear and grant access.
The command reads projects JSON afresh without the legacy successful-read cache.

The schema-class key `projectDecl` defaults to `observe`. In observe mode the
loader makes no capability available and can send a comparison sample to an
injected observation port. Samples contain reason codes and a boolean candidate,
without command arguments or environment values. The CLI supplies no sink and
writes no files or ledger state. No existing caller imports this loader, so
observation does not change existing actions. A future consumer must wire an
audit sink before enabling execution. Owner authorization remains external.

Rollback:

```
ledger scheduler-recovery claude-orchestrator off \
  --key projectDecl --reason "stop declaration loading"
```

Off returns `RECOVERY_OFF` and no capabilities. It never selects another
project's configuration or turns unknown evidence into a passing result.

Every failure includes `reasonCode`, `field`, `source`, `targetHead`, and a
`manualEntry`. Important reasons include `UNKNOWN_VERSION`, `INVALID_SCHEMA`,
`TARGET_HEAD_UNAVAILABLE`, `PROJECT_REPOSITORY_MISMATCH`, `UNDECLARED`,
`PATH_ESCAPE`, `PATH_MISSING`, `DIRECTORY_REQUIRED`, `BASIS_CHANGED`,
`INFERRED_CAPABILITY`, `UNTRUSTED_PROVENANCE`, `INVALID_RESTRICTION`, and
`CORRUPT_DECLARATION`. Reconfirmation means correcting the target declaration,
reviewing the content hashes and updating its verification metadata through
normal review and merge; it does not mean bypassing an existing gate.

## Acceptance evidence

Baseline: `21719e92853414b98ba8863691d341967b54116e`.

`tests/project-decl.test.ts` creates independent Python/pytest with GitHub
Actions and Go/Makefile repositories. Go uses `develop` and has no `web`
directory. Both cover valid, undeclared, inferred, stale basis and invalid
paths. Additional cases cover linked worktrees, project mismatch, PR/worktree
isolation, fixed refs, symlinks, corrupt declarations, verification ancestry,
future timestamps, timeout restrictions, rejected expansion, and observe/off.

`tests/project-decl-command.test.ts` checks all three read-only views, unchanged
Git index/head/status, argument redaction, uncached damaged local configuration,
and Floka built-in command arrays. Real manager subprocesses also verify a
fresh state directory stays unchanged and a large existing daemon log is not
rotated. The initial switch dispatch failed the fresh-directory assertion due to
legacy cron import initialization; first-import dispatch passes. Its compatibility test compares baseline and
current manager source byte for byte after removing the single new dispatch
import line, and projects source after removing only the new field/whitelist lines.
The old scheduler config, CI workflow, proof command definitions and default
recovery module are compared without stripping. This preserves existing standard
messages, command arguments, exit paths and protected decisions at source level;
the existing projects behavior tests run unchanged alongside the new assertions.

Before/after source fingerprints retained by these comparisons:

| Source | Baseline SHA256 | After excluding new interface |
| --- | --- | --- |
| manager | `00328d41e6eadc42bd4a0f9e7b67b3f87ced91b4f8415529e1734c73d984baa6` | identical |
| projects | `6a90ea7f77000d10a3c2741bc27aaf34dc69286e4e45cbe74b89976d1e74d7fb` | identical |

The safety schema test for ambiguous capability IDs was first observed failing,
then passed after rejecting identity separators. The remaining acceptance cases
are behavioral tests. These are local fixture and static compatibility evidence,
not FULLGATE deployment state or measured Claude capability. The PM observation
period remains 24 hours before considering `projectDecl` on.

Final local validation: 71 focused behavior tests and 14 recovery-key tests pass;
typecheck, guard and six entrypoint builds pass. `bun run check` reached the
host full-test queue but remained fifth for about 27 minutes without starting
tests. Decision `ask_mvbvv4ve8b32ec6cc4` permits delivery with this limitation:
only this order's waiting runner was gracefully withdrawn (exit 130), without
changing or bypassing the host gate. Full validation remains the PR head CI's
responsibility. Scope exception decision `ask_mvbv5jrmcac1975004` authorizes
the three single-line additions outside the ordinary file globs.
