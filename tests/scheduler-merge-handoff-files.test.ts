/**
 * LCK-2: the PR file list the handoff narrows locks to is read on real git, whatever the clone's config says. A submodule set to
 * ignore=all still lists its changed gitlink, and a repoDir below the top with diff.relative=true still names every path from the
 * repository root. Narrowing on a short list would give away locks the PR still needs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../src/lib/run-bounded.js";
import { handoffFiles } from "../src/lib/scheduler-merge-handoff-tick.js";

const PR = "https://github.com/example/repo/pull/7";
const GIT_MS = 30_000; // real git, several commands per case: a loaded machine overruns bun's 5 s default

describe("LCK-2 handoffFiles against a real repository with config that hides paths", () => {
  let root = "", work = "", head = "";
  const sh = async (...argv: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (file: string, body: string) => writeFileSync(join(work, file), body);
  const gitlink = (sha: string) => sh("update-index", "--add", "--cacheinfo", `160000,${sha},mod`);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "lck2-files-"));
    work = join(root, "work");
    await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
    await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
    // origin as configured is the PR repository; fetches go to the local bare copy
    await sh("remote", "add", "origin", "git@github.com:example/repo.git");
    await sh("config", `url.${join(root, "origin.git")}.insteadOf`, "git@github.com:example/repo.git");
    mkdirSync(join(work, "sub"));
    write(".gitmodules", "[submodule \"mod\"]\n\tpath = mod\n\turl = ./mod\n\tignore = all\n");
    write("a.ts", "a\n");
    write("sub/b.ts", "b\n");
    await sh("add", ".gitmodules", "a.ts", "sub/b.ts");
    await gitlink("1".repeat(40));
    await sh("commit", "-q", "-m", "base");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "-b", "feature");
    write("a.ts", "a2\n");
    write("sub/b.ts", "b2\n");
    await sh("add", "a.ts", "sub/b.ts");
    await gitlink("2".repeat(40));
    await sh("commit", "-q", "-m", "feature");
    await sh("push", "-q", "origin", "feature");
    head = await sh("rev-parse", "HEAD");
  }, GIT_MS);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("a submodule with ignore=all still lists its moved gitlink", async () => {
    expect(await handoffFiles(work)(PR, head)).toEqual(["a.ts", "mod", "sub/b.ts"]);
  }, GIT_MS);

  test("a repoDir below the top with diff.relative=true names every path from the root, outer files included", async () => {
    await sh("config", "diff.relative", "true");
    try {
      expect(await handoffFiles(join(work, "sub"))(PR, head)).toEqual(["a.ts", "mod", "sub/b.ts"]);
    } finally { await sh("config", "--unset", "diff.relative"); }
  }, GIT_MS);
});
