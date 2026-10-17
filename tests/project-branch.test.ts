/** Branch context resolution on two foreign fixture repositories (generality-BRANCH1). Local git only; nothing is fetched. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { carriedTarget, carryBranchContext, legacyBranchContext, parseBranchContext, resolveBranchContext } from "../src/lib/project-branch.js";
import { localBranchGit, readBranchContext } from "../src/lib/project-branch-git.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`fixture git failed: ${args[0]}`);
  return r.stdout.toString().trim();
}
function put(repo: string, path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}
function commit(repo: string): string {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
  return git(repo, "rev-parse", "HEAD");
}
const publish = (repo: string, branch: string) => git(repo, "update-ref", `refs/remotes/origin/${branch}`, git(repo, "rev-parse", "HEAD"));

/** Python/pytest + GitHub Actions on main, or Go/Makefile on develop without web/. */
function fixture(stack: "python" | "go") {
  const repo = mkdtempSync(join(tmpdir(), "project-branch-")); roots.push(repo);
  const branch = stack === "go" ? "develop" : "main";
  git(repo, "init", "-q", "-b", branch);
  git(repo, "remote", "add", "origin", `https://github.com/fixtures/${stack}.git`);
  put(repo, "README.md", `${stack} fixture\n`);
  if (stack === "go") { put(repo, "Makefile", "test:\n\tgo test ./...\n"); put(repo, "main.go", "package main\n"); }
  else { put(repo, "pyproject.toml", "[tool.pytest.ini_options]\n"); put(repo, "tests/test_ok.py", "def test_ok():\n    assert True\n");
    put(repo, ".github/workflows/ci.yml", "name: test\non: push\n"); }
  const basisHead = commit(repo);
  publish(repo, branch);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  const provenance = { status: "verified", verifiedHead: basisHead, verifiedAt: "2026-10-17T00:00:00Z" };
  const argv = stack === "go" ? ["make", "test"] : ["python", "-m", "pytest"];
  const cmd = { id: "tests", argv, cwd: ".", timeoutSec: 60, provenance };
  const declaration = (target: string, readme = `${stack} fixture\n`) => ({ version: 1,
    repository: { remote: `fixtures/${stack}`, defaultBranch: branch, targetBranch: target },
    validation: { author: [cmd], review: [], build: [] }, tests: { rules: [], globs: ["tests/**"] },
    ci: { provider: stack === "go" ? "none" : "github", workflows: stack === "go" ? [] : [".github/workflows/ci.yml"], requiredChecks: ["test"],
      testAdapter: null, reports: [] },
    ui: { renderInputs: [] }, verification: { probes: [] }, deploy: { adapter: "none", provenance },
    basis: [{ path: "README.md", sha256: sha256(readme) }] });
  const declare = (target: string, on = branch) => {
    git(repo, "checkout", "-q", on);
    put(repo, ".floka/project.json", JSON.stringify(declaration(target)));
    commit(repo); publish(repo, on);
  };
  const branchFrom = (name: string, from: string) => { git(repo, "branch", "-f", name, from); git(repo, "update-ref", `refs/remotes/origin/${name}`, from); };
  return { repo, branch, declare, branchFrom, read: localBranchGit(repo), head: (b: string) => git(repo, "rev-parse", `refs/remotes/origin/${b}`) };
}

