/**
 * generality-PROJSCAN1 round-1 review regressions: control-file links (parent-link-write), checkout filters (checkout-filter),
 * reads outside the target (outside-read) and cross-command tree mutation (mutated-evidence). Real Git and real commands; only
 * remote git and gh are stubbed. Marker files outside the fixture repository are test-made and carry no sensitive data.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDeclarationPr } from "../src/lib/project-decl-gh.js";
import { scanProjectDeclaration } from "../src/lib/project-decl-scan.js";
import { confinedPath, createIsolationArea, darwinBoundary, removeIsolationArea, verifyCandidates, type ExecBoundary,
  type ScanRunner } from "../src/lib/project-decl-scan-run.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { git, put } from "./project-decl-fixtures.test.js";
import { ok, passBoundary, publish, scanFixture, stubRunner, tempDir } from "./project-decl-scan-fixtures.test.js";

const MARK = "outside-marker\n";
/** Stub boundary whose wrapped commands really run (unconfined): isolates tree freshness from the sandbox itself. */
const realStub = (calls: { argv: string[]; cwd?: string }[] = []): ScanRunner => {
  const { run } = stubRunner();
  return async (argv, opts) => {
    if (argv[0] !== "boundary") return run(argv, opts);
    calls.push({ argv: argv.slice(1), cwd: opts.cwd });
    return runBounded(argv.slice(1), opts);
  };
};
/** Real sandbox-exec for candidates; remote git and gh stubbed. */
const sandboxed = () => {
  const s = stubRunner();
  const run: ScanRunner = (argv, opts) => argv[0] === "/usr/bin/sandbox-exec" ? runBounded(argv, opts) : s.run(argv, opts);
  return { run, state: s.state };
};

describe("parent-link-write: control files are exclusive and outside every command", () => {
  test("a link planted in the control directory fails the PR step and the outside file is untouched", async () => {
    const f = scanFixture("go"); const control = tempDir("project-decl-scan-control-"); const target = join(f.outside, "victim.txt");
    writeFileSync(target, MARK);
    for (const name of ["project.json", "pr-body.md"]) symlinkSync(target, join(control, name));
    const { run, state } = stubRunner();
    const r = await openDeclarationPr(run, { repoRoot: f.repo, repo: "fixtures/go-scan", base: f.branch, head: f.head, branch: "b",
      content: "{}\n", title: "t", body: "b", controlDir: control });
    expect(r).toEqual({ fail: "控制文件无法排他创建" }); expect(readFileSync(target, "utf8")).toBe(MARK); expect(state.pushed).toEqual([]);
  }, 30_000);
  test("a linked control directory is refused as a whole", async () => {
    const f = scanFixture("go"); const real = tempDir("project-decl-scan-control-"); const linked = join(f.outside, "ctl");
    symlinkSync(real, linked, "dir");
    const r = await openDeclarationPr(stubRunner().run, { repoRoot: f.repo, repo: "fixtures/go-scan", base: f.branch, head: f.head,
      branch: "b", content: "{}\n", title: "t", body: "b", controlDir: linked });
    expect(r).toEqual({ fail: "控制文件无法排他创建" }); expect(existsSync(join(real, "project.json"))).toBe(false);
  }, 30_000);
});

describe("checkout-filter: the head is materialized without any filter, hook or worktree", () => {
  test("a configured smudge filter never runs, even with no boundary; files are the committed bytes", async () => {
    const f = scanFixture("go"); const marker = join(f.outside, "smudge.txt");
    put(f.repo, ".gitattributes", "payload.txt filter=probe\n"); put(f.repo, "payload.txt", "committed\n");
    const head = publish(f);
    git(f.repo, "config", "filter.probe.smudge", `sh -c 'echo ran > ${marker}; cat'`); git(f.repo, "config", "filter.probe.clean", "cat");
    const off = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "observe", ai: false, run: stubRunner().run,
      boundary: darwinBoundary("linux") });
    expect(off.runs?.every((x) => x.reason === "EXEC_BOUNDARY_UNAVAILABLE")).toBe(true);
    const seen: string[] = [];
    const area = await createIsolationArea(runBounded, f.repo, head, "filter-probe");
    try {
      const run: ScanRunner = async (argv, opts) => { seen.push(readFileSync(join(opts.cwd ?? "", "payload.txt"), "utf8")); return ok(); };
      const runs = await verifyCandidates([{ id: "x", argv: ["true"], cwd: ".", group: "tests", timeoutSec: 5, source: "Makefile", definition: "" }],
        area, { run, boundary: passBoundary });
      expect(runs[0].status).toBe("verified");
    } finally { await removeIsolationArea(runBounded, f.repo, area); }
    expect(seen).toEqual(["committed\n"]); expect(existsSync(marker)).toBe(false);
    expect(git(f.repo, "worktree", "list").split("\n")).toHaveLength(1);
  }, 60_000);
});

