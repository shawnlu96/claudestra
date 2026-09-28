# Ledger done-checklist (`ledger verify`)

A task only reaches `verified` after the system has checked, by itself, that the change is actually live. What the agent or PM says doesn't count. `stage --to verified` is refused, and `ledger verify <task>` is the only way into `verified`. The one exception is a task that returns from `blocked` to a `verified` stage it had already reached.

```
bun src/manager.ts ledger verify <task> [--evidence <path>] [--waive <probe,...> --text <reason>] [--dry-run]
```

- **Checklist.** `lib/ledger-probes.ts` builds the checklist from the PR's file list (`gh pr view --json files`; if it hits the 100-file cap, from the merge commit's diff):
  - `pr-merged` is always on it.
  - Any `web/**` file that isn't `.md` adds `web-local` and `web-relay`.
  - `src/bridge.ts`, `src/bridge/**` or `src/lib/**` adds `daemon-bridge`.
  - `src/cron.ts` adds `daemon-cron`; `src/launcher.ts` adds `daemon-launcher`.
  - A task with no PR gets only `manual-evidence`, which needs `--evidence <path>` pointing at a file that isn't empty.
  - `task.extra.checks` (a list of `web` / `bridge` / `cron` / `launcher`) replaces the inferred groups. A misspelled group name is an error.
- **Probes.** Each probe returns `pass`, `fail` or `unknown` plus its evidence. Facts are collected by `lib/ledger-verify-facts.ts`, and only for the probes on the checklist.
  - `pr-merged`: after `git fetch`, the PR head is in `origin/main`.
  - `web-local` / `web-relay`: the `webCommit` in `web-releases/current/build-info.json` (local) and in the relay's `/build-info.json` must equal, or descend from, the last commit in the merge that touched `web/`. `web-relay` passes as not applicable when no relay is configured.
  - `daemon-*`: the process start time (`ps -o lstart`) is later than `mergedAt`. The bridge's pid is looked up through its listening port first, so the check also works in the sandbox. `/api/v1/version` isn't used because its `commit` is the current HEAD, not the code the running process loaded.
- **Verdict.** All `pass` → one transaction writes the `verify` event and moves the task `live → verified`. Otherwise the event is recorded with `result: fail|unknown`, the task stays in `live`, and the CLI exits 1 naming each failing probe. A PM or owner can waive a failing probe with `--waive <id> --text <reason>`; the reason is stored and the web UI shows it in yellow. If the file list couldn't be read and `extra.checks` isn't set, the verdict is always `unknown`: when we don't know what to check, nothing can count as checked.
- **Display.** The collab-view task detail shows the latest checklist (`web/features/collab/collab-checklist.tsx`).
- Tests: `tests/ledger-probes.test.ts` (pure rules), `tests/ledger-verify.test.ts` (CLI with faked gh / git / ps).
