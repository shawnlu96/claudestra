import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProjectDeclaration, type ProjectDeclOptions } from "../src/lib/project-decl.js";
import { parseProjectDeclaration } from "../src/lib/project-decl-schema.js";
import { fixture, git, put, commit, hash } from "./project-decl-fixtures.test.js";

const now = Date.parse("2026-10-18T00:00:00Z");
const load = (f: ReturnType<typeof fixture>, extra: Partial<ProjectDeclOptions> = {}) =>
  loadProjectDeclaration({ project: f.project, repoDir: f.repo, now, mode: "on", ...extra });
const codes = (r: ReturnType<typeof load>) => r.diagnostics.map((d) => d.reasonCode);

for (const stack of ["python", "go"] as const) describe(`${stack} independent target repository`, () => {
  test("all fields round-trip; verified commands only; develop and no web assumptions", () => {
    const f = fixture(stack); const head = f.publish(); const result = load(f);
    expect(result.diagnostics).toEqual([]); expect(result.targetHead).toBe(head);
    expect(result.declaration).toEqual(f.declaration); expect(result.source).toBe("target"); expect(result.valid).toBe(true);
    expect(result.capabilities.every((c) => c.available)).toBe(true);
    expect(result.capabilities[0].command?.argv).toEqual(stack === "go" ? ["make", "test"] : ["python", "-m", "pytest"]);
    if (stack === "go") { expect(existsSync(join(f.repo, "web"))).toBe(false); expect(result.declaration?.repository.defaultBranch).toBe("develop"); }
  }, 30_000);
  test("undeclared does not inherit host built-in and never reports success", () => {
    const f = fixture(stack);
    git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${f.branch}`);
    git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, f.basisHead);
    const r = load(f); expect(codes(r)).toEqual(["UNDECLARED"]); expect(r.source).toBe("none"); expect(r.valid).toBe(false);
    expect(r.capabilities).toEqual([]);
  }, 30_000);
  test("inferred capabilities are unavailable while independent verified items remain", () => {
    const f = fixture(stack); f.declaration.validation.author[0].provenance = { status: "inferred" }; f.publish();
    const r = load(f); expect(codes(r)).toContain("INFERRED_CAPABILITY"); expect(r.valid).toBe(false);
    expect(r.capabilities[0].available).toBe(false); expect(r.capabilities[1].available).toBe(true);
  }, 30_000);
  test("changed basis invalidates all capabilities, with no stale cache reuse", () => {
    const f = fixture(stack); f.publish(); expect(load(f).valid).toBe(true);
    put(f.repo, "README.md", "changed\n"); commit(f.repo);
    git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, "HEAD");
    const r = load(f); expect(codes(r)).toContain("BASIS_CHANGED"); expect(r.capabilities.every((c) => !c.available)).toBe(true);
    expect(r.valid).toBe(false);
  }, 30_000);
  test("bad cwd is a structured failure, never unknown-as-pass", () => {
    const f = fixture(stack); f.declaration.validation.author[0].cwd = "../outside"; f.publish();
    const r = load(f); expect(codes(r)).toContain("INVALID_SCHEMA"); expect(r.valid).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ source: "target", field: "validation.author.0.cwd" });
    expect(r.diagnostics[0].targetHead).toHaveLength(40); expect(r.diagnostics[0].manualEntry.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("trust boundary", () => {
  test("worktree edits and PR head declarations cannot select or replace target", () => {
    const f = fixture(); const target = f.publish();
    git(f.repo, "checkout", "-q", "-b", "untrusted-pr");
    f.declaration.repository.targetBranch = "untrusted-pr";
    f.declaration.validation.author[0].argv = ["untrusted"];
    put(f.repo, ".floka/project.json", JSON.stringify(f.declaration)); commit(f.repo);
    put(f.repo, ".floka/project.json", "broken uncommitted data");
    const r = load(f); expect(r.targetHead).toBe(target); expect(r.valid).toBe(true);
    expect(r.capabilities[0].command?.argv).toEqual(["python", "-m", "pytest"]);
  }, 30_000);
  test("uncommitted declaration does not authorize an undeclared target", () => {
    const f = fixture(); put(f.repo, ".floka/project.json", JSON.stringify(f.declaration));
    const r = load(f, { targetBranch: f.branch }); expect(codes(r)).toContain("UNDECLARED"); expect(r.valid).toBe(false);
  }, 30_000);
  test("worktree identity accepted; different project repository rejected", () => {
    const f = fixture(); f.publish(); const other = fixture("go");
    const wt = join(other.repo, "linked"); git(f.repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    expect(load(f, { repoDir: wt }).valid).toBe(true);
    const r = load(f, { repoDir: other.repo }); expect(codes(r)).toContain("PROJECT_REPOSITORY_MISMATCH"); expect(r.capabilities).toEqual([]);
  }, 30_000);
  test("no fixed target ref means explicit degradation, never current HEAD fallback", () => {
    const f = fixture(); f.publish(); git(f.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const r = load(f); expect(codes(r)).toContain("TARGET_HEAD_UNAVAILABLE"); expect(r.valid).toBe(false);
  }, 30_000);
  test("wrong declared repository or branch rejected without built-in fallback", () => {
    const f = fixture(); f.declaration.repository.remote = "fixtures/other"; f.publish();
    expect(codes(load(f))).toContain("DECLARATION_REPOSITORY_MISMATCH");
    f.declaration.repository.remote = "fixtures/python"; f.declaration.repository.targetBranch = "other"; f.publish();
    expect(codes(load(f))).toContain("DECLARATION_REPOSITORY_MISMATCH");
  }, 30_000);
  test("committed symlinks in declaration, basis or cwd are refused", () => {
    for (const location of ["basis", "cwd", "declaration"] as const) {
      const f = fixture();
      symlinkSync("README.md", join(f.repo, "link"));
      if (location === "basis") f.declaration.basis[0].path = "link";
      if (location === "cwd") f.declaration.validation.author[0].cwd = "link";
      f.publish();
      if (location === "declaration") {
        git(f.repo, "rm", "-q", ".floka/project.json"); mkdirSync(join(f.repo, ".floka"), { recursive: true }); symlinkSync("../README.md", join(f.repo, ".floka/project.json"));
        commit(f.repo); git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, "HEAD");
      }
      expect(codes(load(f))).toContain("PATH_ESCAPE"); expect(load(f).valid).toBe(false);
    }
  }, 30_000);
  test("cwd must be a directory, even when a regular file exists", () => {
    const f = fixture(); f.declaration.validation.author[0].cwd = "README.md"; f.publish();
    expect(codes(load(f))).toContain("DIRECTORY_REQUIRED"); expect(load(f).capabilities.every((c) => !c.available)).toBe(true);
  }, 30_000);
  test("missing basis, invalid old verification content, unrelated or future provenance fail closed", () => {
    const f = fixture(); f.publish();
    f.declaration.basis[0].path = "missing"; f.publish(); expect(codes(load(f))).toContain("PATH_MISSING");
    f.declaration.basis[0].path = "README.md"; f.declaration.validation.author[0].provenance.verifiedHead = "f".repeat(40); f.publish();
    expect(codes(load(f))).toContain("UNTRUSTED_PROVENANCE");
    f.declaration.validation.author[0].provenance.verifiedHead = f.basisHead;
    f.declaration.validation.author[0].provenance.verifiedAt = "2030-01-01T00:00:00Z"; f.publish();
    expect(codes(load(f))).toContain("UNTRUSTED_PROVENANCE");
  }, 30_000);
  test("historic basis contents must match the verification commit too", () => {
    const f = fixture(); put(f.repo, "README.md", "new\n"); commit(f.repo);
    f.declaration.basis[0].sha256 = hash("new\n");
    f.declaration.ci.proof = [];
    f.publish(); expect(codes(load(f))).toContain("VERIFICATION_BASIS_MISMATCH");
  }, 30_000);
  test("a corrupt committed declaration never reuses the previous valid result", () => {
    const f = fixture(); f.publish(); expect(load(f).valid).toBe(true);
    put(f.repo, ".floka/project.json", "{"); commit(f.repo); git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, "HEAD");
    const r = load(f); expect(codes(r)).toContain("CORRUPT_DECLARATION"); expect(r.source).toBe("target"); expect(r.capabilities).toEqual([]);
  }, 30_000);
});

describe("local constraints and recovery", () => {
  test("smaller timeouts, denied capabilities and disabled deployment restrict without deleting required gates", () => {
    const f = fixture(); f.declaration.deploy.adapter = "floka"; f.publish();
    f.project.projectDecl = { timeoutSec: { "validation.author.tests": 30 }, deny: ["ci.testAdapter"], deploy: "none", paths: ["."] };
    const r = load(f); expect(r.capabilities[0].command?.timeoutSec).toBe(30);
    expect(r.capabilities.find((c) => c.field === "ci.testAdapter")?.available).toBe(false);
    expect(r.capabilities.find((c) => c.field === "deploy")?.available).toBe(false);
    expect(r.declaration?.ci.requiredChecks).toEqual(["test"]); expect(r.declaration?.validation.author).toHaveLength(1);
  }, 30_000);
  test("expansions, unknown capability identities, injected authorization and path ambiguity are rejected", () => {
    const f = fixture(); f.publish();
    for (const restriction of [{ timeoutSec: { "validation.author.tests": 61 } }, { deny: ["unknown"] },
      { adapter: "floka" }, { owner: true }, { provenance: { status: "verified" } }, { paths: ["../other"] }]) {
      f.project.projectDecl = restriction;
      const r = load(f); expect(codes(r)).toContain("INVALID_RESTRICTION"); expect(r.capabilities.every((c) => !c.available)).toBe(true);
    }
  }, 30_000);
  test("a narrower local path boundary is a valid restriction and disables capabilities without removing gates", () => {
    const f = fixture(); f.publish(); f.project.projectDecl = { paths: ["tests"] };
    const r = load(f); expect(r.restrictions).toEqual({ paths: ["tests"] });
    expect(codes(r)).toContain("LOCAL_PATH_RESTRICTION"); expect(codes(r)).not.toContain("INVALID_RESTRICTION");
    expect(r.capabilities.every((c) => !c.available)).toBe(true); expect(r.declaration?.ci.requiredChecks).toEqual(["test"]);
  }, 30_000);
  test("local restrictions are not an independent declaration source", () => {
    const f = fixture(); f.project.projectDecl = { disabled: false };
    expect(codes(load(f, { targetBranch: f.branch }))).toContain("UNDECLARED");
  }, 30_000);
  test("observe produces an injected comparison sample, never command parameters or new availability", () => {
    const f = fixture(); f.publish(); const samples: unknown[] = [];
    const r = load(f, { mode: "observe", observe: (a) => samples.push(a) });
    expect(r.valid).toBe(true); expect(r.capabilities.every((c) => !c.available && c.wouldBeAvailable)).toBe(true);
    expect(codes(r)).toContain("OBSERVE_ONLY"); expect(samples).toHaveLength(1);
    expect(JSON.stringify(samples)).not.toContain("pytest"); expect(JSON.stringify(samples)).not.toContain("argv");
  }, 30_000);
  test("off stops only this loader; invalid and undeclared never become valid in observe", () => {
    const f = fixture(); f.publish();
    const r = load(f, { mode: "off" }); expect(codes(r)).toEqual(["RECOVERY_OFF"]); expect(r.capabilities).toEqual([]);
    put(f.repo, ".floka/project.json", "bad"); commit(f.repo); git(f.repo, "update-ref", `refs/remotes/origin/${f.branch}`, "HEAD");
    expect(load(f, { mode: "observe" }).valid).toBe(false);
  }, 30_000);
  test("unrecognized schema versions and authority fields never validate", () => {
    const f = fixture();
    for (const raw of [{ ...f.declaration, version: 2 }, { ...f.declaration, authorization: true },
      { ...f.declaration, deploy: { ...f.declaration.deploy, ownerApproved: true } }]) {
      expect(parseProjectDeclaration(raw).declaration).toBeNull();
    }
  }, 30_000);
  test("loader has no import into existing callers", () => {
    const source = readFileSync(join(import.meta.dir, "../src/lib/projects.ts"), "utf8");
    expect(source.includes('from "./project-decl.js"')).toBe(false);
  }, 30_000);
});
