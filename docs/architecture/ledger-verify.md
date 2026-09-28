# Ledger done-checklist (`ledger verify`)

A task only reaches `verified` after the system has checked, by itself, that the change is actually live. What the agent or PM says doesn't count. `stage --to verified` is refused, and `ledger verify <task>` is the only way into `verified`. The one exception is a task that returns from `blocked` to a `verified` stage it had already reached.

```
bun src/manager.ts ledger verify <task> [--evidence <path>] [--waive <probe,...> --text <reason>] [--dry-run]
```

## Checklist

`lib/ledger-probes.ts` builds the checklist from the PR's changed files. The file list comes from `gh api …/pulls/N/files` (paginated), so squash and rebase merges work too.

- **PR** → `pr-merged`, always.
- **Web** → any `web/**` file that isn't `.md` adds `web-local` and `web-relay`.
- **Daemons** → a changed file adds `daemon-<name>` if it is in the static import closure of that daemon's entry (`src/bridge.ts`, `src/cron.ts`, `src/launcher.ts`). The closure is computed in `lib/ledger-daemon-map.ts`, so a shared `src/lib` file can require all three. If an entry can't be read, the check falls back to: `src/lib` requires all three.
- **`task.extra.checks`** (`web` / `bridge` / `cron` / `launcher`, non-empty) can only **add** groups on top of the inferred ones. It replaces them only when the file list is unavailable. To drop an inferred probe, waive it.
- **No file list and no `extra.checks`** → the checklist is *incomplete*: the verdict is `unknown`, and waivers can't change that.
- **`code` tasks must have a PR.** A task without a PR (ops) only gets `manual-evidence`: `--evidence` must point at a file that isn't empty.
- **Ownership (three states).** The probes only know this repository, so verify first decides whether the task belongs to it:
  - *yes* — the PR link's `owner/repo` equals this repo's `origin`, or (no comparable link) this repo's main worktree resolves (most specific dir, umbrella dirs `/` / `$HOME` / `/tmp` exact-match only, real paths) to the task's project. Full checklist.
  - *no* — the PR link equals the `origin` of another dir of the task's project (a project with several repos, e.g. claudestra-relay) **and** a PM declared that repo in `task.extra.repo` (executors can't write `extra`, so re-pointing the PR link alone stays *unknown*, with the command to declare it), or the project's dirs all exist and none of them holds this repo. Only `manual-evidence` runs, with a translatable note; a `code` task in this state doesn't need a PR.
  - *unknown* — anything else: git can't read this repo or its origin, the project has no dirs / isn't in `projects.json`, a registered dir is missing or not absolute, this repo's dir is registered under two projects, or the PR link points elsewhere while the dirs don't rule this repo out ("PR link and project disagree"). The checklist is incomplete (`incompleteReason: "ownership"`) and can't pass.
- **Project dirs are guarded at write time** (`lib/project-dirs.ts`, `manager/project-guard.ts`): `project-add` / `project-edit --dirs` / `project-merge` accept absolute paths only (`~`, `$HOME`, relative paths are refused with the expanded form) and refuse a dir already registered under another project (compared by real path, so case and symlinks don't split one dir in two). All three run only for owner / master / the PM of the target project(s) (both sides for merge), so an executor doesn't edit its project's dirs by accident — identity is self-reported (`ledger-identity.ts`), so this guards against slips, not a determined agent.
- **Where it came from.** Every run records `checklistSource` (`files` / `files+extra` / `extra` / `evidence`); the CLI output and the web UI both show it.

## Probes

Each probe returns `pass`, `fail` or `unknown` plus its evidence. Facts are collected by `lib/ledger-verify-facts.ts`, and only for the probes on the checklist. External commands run through `lib/run-bounded.ts`, which puts each command in its own process group and kills the whole group on timeout. They also run with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and git low-speed limits.

- **`pr-merged`**:
  - the PR is `MERGED`;
  - its head branch equals `task.branch`;
  - after `git fetch`, the **merge commit** is in `origin/main`.

  This probe can't be waived. After merge, executors can no longer change `pr` / `branch` / `head`.
- **`web-local` / `web-relay`**: the `webCommit` served locally (`web-releases/current/build-info.json`) and by the relay (`/build-info.json`) must equal, or descend from, the last commit in the merge that touched `web/`. When no relay is configured, `web-relay` passes as not applicable.
- **`daemon-*`** checks the code the process actually runs:
  - **Process.** Find the pid (the bridge through its listening port, so the sandbox works; otherwise launchd) and its working dir (`lsof -d cwd`).
  - **Code.** That dir's `HEAD` must contain the merge commit.
  - **Restart.** The process must have started (`ps -o lstart`) after the moment its `HEAD` began containing the merge commit, taken from the reflog, and after `mergedAt`.

  This catches three cases: restarted without fast-forwarding, crash-restarted on old code, and restarted *before* fast-forwarding. `/api/v1/version` isn't used because its `commit` is the current HEAD, not the code the running process loaded.

## Verdict

- **All pass (or waived).** One transaction writes the `verify` event and moves the task `live → verified`. `recordVerify` re-checks inside that transaction that `checks` is non-empty and that every entry is `pass` or waived with a reason.
- **Otherwise.** The event is recorded with `result: fail|unknown`, the task stays in `live`, and the CLI exits 1 naming each failing probe.
- **Waivers.** A PM or owner waives with `--waive <id> --text <reason>`. The web UI shows waived rows in yellow, and the headline reads "passed (N waived)".
- **Wording.** Each probe's `detail` is built from a template plus params (`tpl` / `params`). The web UI translates the template (`web/lib/i18n-dict-collab.ts`), and a test checks every template has an English entry.
- **Display.** The collab-view task detail shows the latest checklist (`web/features/collab/collab-checklist.tsx`).
- **Tests:**
  - `tests/ledger-probes.test.ts`: pure rules.
  - `tests/ledger-daemon-map.test.ts`: import closure, including the real repo.
  - `tests/run-bounded.test.ts`: group kill on timeout.
  - `tests/ledger-verify.test.ts`: the CLI with faked gh / git / lsof / ps.
