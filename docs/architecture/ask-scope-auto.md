# Mechanical scope answers

`askScopeAuto` is a permission recovery key. With no configuration it observes;
`off` uses the existing ask path, and `on` may answer a qualifying scope ask
immediately. It does not change ASKDEF1, tests-only scope expansion, specification
exceptions, or SKIPAUTO1's count-only judge.

## Declaration and registry

`src/lib/ask-scope-registry.ts` is the machine-readable project registry. Each row
names a file, the permitted operations, and the delivery check. A scope ask must
provide `files` and a `default` declaring the shape. Examples:

- `只把本卡三行挪到字母序位置` for the effects inventory.
- `只按字母序加本卡键一行` for recovery keys.
- `只加本卡新命令的条目` for the three command registries.
- `只加 import 一行，再将本卡命令表展开一行` for the manager aggregator.
- `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 src/lib/card-feature.ts`
  for an existing caller.

Unknown shapes, mixed requests, risk markers, security templates, missing specs,
private repositories, and permission/default/guard files use the ordinary path.
A wiring declaration must identify exactly one implementation source within the
card's existing globs. Its target must be an existing regular `src/` file within
the configured repository. A different card's overlapping `scope='card'` lock
blocks wiring until that card is `live`, `verified`, `done`, or `cancelled`;
`resourcesOverlap` compares the paths. A merge-queued card still blocks. Intent
locks and the same card's locks do not block. `SCOPE_PERMISSION_FILES` lists
permission targets that cannot receive automatic wiring grants, including the
peer gates, identity/router, bridge authentication/gateway, and local control
files. Any filename containing `-gate`, `-auth`, or `auth-`, and any
`src/lib/ledger-checks*.ts` path is also excluded. Both the ask and the exact-diff
judge enforce this rule. Explicit rows in `ASK_SCOPE_REGISTRY` retain their
registered operations even when their filename matches the wiring exclusion.
Locks and the card's specification
are checked again under the write transaction before answering.

## Answer and observation

An answer leaves `fileGlobs` unchanged. The ask is answered with
`extra.askScopeAuto=true`, its notice is skipped, and the card receives an
`ask_scope_auto` event containing rule `ask-scope-auto/v1`, specification revision,
ask ID, and per-file grants. Delivery accepts that event only when its actor is
`system:ask-scope-auto`, its target and the answered ask's `taskId` equal this
card, and its grants equal `ask.extra.scopeGrants` item by item (including their
order and every field). These bindings are checked again after Git reads.
The PM handler excludes these asks.

The answer includes the registry/check names and is appended to `## 自动定` using
the existing durable ask-default append protocol. A failed append stays pending
for the existing sweeper; it does not overwrite the spec. Repeated asks reuse the
same ask and append marker. Query-only bridge connections open a scoped writer.

Observe records one `recordObserved` sample per ask ID and sends the original ask
through the original path. It neither answers nor changes the specification.
The implementation does not register or promote its own observation period.
After deployment the PM registers the approved 24-hour v1 observation:

```sh
ledger observation-register agents-ASKSCOPE1 \
  --target recovery:askScopeAuto --project claude-orchestrator \
  --rule v1 --source ledger-events --hours 24 --reason "机械扩围观察"
```

OBSAUTO1 handles the due observation. The PM compares ten samples with actual PM
answers before promotion and checks the next day's scope-question volume.

## Delivery proof

A provisional answer is not an unrestricted file exception. The
`order-deliver-scope.ts` hook reads the exact delivered Git objects and merge base;
branch code is never imported or executed. The changed-file list must be complete,
the PR head must still match, and a change to the judges/permission baseline fails
closed. A missing object, binary diff, changed rule/specification revision, or
unrecognized syntax remains outside scope. Off and observe never grant delivery
exceptions, including for questions answered while the key was on.

The `deliver_scope` event contains `askScopeAuto.files`: paths, addition/deletion
counts, ask IDs, check names, and a granted/reason verdict. The original `files`
and their body lines remain intact. A historical note is appended as
`已自动核准:<path>(登记项 / 小接线)` with the applicable label for each file.
At review time, the current mode decides the presentation: `on` puts verified
paths and line counts in an `已自动核准` section; `off` and `observe` list them
as ordinary outside files, including when the same head reuses an earlier event.
SKIPAUTO1's current-mode rendering continues independently. Old events that
removed paths can recover their line counts from the recorded proof.
No new file locks or broader globs are acquired.

Checks use these deliberately narrow source forms:

- Recovery entries: literal key lines, sorted and unique by
  `recoveryKeysOrderProblem`; the rest of the file is byte-identical. Only an
  exported string literal such as `export const KEY = "myKey";` in a scoped source
  defines a key. Exported function or variable names do not establish ownership.
  Additions use head definitions; deletions require base definitions, so adding
  a definition now cannot authorize deleting someone else's existing key.
- Effect entries: only scoped implementation filenames, with existing gate and
  comments retained. Own lines can move into alphabetical order. The complete
  inventory must equal `headScan`/`parseInventory`, shared with `skip-effects`.
- Command entries: a new quoted command property in a scoped implementation,
  inserted as a static single-line entry inside the named table; existing lines
  and the rest of the file remain byte-identical.
- Manager: exactly one named `*_CMDS` import from a scoped file and one spread
  inside `COMMANDS`.
- Wiring: one single-line named import from an exported symbol in a genuinely new
  scoped source and one to three added call/return lines. Simple identifier/member
  arguments, optional await/result assignment and its immediate return guard are
  recognized. Nested calls, extra expressions, comments/templates masquerading as
  calls, deleted lines, and edits to existing code remain outside scope.

Source-definition parsing is indexed once per proof, capped at 512 files / 4 MiB.
Other syntaxes can still be reviewed through the existing scope process.

## Verification

`tests/ask-scope-auto*.test.ts` covers declarations, ownership, registry shapes,
lock/security/risk/new-file exclusions, real ask/spec/ledger integration,
read-only ledger connections, observe deduplication, and delivery failures.
Run those alongside the existing ASKDEF1, ASK4, specification-exception,
SKIPAUTO1, recovery sample-sink, and PM-job suites, then `bun run check` and
`GUARD_STRICT=1 bun run guard` before committing.

Before promoting `askScopeAuto` from observe, the PM deploys ASKSCOPE2. It adds
no observation delay. If the ASKSCOPE1 observation is due before deployment,
the PM extends its observation registration and promotes only after deployment.
