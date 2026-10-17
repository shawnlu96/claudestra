import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexRunOpts } from "../src/lib/codex.js";
import { loadProjectDeclaration } from "../src/lib/project-decl.js";
import { parseProjectDeclaration } from "../src/lib/project-decl-schema.js";
import { scanProjectDeclaration, type ProjectDeclScanOptions } from "../src/lib/project-decl-scan.js";
import type { ObservedAction } from "../src/lib/recovery-policy.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { git, put } from "./project-decl-fixtures.test.js";
import { ok, passBoundary, publish, scanFixture, stubRunner, type ScanFixture, type Stack } from "./project-decl-scan-fixtures.test.js";

const now = Date.parse("2026-10-18T00:00:00Z");
function scan(f: ScanFixture, run: ProjectDeclScanOptions["run"], extra: Partial<ProjectDeclScanOptions> = {}) {
  return scanProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "on", ai: false, run, boundary: passBoundary, now: () => now, ...extra });
}
const load = (f: ScanFixture) => loadProjectDeclaration({ project: f.project, repoDir: f.repo, mode: "on", now: now + 1000 });
const codes = (r: ReturnType<typeof load>) => r.diagnostics.map((d) => d.reasonCode);
/** Remote merge of the PR commit by a reviewer: the tool itself never does this. */
function merge(f: ScanFixture, pushed: string): string {
  const commit = pushed.split(":")[0];
  git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, commit);
  git(f.repo, "reset", "-q", "--hard", commit);
  return commit;
}
const repoState = (f: ScanFixture) => [git(f.repo, "for-each-ref"), git(f.repo, "status", "--porcelain"), git(f.repo, "worktree", "list", "--porcelain")
  .split("\n").filter((l) => l.startsWith("worktree")).length];

const expected: Record<Stack, { tests: string[][]; ids: string[]; workflows: string[] }> = {
  python: { tests: [["python3", "-m", "pytest"]], ids: ["pytest"], workflows: [".github/workflows/ci.yml"] },
  go: { tests: [["make", "test"], ["go", "test", "./..."]], ids: ["go-test", "go-vet", "go-build", "make-test", "make-build"], workflows: [] },
};

