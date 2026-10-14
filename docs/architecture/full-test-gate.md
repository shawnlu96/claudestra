# Full test gate (本机全量测试闸)

Every executor on one machine runs `bun run check` before each commit, and `check` runs the whole `bun test` suite. Five full runs at once saturate the machine (load, swap) and turn timing-sensitive tests red that pass when run alone. The gate caps how many **full** `bun test` runs execute on this host at the same time (owner decision: at most 2). Runs with test files / paths are never gated.

The admission logic is the existing `src/lib/lend-check-permit.ts` (SQLite-serialized queue, process identity, approval check, tree-confirmed reclaim). This feature only wires it in; it does not change how the permit decides.

## Code map

| Piece | File |
|---|---|
| What counts as a full run; reading the process's own argv | `src/lib/full-test-gate-args.ts` |
| Host gate directory, `policy.json` read / write, permit config + approval verifier | `src/lib/full-test-gate-policy.ts` |
| Supervisor: queue, notices, timeout, signals, process-group tree observer, run log | `src/lib/full-test-gate.ts` |
| Direct `bun test` hook (called first thing in `tests/preload.ts`) | `src/lib/full-test-gate-preload.ts` |
| `bun run test` entry | `scripts/test.ts` |
| `bun run test:gate status \| set …` | `scripts/test-gate.ts` |
| Tests | `tests/full-test-gate.test.ts`, `tests/full-test-gate-run.test.ts` |

`package.json`: `test` = `bun scripts/test.ts`, `check` = `bun run typecheck && bun run test && bun run guard` (only the test step holds a slot; tsc and guard don't).

## Rules

- **Full run** = no positional argument. Known `bun test` options are parsed with their values (`--timeout 10000`, `-t name`, `--preload ./p.ts` are not files). Options whose value is optional (`--bail`, `--changed`, `--parallel`) only take it as `--x=v`, as bun does. Anything unrecognised exits 2 with "测试未启动" — no guessing. A run with a file/path is passed straight to `bun test`, no queue, no slot.
- **CI short-circuit**: `CI=true` or `GITHUB_ACTIONS=true` → `scripts/test.ts` spawns `bun test <args>` unchanged and the preload hook returns at once. Neither reads the policy nor opens the permit store, so ci.yml's `--shard=99999/99999` discovery probe and log format are unchanged.
- **Host directory**: `stateDirIn(homedir())/locks/full-tests/` — it deliberately ignores `CLAUDESTRA_STATE_DIR`. The preload, worktrees and sandboxes each point that variable somewhere else; following it would give every process its own 2 slots. Tests always pass an explicit temporary directory (or a temporary `HOME`).
- **Policy** (`policy.json` in that directory): `{mode: off|observe|on, max, maxWaitMin, source}`. Missing / unreadable / invalid → `observe` (the last two with a stderr note). `on` without `source` → `observe` with a stderr note — the gate never claims to limit when the approval is missing. Defaults: `max` 2, `maxWaitMin` 60. Not in `config.json`: config-store's whitelist read/write drops unknown keys. The approval handed to the permit is verified against the same host policy (`approvalVerifier`), never against caller strings.
- **Supervisor** (`scripts/test.ts`) owns the permit. It spawns `bun test` in its own process group and records `{pgid, start}` under `trees/<id>.json`. The tree observer reports `absent` only when the whole group is gone (or the group-leader PID now belongs to a different process — POSIX doesn't reuse a PID that is still a live group id). After `bun test` exits, the supervisor waits up to 10 s for the group to drain, then releases. If descendants are still there it does **not** release: the slot is reclaimed by the next acquirer once the permit's sweep sees the owner dead and the tree absent. A SIGKILLed supervisor is reclaimed the same way — a missing parent PID alone is never enough.
- **Direct `bun test`**: in the preload `process.argv` is already rewritten to the first test file, so the hook reads the kernel's argv (`/proc/self/cmdline` on Linux, `sysctl KERN_PROCARGS2` on macOS). If it cannot be read, the run is treated as full. A full run without a permit marker is handed to `scripts/test.ts` (the preload cannot be the holder: nobody would be left to confirm that its own tree has exited). The outer `bun test` process just waits for it and returns its exit code. `scripts/test.ts` sets `CLAUDESTRA_FULL_TEST_PERMIT` on the `bun test` it starts (permit id, or `focused` / `unregistered` / …). The preload sees it and does nothing, so there is one slot per run. Nested `bun test` spawned by tests inherit it.
- **Queue**: a stderr line at the first poll and every 30 s after that: mode, max, queue position, time waited, worktree, request id. A line with the wait time on admission. Past `maxWaitMin` the request is cancelled and the run exits 75 with "测试未启动" — `bun test` is never started, and the result is never reported as a pass or a test failure. A gate refusal (store / identity failure after retries, unverified approval) is the same 75.
- **Signals**: while queued, SIGINT / SIGTERM / SIGHUP cancel the request (exit 128+n, "测试未启动"). While running, they are forwarded to the whole `bun test` group (it is not in the terminal's foreground group), and the test's own exit code is returned.
- **observe**: never blocks. Each full run is still registered (permit entry + `runs.jsonl`: who, when, worktree, how many were running, which queue position it would have under `on`, wait, duration, exit code). When it would have queued, one stderr line says so.
- **Mode changes**: per the permit, a different policy can only be installed when no attempt is registered. A run that sees `policy_conflict` keeps polling until the old attempts drain. A queued run keeps the policy it queued under (its own cancel must match). An idle `on` store refuses to go back to `observe` (the permit's no-downgrade rule). Observe runs then go unregistered with a stderr note. `off` always bypasses.

## Owner workflow

`bun run test:gate status` shows the effective policy, registered attempts and a summary of `runs.jsonl` (peak concurrent full runs, how many would have queued at `max`, longest real wait). After the observation period: `bun run test:gate set on --max 2 --source <approval ref>`. `set on` refuses without `--source`. Peers upgrade into `observe` (no policy file) and choose for themselves.
