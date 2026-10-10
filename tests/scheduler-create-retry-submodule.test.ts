/**
 * i28-SUBRETRY1: the retry clean check accepts `160000 commit` tree entries. A submodule is clean only when its HEAD is the
 * recorded commit, no index entry hides edits from status (assume-unchanged / skip-worktree) and its own Git status is empty;
 * uninitialized counts as missing. Other modes and bad paths still throw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryWorktreeDirty } from "../src/lib/scheduler-create-retry-worktree.js";
import { git, type Git } from "../src/lib/scheduler-review-worktree.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const run = async (cwd: string, ...args: string[]) => {
  const r = await git(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args]);
  if (r.code !== 0) throw new Error(r.out);
  return r.out;
};

/** A parent repo with vendor/sub as a submodule, checked out as a separate worktree like the scheduler's author checkout. */
async function fixture(init = true, path = "vendor/sub") {
  const dir = mkdtempSync(join(tmpdir(), "subretry-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sub = join(dir, "sub"), repo = join(dir, "repo"), worktree = join(dir, "wt");
  for (const d of [sub, repo]) {
    mkdirSync(d);
    await run(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, "a.ts"), `${d}\n`);
    await run(d, "add", ".");
    await run(d, "commit", "-qm", "one");
  }
  await run(repo, "submodule", "add", "-q", sub, path);
  await run(repo, "commit", "-qm", "submodule");
  await run(repo, "worktree", "add", "-q", "-b", "card", worktree);
  if (init) await run(worktree, "submodule", "update", "-q", "--init");
  return { worktree, subDir: join(worktree, path), oid: await run(sub, "rev-parse", "HEAD") };
}

describe("retry clean check over a real submodule", () => {
  test("an initialized clean submodule is clean, so the checkout may be rebuilt", async () => {
    const f = await fixture();
    expect(await run(f.worktree, "ls-tree", "HEAD", "vendor/sub")).toBe(`160000 commit ${f.oid}\tvendor/sub`);
    expect(await run(f.worktree, "status", "--porcelain")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toBeNull();
  });

  const changes: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    "HEAD moved off the recorded commit": async (f) => {
      writeFileSync(join(f.subDir, "b.ts"), "b\n");
      await run(f.subDir, "add", ".");
      await run(f.subDir, "commit", "-qm", "two");
    },
    "uncommitted edit": async (f) => { writeFileSync(join(f.subDir, "a.ts"), "edited\n"); },
    "staged edit": async (f) => { writeFileSync(join(f.subDir, "a.ts"), "staged\n"); await run(f.subDir, "add", "a.ts"); },
    "untracked file": async (f) => { mkdirSync(join(f.subDir, "new")); writeFileSync(join(f.subDir, "new", "x.ts"), "x\n"); },
  };
  for (const [name, change] of Object.entries(changes)) {
    for (const hidden of [false, true]) {
      test(`${name}${hidden ? ", hidden from the parent's status by ignoreSubmodules" : ""} is a change`, async () => {
        const f = await fixture();
        if (hidden) await run(f.worktree, "config", "diff.ignoreSubmodules", "all");
        await change(f);
        if (hidden) expect(await run(f.worktree, "status", "--porcelain")).toBe("");
        const dirty = await retryWorktreeDirty(git, f.worktree);
        expect(dirty).toContain("worktree 有改动");
        expect(dirty).toContain("vendor/sub");
      });
    }
  }

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    test(`an edit hidden from every status by ${flag} is a change`, async () => {
      const f = await fixture();
      await run(f.subDir, "update-index", flag, "a.ts");
      writeFileSync(join(f.subDir, "a.ts"), "hidden\n");
      expect(await run(f.subDir, "status", "--porcelain")).toBe("");
      expect(await run(f.worktree, "status", "--porcelain")).toBe("");
      expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
      expect(await run(f.subDir, "ls-files", "-v")).toMatch(/^[hS] a\.ts$/); // the real index flag is left as it was
    });
  }

  test("a clean submodule whose path ends in a space is clean", async () => {
    const f = await fixture(true, "vendor/sub ");
    expect(await run(f.worktree, "status", "--porcelain")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toBeNull();
  });

  test("uninitialized (empty directory) counts as missing, even though the parent's status is empty", async () => {
    const f = await fixture(false);
    expect(await run(f.worktree, "status", "--porcelain")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
  });

  test("an absent submodule directory counts as missing, even when the parent's status hides it", async () => {
    const f = await fixture();
    await run(f.worktree, "config", "diff.ignoreSubmodules", "all");
    rmSync(f.subDir, { recursive: true, force: true });
    expect(await run(f.worktree, "status", "--porcelain")).toBe("");
    expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
  });

  test("a plain directory in place of the submodule is not answered for by the enclosing checkout", async () => {
    const f = await fixture(false);
    writeFileSync(join(f.subDir, "a.ts"), "not a repo\n");
    expect(await retryWorktreeDirty(git, f.worktree)).toMatch(/^worktree 有改动.*：vendor\/sub$/);
  });
});

describe("tree entries outside the accepted shapes still throw", () => {
  const oid = "0".repeat(40);
  const records = [
    `040000 tree ${oid}\tdir`, `160000 blob ${oid}\tvendor/sub`, `100644 commit ${oid}\ta.ts`, `160644 commit ${oid}\tvendor/sub`,
    `160000 commit ${oid}\t.git`, `160000 commit ${oid}\tvendor/../sub`, `160000 commit ${oid}\tvendor//sub`,
    `160000 commit ${oid}\tvendor/./sub`, `160000 commit ${oid}\tvendor/.git/sub`, `160000 commit ${oid}\tvendor/�`,
    `160000 commit ${oid.slice(1)}\tvendor/sub`,
  ];
  const fake = (out: string): Git => async (args) => (args.includes("ls-tree") ? { code: 0, out } : git(args));
  for (const record of records) {
    test(JSON.stringify(record.split(" ")[0] + " " + record.split("\t")[1]), async () => {
      const f = await fixture();
      expect(await retryWorktreeDirty(fake(`${record}\0`), f.worktree)).toContain("不能完整核对 Git tree 条目");
    });
  }

  test("a duplicate submodule path throws", async () => {
    const f = await fixture();
    const out = `160000 commit ${f.oid}\tvendor/sub\x00160000 commit ${f.oid}\tvendor/sub\0`;
    expect(await retryWorktreeDirty(fake(out), f.worktree)).toContain("Git tree 重复路径");
  });
});
