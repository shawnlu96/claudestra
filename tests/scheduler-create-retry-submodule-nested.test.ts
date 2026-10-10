/**
 * i28-SUBRETRY1 round 2: an assume-unchanged / skip-worktree flag on a nested gitlink (a submodule inside the submodule)
 * hides that nested checkout from every status; recursive `ls-files` lists its files instead of the flagged gitlink entry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryWorktreeDirty } from "../src/lib/scheduler-create-retry-worktree.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const run = async (cwd: string, ...args: string[]) => {
  const r = await git(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args]);
  if (r.code !== 0) throw new Error(r.out);
  return r.out;
};

/** repo → vendor/sub → nested, all initialized in a separate worktree like the scheduler's author checkout. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "subretry-nested-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const nested = join(dir, "nested"), sub = join(dir, "sub"), repo = join(dir, "repo"), worktree = join(dir, "wt");
  for (const d of [nested, sub, repo]) {
    mkdirSync(d);
    await run(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, "a"), "one\n");
    await run(d, "add", ".");
    await run(d, "commit", "-qm", "one");
  }
  await run(sub, "submodule", "add", "-q", nested, "nested");
  await run(sub, "commit", "-qm", "nested");
  await run(repo, "submodule", "add", "-q", sub, "vendor/sub");
  await run(repo, "commit", "-qm", "submodule");
  await run(repo, "worktree", "add", "-q", "-b", "card", worktree);
  await run(worktree, "submodule", "update", "-q", "--init", "--recursive");
  const subDir = join(worktree, "vendor/sub");
  return { worktree, subDir, nestedDir: join(subDir, "nested") };
}

describe("retry clean check over a nested submodule", () => {
  test("initialized and clean all the way down is clean", async () => {
    const f = await fixture();
    expect(await retryWorktreeDirty(git, f.worktree)).toBeNull();
  });

  const changes: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    "uncommitted edit": async (f) => { writeFileSync(join(f.nestedDir, "a"), "two\n"); },
    "untracked file": async (f) => { writeFileSync(join(f.nestedDir, "x"), "x\n"); },
    "HEAD moved off the recorded commit": async (f) => {
      writeFileSync(join(f.nestedDir, "b"), "b\n");
      await run(f.nestedDir, "add", ".");
      await run(f.nestedDir, "commit", "-qm", "two");
    },
  };
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    for (const [name, change] of Object.entries(changes)) {
      test(`nested ${name} hidden by ${flag} on the nested gitlink is a change`, async () => {
        const f = await fixture();
        await run(f.subDir, "update-index", flag, "nested");
        await change(f);
        expect(await run(f.subDir, "status", "--porcelain", "--ignore-submodules=none")).toBe("");
        expect(await run(f.worktree, "status", "--porcelain")).toBe("");
        expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
        expect(await run(f.subDir, "ls-files", "-v", "nested")).toMatch(/^[hS] nested$/); // the real flag is left as it was
      });
    }
  }

  test("an edit hidden by a flag on a file inside the nested submodule is a change", async () => {
    const f = await fixture();
    await run(f.nestedDir, "update-index", "--assume-unchanged", "a");
    writeFileSync(join(f.nestedDir, "a"), "two\n");
    expect(await run(f.worktree, "status", "--porcelain")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
  });

  test("a flagged gitlink of an uninitialized nested submodule still counts as a change", async () => {
    const f = await fixture();
    await run(f.subDir, "update-index", "--skip-worktree", "nested");
    await run(f.subDir, "submodule", "deinit", "-q", "-f", "nested");
    expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
  });

  test("an uninitialized clean nested submodule is clean, as Git's status says", async () => {
    const f = await fixture();
    await run(f.subDir, "submodule", "deinit", "-q", "-f", "nested");
    expect(await run(f.subDir, "status", "--porcelain", "--ignore-submodules=none")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toBeNull();
  });
});