for (const stack of ["python", "go"] as const) {
  describe(`${stack} fixture`, () => {
    test("fixture shape: no Floka files, Go has no web/ and defaults to develop", () => {
      const f = fixture(stack);
      expect(git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(`refs/remotes/origin/${stack === "go" ? "develop" : "main"}`);
      expect(git(f.repo, "ls-tree", "--name-only", "HEAD")).not.toContain("web");
      expect(git(f.repo, "ls-tree", "--name-only", "HEAD")).not.toContain("bun.lock");
    });

    test("declared target: the start branch differs from the target and both are carried with their own heads", () => {
      const f = fixture(stack);
      f.declare(f.branch);
      f.branchFrom("feat/start", f.head(f.branch));
      git(f.repo, "checkout", "-q", "feat/start"); put(f.repo, "extra.txt", "x\n"); commit(f.repo); publish(f.repo, "feat/start");
      const r = readBranchContext(f.read, { expectedRemote: `fixtures/${stack}`, workStartRef: "feat/start" });
      expect(r).toEqual({ ok: true, context: { v: 1, remote: `fixtures/${stack}`, defaultBranch: f.branch, targetBranch: f.branch,
        workStartRef: "feat/start", workStartSha: f.head("feat/start"), targetHead: f.head(f.branch), source: "declared" } });
      expect(r.ok && r.context.workStartSha).not.toBe(r.ok && r.context.targetHead);
    });

    test("declared target on another branch must be declared again at that branch's head", () => {
      const f = fixture(stack);
      f.branchFrom("release", f.head(f.branch));
      f.declare("release");
      const inconsistent = readBranchContext(f.read, {});
      expect(inconsistent).toMatchObject({ ok: false, code: "DECLARATION_INCONSISTENT" });
      f.branchFrom("release", f.head(f.branch)); // release now carries the same declaration
      expect(readBranchContext(f.read, {})).toMatchObject({ ok: true, context: { targetBranch: "release", workStartRef: "release", source: "declared" } });
    });

    test("undeclared: inferred from the fixed origin/HEAD, never from main", () => {
      const f = fixture(stack);
      const r = readBranchContext(f.read, {});
      expect(r).toMatchObject({ ok: true, context: { targetBranch: f.branch, source: "remoteHead", workStartSha: f.head(f.branch) } });
    });

    test("undeclared with an existing PR: the PR base is the target", () => {
      const f = fixture(stack);
      f.branchFrom("integration", f.head(f.branch));
      expect(readBranchContext(f.read, { prBase: "integration" })).toMatchObject({ ok: true, context: { targetBranch: "integration", source: "pr" } });
    });

    test("undeclared without origin/HEAD stops instead of guessing main", () => {
      const f = fixture(stack);
      git(f.repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
      expect(readBranchContext(f.read, {})).toMatchObject({ ok: false, code: "REMOTE_HEAD_MISSING" });
    });

    test("stale basis at the target head stops", () => {
      const f = fixture(stack);
      f.declare(f.branch);
      git(f.repo, "checkout", "-q", f.branch); put(f.repo, "README.md", "changed\n"); commit(f.repo); publish(f.repo, f.branch);
      expect(readBranchContext(f.read, {})).toMatchObject({ ok: false, code: "BASIS_STALE" });
    });

    test("errors: declaration vs PR base, remote identity, missing start ref, malformed declaration", () => {
      const f = fixture(stack);
      f.declare(f.branch);
      expect(readBranchContext(f.read, { prBase: "other" })).toMatchObject({ ok: false, code: "PR_BASE_CONFLICT" });
      expect(readBranchContext(f.read, { expectedRemote: "fixtures/elsewhere" })).toMatchObject({ ok: false, code: "REMOTE_MISMATCH" });
      expect(readBranchContext(f.read, { workStartRef: "nope" })).toMatchObject({ ok: false, code: "REMOTE_HEAD_MISSING" });
      git(f.repo, "checkout", "-q", f.branch); put(f.repo, ".floka/project.json", "{\"version\":1,\"version\":1}"); commit(f.repo); publish(f.repo, f.branch);
      expect(readBranchContext(f.read, {})).toMatchObject({ ok: false, code: "DECLARATION_INCONSISTENT" });
      git(f.repo, "remote", "set-url", "origin", "https://user:secret@github.com/fixtures/x.git");
      expect(readBranchContext(f.read, {})).toMatchObject({ ok: false, code: "REMOTE_UNKNOWN" });
    });
  });
}

describe("pure rules", () => {
  const ctx = { v: 1 as const, remote: "fixtures/go", defaultBranch: "develop", targetBranch: "develop", workStartRef: "feat/a",
    workStartSha: "a".repeat(40), targetHead: "b".repeat(40), source: "declared" as const };
  test("parse is strict and round-trips", () => {
    expect(parseBranchContext(JSON.parse(JSON.stringify(ctx)))).toEqual(ctx);
    expect(parseBranchContext({ ...ctx, extra: 1 })).toBeNull();
    expect(parseBranchContext({ ...ctx, targetBranch: "bad..name" })).toBeNull();
    expect(parseBranchContext({ ...ctx, workStartSha: "abc" })).toBeNull();
  });
  test("carry keeps target and start; a changed one stops", () => {
    expect(carryBranchContext({ ...ctx, workStartSha: null }, ctx)).toMatchObject({ ok: true });
    expect(carryBranchContext(ctx, { ...ctx, targetBranch: "main" })).toMatchObject({ ok: false, code: "CONTEXT_CHANGED" });
    expect(carryBranchContext(ctx, { ...ctx, workStartSha: "c".repeat(40) })).toMatchObject({ ok: false, code: "CONTEXT_CHANGED" });
  });
  test("a start ref never stands in for the target", () => {
    expect(resolveBranchContext({ remote: "o/r", defaultBranch: null, workStartRef: "feat/a" })).toMatchObject({ ok: false, code: "REMOTE_HEAD_MISSING" });
    expect(resolveBranchContext({ remote: "o/r", defaultBranch: "develop", workStartRef: "feat/a" }))
      .toMatchObject({ ok: true, context: { targetBranch: "develop", workStartRef: "feat/a" } });
  });
  test("legacy completion only when repository, base and PR agree", () => {
    expect(legacyBranchContext({ repo: "o/r", base: "main" })).toMatchObject({ targetBranch: "main", source: "legacy" });
    expect(legacyBranchContext({ repo: "o/r", base: "develop" })).toBeNull();
    expect(legacyBranchContext({ repo: "o/r", base: "develop", prBase: "develop" })).toMatchObject({ targetBranch: "develop" });
    expect(legacyBranchContext({ repo: "o/r", base: "main", prBase: "develop" })).toBeNull();
    expect(legacyBranchContext({ repo: null, base: "main" })).toBeNull();
  });
  test("carriedTarget: observe / off keep main (a recorded develop then fails equality); on keeps the record", () => {
    expect(carriedTarget("p", "develop", "observe")).toBe("main");
    expect(carriedTarget("p", "develop", "off")).toBe("main");
    expect(carriedTarget("p", "develop", "on")).toBe("develop");
    expect(carriedTarget("p", null, "on")).toBeNull();
  });
});
