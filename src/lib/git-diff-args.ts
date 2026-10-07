/**
 * `git diff` flags that no repository config can use to drop or rename a changed path: `diff.renames` (one side of a rename),
 * `.gitmodules` / `diff.ignoreSubmodules` ignore=all (a moved gitlink) and `diff.relative` (paths outside a sub-directory cwd,
 * the rest named relative to it). Every diff that must see the whole change spreads this. tests/scheduler-merge-handoff-files.test.ts.
 */
export const WHOLE_DIFF_ARGS = ["--no-renames", "--ignore-submodules=none", "--no-relative"] as const;
