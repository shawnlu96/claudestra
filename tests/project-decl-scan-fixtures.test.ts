/** Temporary target repositories and injectable git / gh / command ports for the scan tests. Nothing here fetches or pushes. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { ProjectDef } from "../src/lib/projects.js";
import { runBounded, type BoundedResult } from "../src/lib/run-bounded.js";
import type { ExecBoundary, ScanRunner } from "../src/lib/project-decl-scan-run.js";
import { commit, git, put } from "./project-decl-fixtures.test.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); }, 30_000);
export const tempDir = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

export type Stack = "python" | "go";
export interface ScanFixture { repo: string; branch: string; project: ProjectDef; head: string; outside: string }
/** Python / pytest + GitHub Actions on main; Go / Makefile on develop without web/. Both carry a secret-looking line. */
export function scanFixture(stack: Stack): ScanFixture {
  const repo = tempDir(`project-decl-scan-${stack}-`), outside = tempDir("project-decl-scan-outside-");
  const branch = stack === "go" ? "develop" : "main";
  git(repo, "init", "-q", "-b", branch);
  git(repo, "remote", "add", "origin", `https://github.com/fixtures/${stack}-scan.git`);
  if (stack === "python") {
    put(repo, "pyproject.toml", "[project]\nname = \"fixture\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n");
    put(repo, "tests/test_sample.py", "def test_ok():\n    assert 1 + 1 == 2\n");
    put(repo, ".github/workflows/ci.yml", "name: ci\njobs:\n  test:\n    steps:\n      - run: API_TOKEN=fixturevalue0123456789abcdef python -m pytest\n"
      + "        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n");
  } else {
    put(repo, "go.mod", "module example.com/goscan\n\ngo 1.21\n");
    put(repo, "sum.go", "package goscan\n\nfunc Sum(a, b int) int { return a + b }\n");
    put(repo, "sum_test.go", "package goscan\n\nimport \"testing\"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(1, 2) != 3 {\n\t\tt.Fatal(\"sum\")\n\t}\n}\n");
    put(repo, "Makefile", "test:\n\tgo test ./...\n\nbuild:\n\tgo build ./...\n\ndeploy:\n\t./ship.sh\n");
  }
  put(repo, "README.md", `${stack}\n`);
  const head = commit(repo);
  git(repo, "update-ref", `refs/remotes/origin/${branch}`, head);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  return { repo, branch, head, outside, project: { id: `${stack}-scan`, name: stack, dirs: [repo], createdAt: "" } };
}
/** Publishes the current local branch as the trusted target, like a merge on the remote. */
export function publish(f: ScanFixture): string {
  const head = commit(f.repo);
  git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, head);
  return head;
}

export const ok = (stdout = "", code: number | null = 0, extra: Partial<BoundedResult> = {}): BoundedResult =>
  ({ code, stdout, stderr: "", timedOut: false, ...extra });
export const passBoundary: ExecBoundary = { available: true, reason: "stub", wrap: (argv) => ["boundary", ...argv] };

export interface StubState { calls: string[][]; pushed: string[]; prs: { number: number; url: string; state: string }[]; createFails?: boolean }
/**
 * Local git runs for real against the fixture; remote git (ls-remote / push) and gh are answered here. Wrapped commands go to
 * `commands`, keyed on the original argv after the stub boundary marker.
 */
export function stubRunner(commands: (argv: string[]) => BoundedResult = () => ok(), state: Partial<StubState> = {}): { run: ScanRunner; state: StubState } {
  const s: StubState = { calls: [], pushed: [], prs: [], ...state };
  const run: ScanRunner = async (argv, opts) => {
    s.calls.push(argv);
    if (argv[0] === "boundary") return commands(argv.slice(1));
    if (argv[0] === "git" && argv.includes("ls-remote")) return ok("");
    if (argv[0] === "git" && argv.includes("push")) { s.pushed.push(argv.at(-1) ?? ""); return ok(""); }
    if (argv[0] === "git") return runBounded(argv, opts);
    if (argv[0] === "gh" && argv[2] === "list") return ok(JSON.stringify(s.prs));
    if (argv[0] === "gh" && argv[2] === "create") {
      if (s.createFails) return ok("", 1, { stderr: "fatal: /Users/someone/private remote https://user:pw@host/x" });
      s.prs.push({ number: 7, url: "https://github.com/fixtures/pr/7", state: "OPEN" });
      return ok("https://github.com/fixtures/pr/7\n");
    }
    throw new Error(`unexpected command ${argv[0]}`);
  };
  return { run, state: s };
}

test("scan fixtures: Go target uses develop and has no web directory; Python carries workflow secrets", () => {
  const go = scanFixture("go"), py = scanFixture("python");
  expect(git(go.repo, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/develop");
  expect(git(go.repo, "ls-tree", "--name-only", go.head)).not.toContain("web");
  expect(git(py.repo, "show", `${py.head}:.github/workflows/ci.yml`)).toContain("secrets.DEPLOY_TOKEN");
});
