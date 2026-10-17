import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverProject, redactMaterial, DISCOVERY_MAX_DEPTH } from "../src/lib/project-decl-discovery.js";
import { resolveDeclRepository } from "../src/lib/project-decl-git.js";
import { classifyDeclFailure, degradeForRescan } from "../src/lib/project-decl-scan-classify.js";
import { createIsolationArea, darwinBoundary, removeIsolationArea, scanCommandEnv, verifyCandidates } from "../src/lib/project-decl-scan-run.js";
import { scanProjectDeclaration } from "../src/lib/project-decl-scan.js";
import { runBounded } from "../src/lib/run-bounded.js";
import type { DeclCapability } from "../src/lib/project-decl-capabilities.js";
import { git, put } from "./project-decl-fixtures.test.js";
import { ok, passBoundary, publish, scanFixture, stubRunner } from "./project-decl-scan-fixtures.test.js";

function sixSourceRepo() {
  const f = scanFixture("python");
  put(f.repo, "package.json", JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", deploy: "wrangler deploy", check: "npm publish --dry-run" } }));
  put(f.repo, "bun.lock", "{}\n");
  put(f.repo, "Makefile", "build:\n\tcc -o app app.c\nrelease:\n\t./release.sh\n");
  put(f.repo, "svc/go.mod", "module example.com/svc\n");
  put(f.repo, "crates/core/Cargo.toml", "[package]\nname = \"core\"\n");
  put(f.repo, "a/b/c/package.json", JSON.stringify({ scripts: { test: "deep" } }));
  put(f.repo, "node_modules/x/package.json", JSON.stringify({ scripts: { test: "dependency" } }));
  put(f.repo, ".github/workflows/nested/x.yml", "run: nested\n");
  put(f.repo, "big/package.json", JSON.stringify({ scripts: { test: "x".repeat(300 * 1024) } }));
  mkdirSync(join(f.repo, "linked"));
  symlinkSync(join(f.outside, "package.json"), join(f.repo, "linked/package.json"));
  symlinkSync(f.outside, join(f.repo, "escape"), "dir");
  put(f.outside, "package.json", JSON.stringify({ scripts: { test: "outside" } }));
  publish(f);
  return f;
}

describe("deterministic discovery", () => {
  test("six whitelisted source kinds, bounded depth, skipped dependency trees, links rejected, nothing outside read", () => {
    const f = sixSourceRepo();
    const d = discoverProject(resolveDeclRepository(f.project, f.repo));
    expect(DISCOVERY_MAX_DEPTH).toBe(2);
    expect(d.sources.map((s) => [s.path, s.kind])).toEqual([[".github/workflows/ci.yml", "workflow"], ["Makefile", "Makefile"],
      ["crates/core/Cargo.toml", "Cargo.toml"], ["package.json", "package.json"], ["pyproject.toml", "pyproject.toml"], ["svc/go.mod", "go.mod"]]);
    expect(d.rejected).toEqual(expect.arrayContaining([{ path: "big/package.json", reason: "TOO_LARGE" },
      { path: "escape", reason: "LINK_REJECTED" }, { path: "linked/package.json", reason: "LINK_REJECTED" }]));
    expect(JSON.stringify(d)).not.toContain("outside"); expect(JSON.stringify(d)).not.toContain("dependency");
    expect(JSON.stringify(d)).not.toContain("deep"); expect(d.workflows).toEqual([".github/workflows/ci.yml"]);
    const ids = d.candidates.map((c) => c.id);
    expect(ids).toEqual(["make-build", "crates-core-cargo-test", "crates-core-cargo-build", "bun-test", "bun-lint", "bun-check", "pytest",
      "svc-go-test", "svc-go-vet", "svc-go-build"]);
    expect(d.candidates.find((c) => c.id === "bun-check")?.blocked).toBe("OUTBOUND_SUSPECT");
    expect(ids.some((id) => id.includes("deploy") || id.includes("release"))).toBe(false);
    expect(d.candidates.find((c) => c.id === "svc-go-test")).toMatchObject({ cwd: "svc", group: "tests", argv: ["go", "test", "./..."] });
    expect(d.testGlobs).toEqual(["tests/**", "**/*_test.go"]);
  }, 30_000);
  test("discovery reads Git objects of the target, never uncommitted worktree edits", () => {
    const f = scanFixture("go");
    put(f.repo, "package.json", JSON.stringify({ scripts: { test: "uncommitted" } }));
    const d = discoverProject(resolveDeclRepository(f.project, f.repo));
    expect(d.sources.map((s) => s.path)).toEqual(["Makefile", "go.mod"]);
  }, 30_000);
  test("redaction masks expressions, assignments, credentials, home paths and token-like strings", () => {
    const text = "TOKEN=abc ${{ secrets.X }} https://u:p@h/x /Users/someone/x ghx0123456789abcdefghij0123 go test ./...";
    const out = redactMaterial(text);
    for (const leak of ["abc", "secrets.X", "u:p", "someone", "ghx0123456789abcdefghij0123"]) expect(out).not.toContain(leak);
    expect(out).toContain("go test ./...");
  });
});

describe("runtime failure classification", () => {
  test("only explicit missing command / script evidence proposes a rescan", () => {
    const cases: [Parameters<typeof classifyDeclFailure>[0], ReturnType<typeof classifyDeclFailure>["failureClass"], boolean][] = [
      [{ exitCode: 0 }, "PASSED", false],
      [{ exitCode: 127 }, "COMMAND_MISSING", true],
      [{ exitCode: null, errorCode: "ENOENT" }, "COMMAND_MISSING", true],
      [{ exitCode: null, stderr: "spawn go ENOENT" }, "COMMAND_MISSING", true],
      [{ exitCode: 1, stderr: "npm error Missing script: \"test\"" }, "SCRIPT_MISSING", true],
      [{ exitCode: 2, stderr: "make: *** No rule to make target 'test'.  Stop." }, "SCRIPT_MISSING", true],
      [{ exitCode: 1, stderr: "FAILED tests/test_x.py::test_a - AssertionError" }, "COMMAND_FAILED", false],
      [{ exitCode: 1, stderr: "No module named pytest" }, "COMMAND_FAILED", false],
      [{ exitCode: 1, stderr: "dial tcp: lookup proxy.golang.org: no such host" }, "COMMAND_FAILED", false],
      [{ exitCode: 1, stderr: "open config.json: no such file or directory" }, "COMMAND_FAILED", false],
      [{ exitCode: null, timedOut: true, stderr: "command not found" }, "TIMEOUT", false],
    ];
    for (const [input, failureClass, rescan] of cases) expect(classifyDeclFailure(input)).toEqual({ failureClass, rescan });
  });
  test("a pending rescan degrades only affected capabilities and keeps the declaration data", () => {
    const cap = (field: string): DeclCapability => ({ field, provenance: { status: "inferred" }, available: true, wouldBeAvailable: true });
    const caps = [cap("tests.rules.go-test"), cap("validation.review.go-vet")];
    const r = degradeForRescan(caps, ["tests.rules.go-test"]);
    expect(r.capabilities.map((c) => c.available)).toEqual([false, true]);
    expect(r.reasons).toEqual([{ field: "tests.rules.go-test", reason: "RESCAN_PENDING" }]); expect(caps[0].available).toBe(true);
  });
});

describe("execution boundary", () => {
  test("minimal environment inherits no secret and redirects every home and cache into the area", () => {
    const env = scanCommandEnv("/area", "/usr/bin");
    expect(Object.keys(env).filter((k) => k.includes("TOKEN") || k.includes("KEY") || k.startsWith("GH_") || k.startsWith("AWS"))).toEqual([]);
    for (const [k, v] of Object.entries(env)) if (k.endsWith("HOME") || k.includes("CACHE") || k === "TMPDIR" || k === "GOPATH") expect(v.startsWith("/area")).toBe(true);
  });
  test("no boundary means nothing runs and everything stays inferred; non-darwin has no boundary", async () => {
    const f = scanFixture("go"); const commands: string[][] = [];
    const { run } = stubRunner((argv) => { commands.push(argv); return ok(); });
    const r = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "observe", ai: false, run, boundary: darwinBoundary("linux") });
    expect(commands).toEqual([]); expect(r.runs?.every((x) => x.status === "inferred" && x.reason === "EXEC_BOUNDARY_UNAVAILABLE")).toBe(true);
    expect(r.draft?.validation.build.every((c) => c.provenance.status === "inferred")).toBe(true);
  }, 30_000);
  test("a command cwd that links out of the worktree is refused, not followed", async () => {
    const f = scanFixture("go"); symlinkSync(f.outside, join(f.repo, "out"), "dir"); const head = publish(f);
    const area = await createIsolationArea(runBounded, f.repo, head, "cwd-escape");
    try {
      const runs = await verifyCandidates([{ id: "x", argv: ["true"], cwd: "out", group: "tests", timeoutSec: 5, source: "Makefile", definition: "" }],
        area, { run: stubRunner().run, boundary: passBoundary });
      expect(runs[0]).toMatchObject({ status: "inferred", reason: "CWD_ESCAPE" });
    } finally { await removeIsolationArea(runBounded, f.repo, area); }
    expect(existsSync(area.root)).toBe(false); expect(git(f.repo, "worktree", "list").split("\n")).toHaveLength(1);
  }, 30_000);
});

