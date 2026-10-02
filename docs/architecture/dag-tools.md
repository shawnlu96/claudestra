# Sub-DAG and card-start MCP tools (i28-L5)

PM / master sessions plan a feature's sub-DAG and start its nodes through four claudestra MCP tools instead of remembering
`ledger feature-new / dag-init / dag-rewrite / dag-bind / task-new / workflow-set` and `manager create` by heart. The design goal
(owner, 2026-10-01): the capability is something the AI can *call*, not something a prompt has to remind it of.

| Tool | Who | What it does |
|------|-----|--------------|
| `plan_feature` | PM / master of the project | `slug` → new feature + v1; `featureId` without a DAG → v1; with a DAG → rewrite to exactly this node list (`reasonKind` + `reason` required, bound cards kept by key). Returns the DAG and **lanes**. |
| `rewrite_dag` | PM / master | `add` / `update` / `remove` planned nodes, `cancel: {key: reason}` in-progress ones; `reasonKind` + `reason` required. Same rules as `ledger dag-rewrite`: applies at once without notifying the owner; only `scopeChange` (feature scope or a mechanism overhaul, PM's call) waits for owner approval. Returns lanes. |
| `start_node` | PM / master | One call = the old private `mk-auto.sh`: card → worktree → executor brief → `manager create` → agent + fileGlobs → workflow `auto` → `dag-bind`. |
| `show_dag` | any verified session | Current (or `version`) snapshot with each node's card, stage, executor agent, fileGlobs, the pending rewrite and lanes; `diff: [a, b]` instead compares versions. |

## Plumbing

Same pipe as the executor / reviewer order tools: tool schemas in `src/lib/dag-tools.ts` are spread into `ORDER_TOOLS`
(`src/lib/order-tools.ts`), channel-server forwards an `order_tool` frame, `routeOrderTool` enforces `requireVerified`, and
`src/bridge/dag-tools.ts` handles it. Write tools then check the ledger role (`isManager`: the project's PM list, master, owner) before
anything else — start_node creates worktrees and agents, so the CLI's own role check (it runs again, with the caller's channel as actor) is not
the only gate. Every ledger write runs as `manager ledger …` with `DISCORD_CHANNEL_ID` = the caller's channel; the bridge only reads the DB.

## Nodes carry fileGlobs

`DagNode.fileGlobs` (optional in the JSON snapshot, no migration) holds the node's file scope while it is still only planned. The tools
**require** a non-empty list for every node they write (the CLI still accepts nodes without it for old versions). Each entry must pass the
scheduler's `resourceKey`; `sameNode` compares it as a set, so changing a completed node's scope is refused like any other change.
`start_node` copies it into the card's `extra.fileGlobs`, where the scheduler's resource gate reads it.

## Lanes

`src/lib/dag-tools-lanes.ts`, using the scheduler's own `resourceKey` / `resourcesOverlap` so lanes and dispatch never disagree:

- `startNow` — planned, unbound nodes whose deps are satisfied, whose globs overlap neither each other (greedy, graph order) nor a bound
  unfinished node nor another open card of the project with `extra.fileGlobs`.
- `waiting` — `{key, why: deps | files | no_globs, on}`; nodes without globs (old versions) are never guessed parallel.
- `lanes` — unfinished nodes grouped by file overlap: within a group one after another, across groups in parallel (deps aside).

## start_node

Preflight (`src/lib/dag-tools-start.ts`) writes nothing: feature/node exist, node not bound (a bound node returns `duplicate: true` so a
timed-out retry cannot create a second card), deps met, node has fileGlobs, card id `<feature slug>-<key>` / agent `agent-task-<id>` /
branch `feat/<id>` / worktree `~/.claude-orchestrator/worktrees/<id>` all free, repo = the project's first git dir (or `repo`, which must be
one of them), spec card `ledger/docs/tasks/<id>.md` exists (or `spec` text is given and no file exists yet), and scheduler.json would
actually drive an auto card for the project.

Steps (`src/lib/dag-tools-steps.ts`): `task-new` (with `extra.fileGlobs`) → write spec if given → `git fetch` + `git worktree add -b`
(+ `node_modules` / `web/node_modules` symlinks) → executor brief to `ledger/reviews/<id>-exec-prompt.md` → `manager create` (purpose points at
the brief) → `task-set --agent` → `workflow-set --mode auto` (template from the `template` parameter, default code, always that template's v3,
author family claude: ui keeps the owner screenshot gate, security keeps local-only cross-model review; the executor's restate is only
recorded and releases build, and a PM who wants to stop it uses `ledger restate-hold`) → `dag-bind`.
Binding is last on purpose: bindings are append-only and a cancelled card counts as a *done* node, which would freeze the node.

Any failure undoes what was done in reverse — workflow back to manual, `manager kill`, brief restored, worktree and branch removed, card
moved to `cancelled` — and returns `{failedStep, rolledBack, leftovers}`. Three rules keep that honest:

- **A failed result is not proof nothing was written.** manager can commit and then be killed by the timeout (or its stdout can fail to
  parse). After a failed ledger step the tool looks the step up by its dedup key (`task-new`, `task-set`, `dag-bind`) or by the resulting
  state (`workflow-set` has no dedup); if it landed, the step counts as done and the call carries on (`reconciled` in the result).
- **Undo only what this call created** — ownership is proven, never inferred from "it wasn't there when I looked". The card is cancelled
  only if this call's `task-new` event exists. The worktree is added with `--lock --reason dag-start:<id>:<attempt>`, so a failed add is
  cleaned up only through the worktree carrying this call's lock; one created at the same path by anyone else is never touched (unlock
  after a successful add). A branch is deleted if this call's add created it, or — when the add failed — only while it still sits on the
  resolved base commit (no one's work is on it). `git worktree move` is not used: onto an existing directory it moves *into* it.
  The failed step's own undo also runs, since worktree add, create and file writes can stop half-way; files are written atomically.
- **Concurrent calls claim resources, not just nodes.** The bridge holds an in-process claim on the node before preflight and on the
  card id, agent, branch, worktree and file paths (all lower-cased — macOS paths and git refs ignore case) after it; a second call that
  passed preflight at the same time is refused `busy`. Preflight also refuses a card id that differs from an existing one only by case.

A card id cannot be reused after rollback: retry with `taskId`. Dedup keys carry a per-call random attempt so a retry after rollback is
not replayed as the earlier success.

The executor brief (`src/lib/dag-tools-prompt.ts`) is generic; a project can replace the body with `ledger/prompts/exec-template.md`
(`{TASK} {TITLE} {PM} {BRANCH} {BASE} {WORKTREE} {SPEC} {LEDGER}`). The auto-card section (take orders from the scheduler, never message the
PM with progress) is always appended.

Tests: `tests/dag-tools-lanes.test.ts` (pure), `tests/dag-tools-bridge.test.ts` (handlers → in-process ledger, fake git / create / kill).

## Product feature dependencies and ETA

`set_feature_deps({add:[{from,to,note?}],remove:[{from,to}]})` is restricted to PM / master / owner.
`from` is the prerequisite; `to` waits for it. Removals run before additions, each via the ledger CLI
with verified channel identity. Each successful change emits a feature event with origin. Duplicate additions
are idempotent; missing removals and cycles fail. A failed batch reports how many operations already completed.
CLI equivalents: `ledger feature-dep-add <from> <to> [--note <≤60 chars>]`, `feature-dep-rm`, `feature-deps [feature]`.

`GET /api/v1/ledger/:project/product` uses the DAG endpoint's owner gate and one deferred read transaction.
Features use `version` and `counts.completed` to match the shared-ledger DTO; counts additionally include
active, ready, blocked and deferred. The six counts partition current effective nodes. Missing/foreign cards
count as blocked. Nodes starting with `（远期）` or `(远期)` (allowing leading whitespace) count only as deferred. Without a DAG, counts use feature cards
(total/completed/active), and ETA is null. Responses contain no node arrays.

ETA accepts S=1h, 半天=4h, N小时, N分钟 (including 设计稿), N天=8N hours and ranges taking their upper bound.
Unparsed estimates use the project's parsed current-node median, default 4h. Deferred nodes are excluded.
Remaining nodes use full estimates when planned and half estimates when active (including blocked/missing).
Critical path is the longest dependency path through those weights. Calibration k is the median build-to-first-verified
hours / estimate for project nodes first verified in the last 24h, clamped to [0.25,4], default 1 with fewer than 3 samples.
Throughput is the project's cards first verified in the last 12h (investigate uses done), divided by 12, minimum 0.25/h.
Share is max(1, feature active nodes)/max(1, project active nodes), including blocked and excluding deferred.
ETA is now + max(critical path × k, remaining/(throughput × share)) hours. Zero remaining uses the last card completion;
empty DAGs have a null completion time. Feature dependencies propagate maximum ETA in topological order.
`eta.basis` supplies perHour, samples, k, cpHours, remaining and share. All computations inject now.

Known P2: Codex `start_node` queues in bridge memory (queue/start/failure notes include node/card/PM/time); bridge restart clears it, so call `start_node` again.
UI specs need exact non-empty ## 复用对象 / ## 对照基准; no reuse or a new interface requires an owner-approved authorize ask for this project/card (src/lib/spec-lint.ts).
New DAG writes opt into PAGEOK (src/lib/ui-acceptance.ts): all UI nodes need verified whole-page acceptance; late UI needs rewrite; changed UI resets acceptance; cancelled/spec checks can rebind.
Autostart/start_node share the spec gate; UI reviews include 对照基准. dag-bind keeps its version; historical DAGs stay exempt. PM checks relay + owner device + production data against the baseline.
