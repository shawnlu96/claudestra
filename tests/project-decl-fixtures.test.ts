/** Isolated repositories only; all git operations are local and never fetch. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { ProjectDef } from "../src/lib/projects.js";
import type { ProjectDeclaration } from "../src/lib/project-decl-schema.js";

const roots: string[] = [];
function cleanupRoots(owned: string[]): void {
  for (const root of owned) rmSync(root, { recursive: true, force: true });
}
afterAll(() => cleanupRoots(roots.splice(0)), 30_000);
test("fixture cleanup removes only owned roots without following dependency symlinks", () => {
  const parent = mkdtempSync(join(tmpdir(), "project-decl-cleanup-")); roots.push(parent);
  const owned = join(parent, "owned");
  put(owned, "file.txt", "owned"); put(parent, "keep/value.txt", "keep");
  symlinkSync(join(parent, "keep"), join(owned, "dependency"), "dir");
  cleanupRoots([owned]);
  expect(existsSync(owned)).toBe(false);
  expect(readFileSync(join(parent, "keep/value.txt"), "utf8")).toBe("keep");
});
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`fixture git failed: ${args[0]}`);
  return r.stdout.toString().trim();
}
export function put(repo: string, path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}
export function commit(repo: string): string {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
  return git(repo, "rev-parse", "HEAD");
}
/** Local object-only clone pins shipped compatibility evidence without consulting the host checkout or remote HEAD. */
export function flokaFixture(root: string, head: string): { repo: string; project: ProjectDef } {
  const repo = mkdtempSync(join(tmpdir(), "project-decl-floka-")); roots.push(repo);
  git(root, "clone", "--quiet", "--shared", "--no-checkout", "--", root, repo);
  // Git object reads still see the entire pinned tree; only legacy CLI source and the edited CI basis need worktree files.
  git(repo, "sparse-checkout", "set", "--cone", "src", ".github");
  git(repo, "checkout", "-q", "--detach", head);
  git(repo, "remote", "set-url", "origin", "https://github.com/shawnlu96/claudestra.git");
  git(repo, "update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", head);
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
  return { repo, project: { id: "self", name: "self", dirs: [repo], createdAt: "" } };
}
export function fixture(stack: "python" | "go" = "python", objectFormat: "sha1" | "sha256" = "sha1") {
  const repo = mkdtempSync(join(tmpdir(), "project-decl-")); roots.push(repo);
  const branch = stack === "go" ? "develop" : "main";
  git(repo, "init", "-q", "-b", branch, `--object-format=${objectFormat}`);
  git(repo, "remote", "add", "origin", `https://github.com/fixtures/${stack}.git`);
  put(repo, "README.md", `${stack} fixture\n`);
  put(repo, stack === "go" ? "Makefile" : "pyproject.toml", stack === "go" ? "test:\n\tgo test ./...\n" : "[tool.pytest.ini_options]\n");
  put(repo, "tests/sample.txt", "fixture\n"); put(repo, "reports/sample.txt", "fixture\n");
  put(repo, ".github/workflows/ci.yml", "name: test\n");
  const basisHead = commit(repo);
  git(repo, "update-ref", `refs/remotes/origin/${branch}`, basisHead);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  const provenance = { status: "verified" as const, verifiedHead: basisHead, verifiedAt: "2026-10-17T00:00:00Z" };
  const argv = stack === "go" ? ["make", "test"] : ["python", "-m", "pytest"];
  const cmd = { id: "tests", argv, cwd: ".", env: { CI: { from: "CI" } }, timeoutSec: 60, provenance };
  const declaration: ProjectDeclaration = { version: 1,
    repository: { remote: `fixtures/${stack}`, defaultBranch: branch, targetBranch: branch },
    validation: { author: [structuredClone(cmd)], review: [structuredClone(cmd)], build: [structuredClone(cmd)] },
    tests: { rules: [{ id: "suite", argv, dir: "tests", timeoutSec: 60, provenance, fullWhen: ["**"], classifier: structuredClone(cmd) }], globs: ["tests/**"] },
    ci: { provider: stack === "go" ? "none" : "github", workflows: stack === "go" ? [] : [".github/workflows/ci.yml"], requiredChecks: ["test"], testAdapter: structuredClone(cmd),
      reports: ["reports/**"], fullScope: ["**"], proof: [{ path: "README.md", sha256: hash(`${stack} fixture\n`) }] },
    ui: { renderInputs: [] }, verification: { probes: [structuredClone(cmd)] }, deploy: { adapter: "none", provenance },
    basis: [{ path: "README.md", sha256: hash(`${stack} fixture\n`) }] };
  const project: ProjectDef = { id: stack, name: stack, dirs: [repo], createdAt: "" };
  const publish = () => {
    put(repo, ".floka/project.json", JSON.stringify(declaration));
    const head = commit(repo);
    git(repo, "update-ref", `refs/remotes/origin/${branch}`, head);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
    return head;
  };
  return { repo, branch, project, declaration, publish, basisHead };
}
