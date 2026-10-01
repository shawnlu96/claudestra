import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScopeGit } from "../src/lib/order-deliver-scope-git.js";

test("real merge-base diff excludes base-only changes and fetches a missing delivered head without changing HEAD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-git-"));
  const origin = join(dir, "origin"), clone = join(dir, "clone"); mkdirSync(origin);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (message: string) => git(origin, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", message);
  try {
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "inside.ts"), "old\n"); git(origin, "add", "."); commit("base");
    git(dir, "clone", "-q", origin, clone);
    const pinned = git(clone, "rev-parse", "HEAD");
    git(origin, "checkout", "-qb", "feature");
    writeFileSync(join(origin, "outside.ts"), "one\ntwo\n"); git(origin, "add", "."); commit("feature");
    const head = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");
    writeFileSync(join(origin, "base-only.ts"), "base advanced\n"); git(origin, "add", "."); commit("main");
    const base = git(origin, "rev-parse", "HEAD"), fetched: string[][] = [];
    const r = await readScopeGit("o/r", "1", head, async (cmd, args) => {
      if (cmd === "gh") return JSON.stringify({ baseRefOid: base, headRefOid: head });
      if (args[0] === "fetch") fetched.push(args);
      return execFileSync(cmd, args, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    });
    expect(r.files).toEqual([{ path: "outside.ts", added: 2, deleted: 0 }]);
    expect(fetched).toHaveLength(2);
    expect(git(clone, "rev-parse", "HEAD")).toBe(pinned);
    expect(git(clone, "status", "--porcelain")).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changed PR head or unreadable base never yields a fabricated file list", async () => {
  const head = "a".repeat(40);
  await expect(readScopeGit("o/r", "1", head, async () => JSON.stringify({ baseRefOid: head, headRefOid: "b".repeat(40) }))).rejects.toThrow("PR head");
  await expect(readScopeGit("o/r", "1", head, async () => JSON.stringify({ baseRefOid: null, headRefOid: head }))).rejects.toThrow("base");
});