describe("mutated-evidence: every candidate runs on a fresh copy of the fixed head", () => {
  test("an earlier command rewriting the Makefile cannot turn a failing later command into verified", async () => {
    const f = scanFixture("go");
    put(f.repo, "Makefile", "lint:\n\tprintf 'test:\\n\\ttrue\\n' > Makefile\n\ttouch planted.txt\n\ntest:\n\tfalse\n"); publish(f);
    const calls: { argv: string[]; cwd?: string }[] = [];
    const r = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "observe", ai: false, run: realStub(calls),
      boundary: passBoundary });
    expect(r.runs?.filter((x) => x.id.startsWith("make-")).map((x) => [x.id, x.status, x.reason])).toEqual([
      ["make-lint", "verified", "VERIFIED"], ["make-test", "inferred", "COMMAND_FAILED"]]);
    expect(r.draft?.tests.rules.find((x) => x.id === "make-test")?.provenance).toEqual({ status: "inferred" });
    const cwds = calls.map((c) => c.cwd); expect(new Set(cwds).size).toBe(cwds.length);
  }, 120_000);
});

describe("toolchain whitelist", () => {
  test("PATH is narrowed to the read roots; a tool found only outside them is not run and is never 'command missing'", async () => {
    const f = scanFixture("go"); const bin = join(f.outside, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "floka-outside-tool"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "floka-outside-tool"), 0o755);
    expect(confinedPath(`${bin}:/usr/bin:relative`, ["/usr"])).toBe("/usr/bin");
    const boundary: ExecBoundary = { ...passBoundary, readRoots: ["/usr", "/bin"] };
    const area = await createIsolationArea(runBounded, f.repo, f.head, "toolchain");
    const { run, state } = stubRunner();
    try {
      const runs = await verifyCandidates([{ id: "t", argv: ["floka-outside-tool"], cwd: ".", group: "tests", timeoutSec: 5, source: "Makefile",
        definition: "" }], area, { run, boundary, hostPath: `${bin}:/usr/bin:/bin` });
      expect(runs[0]).toMatchObject({ status: "inferred", reason: "TOOLCHAIN_OUTSIDE_BOUNDARY", rescan: false });
    } finally { await removeIsolationArea(runBounded, f.repo, area); }
    expect(state.calls.some((a) => a[0] === "boundary")).toBe(false);
  }, 30_000);
});

/** Executor's real isolation evidence for the round-1 findings: macOS sandbox-exec with real processes. */
describe.if(darwinBoundary().available)("real boundary (darwin sandbox-exec)", () => {
  test("outside-read: absolute reads and in-repo links out of the target fail; in-tree reads still verify", async () => {
    const f = scanFixture("go"); const secret = join(f.outside, "secret.txt"); writeFileSync(secret, MARK);
    put(f.repo, "expected.txt", MARK); symlinkSync(secret, join(f.repo, "outside-link"));
    put(f.repo, "Makefile", `test:\n\tcmp expected.txt outside-link\n\ncheck:\n\tcat ${secret}\n\nbuild:\n\tcat expected.txt\n`); publish(f);
    const r = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "observe", ai: false, run: sandboxed().run });
    expect(r.discovery?.rejected).toContainEqual({ path: "outside-link", reason: "LINK_REJECTED" });
    expect(r.runs?.filter((x) => x.id.startsWith("make-")).map((x) => [x.id, x.status, x.reason])).toEqual([
      ["make-test", "inferred", "COMMAND_FAILED"], ["make-check", "inferred", "COMMAND_FAILED"], ["make-build", "verified", "VERIFIED"]]);
  }, 180_000);
  test("parent-link-write: a command planting links toward the control files cannot redirect the host's writes", async () => {
    const f = scanFixture("go"); const victim = join(f.outside, "victim.txt"); writeFileSync(victim, MARK);
    const plant = ["project.json", "commit-message.txt", "pr-body.md"].flatMap((n) => [`\t-ln -s ${victim} ../../../control/${n}`,
      `\t-ln -s ${victim} ../../../${n}`, `\t-ln -s ${victim} ../../${n}`, `\t-ln -s ${victim} ../${n}`]).join("\n");
    put(f.repo, "Makefile", `test:\n${plant}\n\ttrue\n`); publish(f);
    const { run, state } = sandboxed();
    const r = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "on", ai: false, run });
    expect(r.status).toBe("created"); expect(r.runs?.find((x) => x.id === "make-test")?.status).toBe("verified");
    expect(readFileSync(victim, "utf8")).toBe(MARK);
    const commit = state.pushed[0].split(":")[0];
    expect(git(f.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", `${commit}^`, commit)).toBe(".floka/project.json");
    expect(JSON.parse(git(f.repo, "show", `${commit}:.floka/project.json`)).version).toBe(1);
  }, 180_000);
  test("mutated-evidence under the real boundary: a later failing command stays inferred", async () => {
    const f = scanFixture("go");
    put(f.repo, "Makefile", "lint:\n\tprintf 'test:\\n\\ttrue\\n' > Makefile\n\ntest:\n\tfalse\n"); publish(f);
    const r = await scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "observe", ai: false, run: sandboxed().run });
    expect(r.runs?.filter((x) => x.id.startsWith("make-")).map((x) => [x.id, x.status])).toEqual([["make-lint", "verified"], ["make-test", "inferred"]]);
  }, 180_000);
});
