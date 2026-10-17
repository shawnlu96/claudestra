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

An explicit `targetBranch` is trusted caller input and resolves
`refs/remotes/origin/…`, never a local branch.
When absent, the target is the local `refs/remotes/origin/HEAD` symbolic ref.
This is a local snapshot: the loader does not fetch or claim remote freshness.
If no such target commit can be fixed, it reports `TARGET_HEAD_UNAVAILABLE`.
Local-only branches and symbolic tracking aliases are rejected. A local branch
ahead of origin cannot supply declarations or commands. A declaration or PR head
cannot select the target. The branch ref is resolved
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
- `deploy: {adapter: "floka"|"none", provenance}`. The Floka adapter additionally
  requires the canonical Floka remote and shipped verification ancestry, even
  for target declarations. Other repositories receive `UNSUPPORTED_DEPLOY_ADAPTER`
  for `deploy`; their independent verified capabilities remain eligible.
- `basis: Basis[]`, with each basis entry `{path, sha256}`.

`Command` is `{id, argv, cwd, env?, timeoutSec, provenance}`.
Environment entries have the form `CI: {from: "CI"}`: both sides must be safe
variable names. Literal environment values are not accepted or persisted.
Every executable item, including classifiers, adapters and probes, has
`provenance: {status: "verified"|"inferred", verifiedHead?, verifiedAt?}`.
Verified items require a full SHA-1 (40 hexadecimal characters) or SHA-256
(64 hexadecimal characters) commit digest and ISO timestamp. The target digest
length must match the repository object format. Basis content hashes always use
SHA-256, independently of the Git object format. Verification must
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

## Built-in basis maintenance

The built-in is a shipped snapshot verified at `21719e928534` (2026-10-17).
Its argv arrays are fixed data, including the eight build entrypoints; they are
not imported from the host checkout. Basis covers the command definitions in
`src/lib/ci-proof-reuse.ts`, the scripts in `package.json`, and the workflow and
required checks in `.github/workflows/ci.yml`. All three files affect the
claims, so version 1 deliberately retains them rather than ignoring frequent
changes. A merged CI or package edit can therefore cause `BASIS_CHANGED` and
make every built-in capability unavailable. This is an expected reconfirmation
state, not an assertion failure or permission to reuse the previous snapshot.

To refresh, review the commands, scripts, checks and paths at one fixed merged
target commit. Read every basis blob from that same commit's Git objects and
compute its content SHA-256. Update the built-in's verification head, timestamp,
basis digests and literal commands together after review. Update the pinned
compatibility fixture head and expected commands to that same reviewed snapshot,
and run the focused declaration tests plus the normal checks. Do not derive new
hashes from worktree edits, silently refresh during loading, or remove a relevant
basis file simply to avoid degradation. Alternatively, merge a reviewed target
`.floka/project.json` with its own corresponding basis and provenance. The
loader and inspection commands never write either form.

## Acceptance evidence

Baseline: `21719e928534`. Tests use its existing local Git objects without
fetching, modifying the host refs, or consulting its current branch. The Floka
fixture is detached and has no `origin/HEAD`; an explicit `main` tracking ref
pins the verification snapshot. Missing target refs degrade explicitly.

`tests/project-decl.test.ts` creates independent Python/pytest with GitHub
Actions and Go/Makefile repositories. Go uses `develop` and has no `web`
directory. Both cover valid, undeclared, inferred, stale basis and invalid
paths. Additional cases cover linked worktrees, project mismatch, committed PR
isolation, local branches ahead of origin, symbolic ref rejection, fixed refs,
symlinks, corrupt declarations, verification ancestry, future timestamps,
timeout restrictions, rejected expansion, and observe/off. A real SHA-256 Go
repository round-trips verified provenance and capabilities. External repositories,
including those spoofing the canonical remote without its ancestry, cannot
activate the Floka deployment adapter.

`tests/project-decl-command.test.ts` checks all three read-only views, unchanged
Git index/head/status, argument redaction, uncached damaged local configuration,
and Floka built-in command arrays. Real manager subprocesses verify that a fresh
state directory stays unchanged and a large existing daemon log is not rotated.
A merged workflow edit in the pinned fixture explicitly asserts `BASIS_CHANGED`
and whole-declaration degradation instead of requiring the current main to retain
old source bytes.

Before/after compatibility evidence compares exact stdout, stderr and exit codes
from the baseline and current manager using the same isolated project data:

- `project-list`: successful list output, exit 0.
- `project-edit`, `project-remove`, `project-assign` without operands: existing
  standard usage errors, exit 0.

Both sides must actually succeed and emit their expected success/error status;
two failed subprocesses cannot count as matching evidence. No entire manager,
workflow, scheduler or projects source file is pinned against unrelated changes.
The existing project behavior tests additionally verify whitelist persistence.
These are fixture and behavior comparisons, not FULLGATE deployment state or
measured Claude capability. The PM observation period remains 24 hours before
considering `projectDecl` on. Scope decision `ask_mvbv5jrmcac1975004` authorizes
the original three single-line additions outside the ordinary file globs.

Revision-1 fix evidence: five added probes were observed failing before the fix
(local unpublished head, local-only PR declaration, local symbolic redirect,
SHA-256 target and foreign Floka adapter). After the fix, the focused declaration,
project and recovery-key run passed 85 tests. The additional abbreviated SHA-256
provenance case passed, and six final target-trust cases passed after making ref
metadata and commit identity a single snapshot. Seven recovery-default tests
also passed. Typecheck, guard and eight entrypoint builds passed. The full
`bun run check` passed typecheck but remained in the host test queue;
only this order's waiting runner was gracefully withdrawn (exit 130), as allowed
by decision `ask_mvbvv4ve8b32ec6cc4`. Full validation remains the PR head CI's
responsibility; neither a queued run nor this fixture evidence claims a full pass.