for (const stack of ["python", "go"] as const) describe(`${stack} target scan`, () => {
  test("normal: verified draft, PR changes only the declaration, merged result loads as valid", async () => {
    const f = scanFixture(stack); const { run, state } = stubRunner();
    expect(codes(load(f))).toEqual(["UNDECLARED"]);
    const r = await scan(f, run);
    expect(r.status).toBe("created"); expect(r.pr?.number).toBe(7); expect(state.pushed).toHaveLength(1);
    expect(r.draft?.repository).toEqual({ remote: `fixtures/${stack}-scan`, defaultBranch: f.branch, targetBranch: f.branch });
    expect(r.runs?.map((x) => x.id).sort()).toEqual([...expected[stack].ids].sort());
    expect(r.draft?.tests.rules.map((x) => x.argv)).toEqual(expected[stack].tests);
    expect(r.draft?.ci.workflows).toEqual(expected[stack].workflows);
    expect(r.draft?.ci.requiredChecks).toEqual([]); expect(r.draft?.deploy).toEqual({ adapter: "none", provenance: { status: "inferred" } });
    expect(r.draft?.ui.renderInputs).toEqual([]);
    expect(r.draft?.basis.every((b) => !b.path.startsWith("/") && b.sha256.length === 64)).toBe(true);
    const commit = merge(f, state.pushed[0]);
    expect(git(f.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", `${commit}^`, commit)).toBe(".floka/project.json");
    expect(git(f.repo, "rev-parse", `${commit}^`)).toBe(f.head);
    const loaded = load(f);
    expect(loaded.source).toBe("target"); expect(loaded.diagnostics).toEqual([]); expect(loaded.valid).toBe(true);
    expect(loaded.capabilities.every((c) => c.available && c.provenance.verifiedHead === f.head)).toBe(true);
    expect(state.calls.some((a) => a.includes("merge"))).toBe(false);
    expect(existsSync(join(f.repo, ".git/floka-scan")) ? readdirSync(join(f.repo, ".git/floka-scan")) : []).toEqual([]);
  }, 60_000);
  test("undeclared: observe drafts and samples without any branch, commit, push or PR", async () => {
    const f = scanFixture(stack); const { run, state } = stubRunner(); const before = repoState(f); const seen: ObservedAction[] = [];
    const r = await scan(f, run, { mode: "observe", observe: (a) => seen.push(a) });
    expect(r.status).toBe("observed"); expect(r.pr).toBeUndefined(); expect(parseProjectDeclaration(r.draft).declaration).not.toBeNull();
    expect(state.pushed).toEqual([]); expect(state.calls.some((a) => a[0] === "gh")).toBe(false);
    expect(seen).toEqual([expect.objectContaining({ mechanism: "projectDeclScan", target: f.head, actionKey: "draft-pr" })]);
    expect(repoState(f)).toEqual(before); expect(codes(load(f))).toEqual(["UNDECLARED"]);
  }, 60_000);
  test("inferred: a failing command stays inferred with its reason, others stay verified, unknown never passes", async () => {
    const f = scanFixture(stack);
    const { run, state } = stubRunner((argv) => argv.includes("test") || argv.includes("pytest") ? ok("", 1) : ok());
    const r = await scan(f, run);
    const failed = r.runs?.filter((x) => x.status === "inferred") ?? [];
    expect(failed.length).toBeGreaterThan(0); expect(failed.every((x) => x.reason === "COMMAND_FAILED" && !x.rescan)).toBe(true);
    merge(f, state.pushed[0]);
    const loaded = load(f);
    expect(loaded.valid).toBe(false); expect(codes(loaded)).toContain("INFERRED_CAPABILITY");
    for (const c of loaded.capabilities) expect(c.available).toBe(c.provenance.status === "verified");
  }, 60_000);
  test("stale basis: editing a referenced file after merge degrades the whole declaration", async () => {
    const f = scanFixture(stack); const { run, state } = stubRunner();
    await scan(f, run); merge(f, state.pushed[0]); expect(load(f).valid).toBe(true);
    put(f.repo, stack === "go" ? "Makefile" : "pyproject.toml", "# changed\n"); publish(f);
    const loaded = load(f);
    expect(codes(loaded)).toContain("BASIS_CHANGED"); expect(loaded.capabilities.every((c) => !c.available)).toBe(true);
  }, 60_000);
  test("error path: timeout and missing command are inferred; a PR failure reports class and exit code only", async () => {
    const f = scanFixture(stack);
    const { run } = stubRunner((argv) => argv[0] === "make" || argv.includes("pytest") ? ok("", null, { timedOut: true }) : ok("", 127),
      { createFails: true });
    const r = await scan(f, run);
    expect(r.status).toBe("failed"); expect(r.reasonCode).toBe("PR_FAILED");
    expect(r.manualEntry).toContain("gh pr create 失败（exit 1）");
    expect(JSON.stringify(r)).not.toContain("/Users/"); expect(JSON.stringify(r)).not.toContain("pw@");
    expect(new Set(r.runs?.map((x) => x.reason))).toEqual(new Set(stack === "go" ? ["TIMEOUT", "COMMAND_MISSING"] : ["TIMEOUT"]));
    expect(r.runs?.every((x) => x.status === "inferred")).toBe(true);
  }, 60_000);
});

describe("PR idempotency and rescans", () => {
  test("a retry finds the existing PR (any state) and never opens a second one; branch is stable across clocks", async () => {
    const f = scanFixture("go"); const stub = stubRunner();
    const first = await scan(f, stub.run);
    stub.state.prs[0].state = "CLOSED";
    const before = stub.state.calls.length;
    const second = await scan(f, stub.run, { now: () => now + 3_600_000 });
    expect(second.status).toBe("existing"); expect(second.branch).toBe(first.branch); expect(second.pr?.state).toBe("CLOSED");
    const later = stub.state.calls.slice(before);
    expect(later.some((a) => a[0] === "gh" && a[2] === "create")).toBe(false); expect(stub.state.pushed).toHaveLength(1);
    expect(stub.state.calls.some((a) => a.includes("merge"))).toBe(false);
  }, 60_000);
  test("a rescan opens its own branch and PR instead of overwriting the first", async () => {
    const f = scanFixture("python"); const stub = stubRunner();
    const first = await scan(f, stub.run);
    stub.state.prs.splice(0);
    const rescan = await scan(f, stub.run, { rescan: true });
    expect(rescan.status).toBe("created"); expect(rescan.branch).not.toBe(first.branch);
    expect(rescan.branch?.startsWith("floka/project-decl-rescan/")).toBe(true); expect(stub.state.pushed).toHaveLength(2);
  }, 60_000);
  test("create arguments are structured and bounded: repo, base = target branch, head = scan branch, body from a file", async () => {
    const f = scanFixture("go"); const stub = stubRunner();
    const r = await scan(f, stub.run);
    const create = stub.state.calls.find((a) => a[0] === "gh" && a[2] === "create") ?? [];
    expect(create.slice(0, 11)).toEqual(["gh", "pr", "create", "--repo", "fixtures/go-scan", "--base", "develop", "--head", r.branch ?? "", "--title",
      "AI draft: project declaration (.floka/project.json)"]);
    expect(create[11]).toBe("--body-file"); expect(create).toHaveLength(13);
  }, 60_000);
});

describe("refusals and recovery", () => {
  test("off refuses before reading anything; observe is the permission-class default", async () => {
    const f = scanFixture("go"); const { run, state } = stubRunner();
    const r = await scan(f, run, { mode: "off" });
    expect(r).toMatchObject({ status: "refused", reasonCode: "RECOVERY_OFF" }); expect(state.calls).toEqual([]);
    expect(defaultRecoveryMode("projectDeclScan")).toBe("observe"); expect(highRiskRecoveryKey("projectDeclScan")).toBe(true);
  });
  test("without an attested read confinement the AI scan is refused with a manual entry, codex never runs", async () => {
    const f = scanFixture("python"); const { run, state } = stubRunner(); let called = false;
    const r = await scan(f, run, { ai: true, summary: { codex: async () => { called = true; return { ok: true, message: "", sessionId: null, elapsedMs: 0 }; } } });
    expect(r).toMatchObject({ status: "refused", reasonCode: "READ_ISOLATION_UNAVAILABLE" }); expect(r.manualEntry).toContain("--without-ai");
    expect(called).toBe(false); expect(state.calls).toEqual([]);
  });
  test("attested summary: new read-only thread, isolated cwd, no MCP, redacted material, model cannot add commands", async () => {
    const f = scanFixture("python"); const { run } = stubRunner(); let seen: CodexRunOpts | null = null;
    const codex = async (o: CodexRunOpts) => {
      seen = o;
      return { ok: true, sessionId: null, elapsedMs: 1, message: JSON.stringify({ items: [{ id: "pytest", group: "skip" }, { id: "rm-rf", group: "tests" }] }) };
    };
    const r = await scan(f, run, { ai: true, summary: { codex, isolation: { confined: true, evidence: "test attestation" } } });
    const o = seen as unknown as CodexRunOpts;
    expect(o.sandbox).toBe("read-only"); expect(o.isolateMcp).toBe(true); expect(o.thread).toBeUndefined();
    expect(o.cwd?.startsWith(join(git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "floka-scan"))).toBe(true);
    expect(o.prompt).not.toContain("fixturevalue0123456789abcdef"); expect(o.prompt).not.toContain("DEPLOY_TOKEN");
    expect(r.summary).toBe("applied"); expect(r.draft?.tests.rules).toEqual([]); expect(JSON.stringify(r.draft)).not.toContain("rm-rf");
  }, 60_000);
  test("a project whose registered repository differs is refused; nothing discovered is refused too", async () => {
    const f = scanFixture("go"), other = scanFixture("python"); const { run } = stubRunner();
    expect((await scan(f, run, { project: other.project })).reasonCode).toBe("PROJECT_REPOSITORY_MISMATCH");
    const empty = scanFixture("go");
    for (const p of ["go.mod", "Makefile"]) git(empty.repo, "rm", "-q", p);
    publish(empty);
    expect((await scan(empty, run)).reasonCode).toBe("NOTHING_DISCOVERED");
  }, 60_000);
});
