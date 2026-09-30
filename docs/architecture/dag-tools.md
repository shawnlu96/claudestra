# Sub-DAG and card-start MCP tools (i28-L5)

PM / master sessions plan a feature's sub-DAG and start its nodes through four claudestra MCP tools instead of remembering
`ledger feature-new / dag-init / dag-rewrite / dag-bind / task-new / workflow-set` and `manager create` by heart. The design goal
(owner, 2026-10-01): the capability is something the AI can *call*, not something a prompt has to remind it of.

| Tool | Who | What it does |
|------|-----|--------------|
| `plan_feature` | PM / master of the project | `slug` → new feature + v1; `featureId` without a DAG → v1; with a DAG → rewrite to exactly this node list (`reasonKind` + `reason` required, bound cards kept by key). Returns the DAG and **lanes**. |
| `rewrite_dag` | PM / master | `add` / `update` / `remove` planned nodes, `cancel: {key: reason}` in-progress ones; `reasonKind` + `reason` required. Same rules and owner approval as `ledger dag-rewrite`. Returns lanes. |
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
the brief) → `task-set --agent` → `workflow-set --mode auto` (code template v2, author family claude) → `dag-bind`.
Binding is last on purpose: bindings are append-only and a cancelled card counts as a *done* node, which would freeze the node.

Any failure undoes what was done in reverse — workflow back to manual, `manager kill`, brief restored, worktree and branch removed, card
moved to `cancelled` — and returns `{failedStep, rolledBack, leftovers}`. A failed step that may be half-done (worktree, create) is undone
too; atomic ledger writes are not (undoing them could touch a concurrently created card). A card id cannot be reused after rollback: retry
with `taskId`. Dedup keys carry a per-call random attempt so a retry after rollback is not replayed as the earlier success. Concurrent
`start_node` on the same node is refused in-process.

The executor brief (`src/lib/dag-tools-prompt.ts`) is generic; a project can replace the body with `ledger/prompts/exec-template.md`
(`{TASK} {TITLE} {PM} {BRANCH} {BASE} {WORKTREE} {SPEC} {LEDGER}`). The auto-card section (take orders from the scheduler, never message the
PM with progress) is always appended.

Tests: `tests/dag-tools-lanes.test.ts` (pure), `tests/dag-tools-bridge.test.ts` (handlers → in-process ledger, fake git / create / kill).
