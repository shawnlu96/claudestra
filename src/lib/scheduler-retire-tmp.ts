/**
 * i28-S2b: after a card's sessions are retired and its worktrees removed, delete the Claude Code temp folder each of its sessions
 * left behind (`<tmp root>/<cwd slug>/` — tool output and scratchpads, often hundreds of MB per card). The folder path is only ever
 * computed here from the card's own checkout paths, never taken from outside; every guard below must pass or nothing is deleted.
 * docs/architecture/scheduler-retire.md § Session temp folders; tests in tests/scheduler-retire-tmp.test.ts.
 */
import { lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { projectSlug } from "./session-recall.js";
import { RETIRE_STAGES, type SchedulerSession } from "./scheduler-sessions.js";

export interface TmpCleaner {
  /** `claudeTmpRoot()`; null = no uid on this platform, so no folder can be named and the step is skipped. */
  root: string | null;
  rm(path: string): Promise<void>;
}

/**
 * Claude Code's per-user temp root: `CLAUDE_CODE_TMPDIR` or `/tmp` (not `os.tmpdir()`: on macOS that is /var/folders/…, where
 * Claude Code writes nothing), resolved through symlinks (`/tmp` → `/private/tmp`), plus `claude-<uid>`. The uid folder itself
 * is not resolved: a symlink there is refused by tmpDirVerdict, never followed.
 */
export function claudeTmpRoot(env: Record<string, string | undefined> = process.env, uid: number | null = process.getuid?.() ?? null): string | null {
  if (uid === null) return null;
  const base = env.CLAUDE_CODE_TMPDIR || "/tmp";
  try { return join(realpathSync(base), `claude-${uid}`); } catch { return null; /* no tmp base at all: nothing of Claude Code's to clean */ }
}

/** The folder Claude Code keeps for sessions started in `cwd`: every non-alphanumeric character of the path becomes `-`. */
export const claudeTmpDirFor = (cwd: string, root: string): string => join(root, projectSlug(cwd));

const lstatOrNull = (p: string) => {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

export type TmpVerdict = { rm: string } | { gone: string } | { refuse: string };

/**
 * Whether `dir` may be deleted: exactly one level under a real (non-symlink) root, itself a real folder, and no agent still
 * running has a cwd that maps to the same folder. `liveCwds` = cwds of every agent not provably stopped, PM's included.
 * Not there (or no root at all) = gone: a later pass finding it already deleted counts as done.
 */
export function tmpDirVerdict(dir: string, root: string, liveCwds: readonly { name: string; cwd: string }[]): TmpVerdict {
  const name = basename(dir);
  if (!name || name === "." || name === ".." || name.includes(sep) || dir !== join(root, name)) return { refuse: `不是临时根下一层的目录：${dir}` };
  const r = lstatOrNull(root);
  if (!r) return { gone: dir };
  if (r.isSymbolicLink() || !r.isDirectory()) return { refuse: `临时根不是实目录（符号链接不跟）：${root}` };
  const d = lstatOrNull(dir);
  if (!d) return { gone: dir };
  if (d.isSymbolicLink() || !d.isDirectory()) return { refuse: `不是实目录（符号链接不跟、不删）：${dir}` };
  const real = realpathSync(dir), realRoot = realpathSync(root);
  if (real === realRoot || dirname(real) !== realRoot) return { refuse: `解析后不在临时根下一层：${real}` };
  const holder = liveCwds.find((a) => projectSlug(a.cwd) === name);
  if (holder) return { refuse: `${holder.name} 还在跑，它的会话也用这个目录` };
  return { rm: dir };
}

export interface TmpStepInput {
  stage: string;
  /** The card's two checkouts (worktreeDirs order: executor, reviewer) and whether each is gone now. */
  checkouts: { dir: string; role: SchedulerSession["role"]; kept: boolean }[];
  sessions: Pick<SchedulerSession, "role" | "transport" | "state">[];
  liveCwds: { name: string; cwd: string }[];
}

/** One pass of the step: `done` goes into the settle receipt, `failed` (refused or rm failed) into PM's combined notice. */
export async function cleanSessionTmp(t: TmpCleaner | undefined, input: TmpStepInput): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [], failed: string[] = [];
  if (!t?.root || !RETIRE_STAGES.includes(input.stage as (typeof RETIRE_STAGES)[number])) return { done, failed };
  if (input.sessions.some((s) => s.state !== "retired")) return { done, failed };
  for (const c of input.checkouts) {
    if (c.kept || input.sessions.some((s) => s.role === c.role && s.transport === "peer")) continue; // peer: the folder is on the lender's machine
    const v = tmpDirVerdict(claudeTmpDirFor(c.dir, t.root), t.root, input.liveCwds);
    if ("refuse" in v) { failed.push(`临时目录没删：${v.refuse}`); continue; }
    if ("gone" in v) { done.push(`${basename(v.gone)} 本不在`); continue; }
    const err = await t.rm(v.rm).then(() => null, (e: unknown) => {
      if (e instanceof SchedulerStopped) throw e; // the service stopping is not a failed delete
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error).message;
    });
    if (err) failed.push(`临时目录 ${v.rm} 删除失败：${err}`); else done.push(`${basename(v.rm)} 已删`);
  }
  return { done, failed };
}

/** Production: Node's fs.rm, recursive, on exactly the one folder (it unlinks symlinks inside rather than following them). */
export const nodeTmpCleaner = (): TmpCleaner => ({ root: claudeTmpRoot(), rm: (p) => rm(p, { recursive: true }) });