/** Executor's real isolation evidence: macOS sandbox-exec with real processes, no stubs. Skipped where no boundary exists. */
describe.if(darwinBoundary().available)("real isolated runs (darwin sandbox-exec)", () => {
  test("writes outside the area and network connections are denied; the run is inferred, the file never appears", async () => {
    const f = scanFixture("go"); const marker = join(f.outside, "escaped.txt");
    let connections = 0;
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => { connections++; }, data: () => {} } });
    const net = `python3 -c "import socket; socket.create_connection(('127.0.0.1', ${server.port}), 2)"`;
    put(f.repo, "Makefile", `check:\n\ttouch ${marker}\n\nlint:\n\t${net}\n`); const head = publish(f);
    const area = await createIsolationArea(runBounded, f.repo, head, "real-escape");
    try {
      const d = discoverProject(resolveDeclRepository(f.project, f.repo)).candidates.filter((c) => c.argv[0] === "make");
      const runs = await verifyCandidates(d, area, { run: runBounded, boundary: darwinBoundary() });
      expect(runs.map((r) => [r.id, r.status, r.reason])).toEqual([["make-check", "inferred", "COMMAND_FAILED"], ["make-lint", "inferred", "COMMAND_FAILED"]]);
    } finally { await removeIsolationArea(runBounded, f.repo, area); server.stop(true); }
    expect(existsSync(marker)).toBe(false); expect(connections).toBe(0);
  }, 60_000);
  test("Go / Makefile commands really run inside the boundary; Python without pytest stays inferred, never rescanned", async () => {
    const go = scanFixture("go"), py = scanFixture("python");
    const goResult = await scanProjectDeclaration({ project: go.project, repoDir: go.repo, mode: "observe", ai: false });
    const pyResult = await scanProjectDeclaration({ project: py.project, repoDir: py.repo, mode: "observe", ai: false });
    if (Bun.which("go")) expect(goResult.runs?.filter((r) => r.status === "verified").map((r) => r.id).sort()).toEqual(
      ["go-build", "go-test", "go-vet", "make-build", "make-test"]);
    const pytestRun = pyResult.runs?.find((r) => r.id === "pytest");
    if (!Bun.spawnSync(["python3", "-c", "import pytest"]).success) expect(pytestRun).toMatchObject({ status: "inferred", rescan: false });
    expect(goResult.status).toBe("observed"); expect(pyResult.status).toBe("observed");
    expect(git(go.repo, "status", "--porcelain")).toBe(""); expect(git(go.repo, "worktree", "list").split("\n")).toHaveLength(1);
  }, 180_000);
});
