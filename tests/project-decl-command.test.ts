import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, truncateSync, statSync } from "node:fs";
import { join } from "node:path";
import { cmdProjectDecl } from "../src/manager/project-decl.js";
import { loadProjectDeclaration } from "../src/lib/project-decl.js";
import { builtinProjectDeclaration } from "../src/lib/project-decl-builtin.js";
import { resolveDeclRepository } from "../src/lib/project-decl-git.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { commit, fixture, flokaFixture, git, put } from "./project-decl-fixtures.test.js";

function command(f: ReturnType<typeof fixture>, action: string) {
  const projectsPath = join(f.repo, "projects.json");
  put(f.repo, "projects.json", JSON.stringify({ projects: [f.project] }));
  let output: any, code = -1;
  cmdProjectDecl([f.project.id, action], { projectsPath, output: (v) => { output = v; }, exitCode: (v) => { code = v; } });
  return { output, code };
}
describe("read-only command surface", () => {
  test("show/validate/explain read the same immutable target, redact argv, and have no repository writes", () => {
    const f = fixture(); f.publish();
    const status = git(f.repo, "status", "--porcelain");
    const head = git(f.repo, "rev-parse", "HEAD"), index = readFileSync(join(f.repo, ".git/index"));
    for (const action of ["show", "validate", "explain"]) {
      const { output, code } = command(f, action);
      expect(code).toBe(0); expect(output.action).toBe(action); expect(output.source).toBe("target");
      expect(output.mode).toBe("observe"); expect(output.capabilities.every((c: any) => !c.available)).toBe(true);
      expect(JSON.stringify(output)).not.toContain("pytest"); expect(output.capabilities[0].command.argv).toEqual({ argumentCount: 3 });
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head); expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      expect(git(f.repo, "status", "--porcelain")).toBe([status, "?? projects.json"].filter(Boolean).join("\n"));
    }
  }, 30_000);
  test("validate does not call an inferred or unknown declaration valid", () => {
    const f = fixture(); f.declaration.validation.author[0].provenance = { status: "inferred" }; f.publish();
    expect(command(f, "validate").code).toBe(2);
    f.declaration.version = 2 as 1; f.publish(); expect(command(f, "validate").code).toBe(2);
  }, 30_000);
  test("corrupt projects JSON cannot reuse a previous set of restrictions", () => {
    const f = fixture(); f.publish(); const path = join(f.repo, "projects.json"); command(f, "show");
    put(f.repo, "projects.json", "{"); let output: any, code = 0;
    cmdProjectDecl([f.project.id, "show"], { projectsPath: path, output: (v) => { output = v; }, exitCode: (v) => { code = v; } });
    expect(code).toBe(2); expect(output.diagnostics[0].reasonCode).toBe("INVALID_PROJECT_CONFIG");
  }, 30_000);
  test("ambiguous multi-repository projects require explicit selection", () => {
    const f = fixture(); f.publish(); f.project.dirs.push(fixture("go").repo);
    expect(command(f, "show").output.diagnostics[0].reasonCode).toBe("REPOSITORY_SELECTION_REQUIRED");
  }, 30_000);
  test("real manager dispatch remains read-only for all three commands", () => {
    const f = fixture(); f.publish(); const state = join(f.repo, "state");
    put(f.repo, "state/projects.json", JSON.stringify({ projects: [f.project] }));
    for (const action of ["show", "validate", "explain"]) {
      if (action === "validate") { put(f.repo, "state/logs/cron.out", "fixture"); truncateSync(join(state, "logs/cron.out"), 33 * 1024 * 1024); }
      const r = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "project-decl", f.project.id, action],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "runtime"),
          FLOKA_STATE_DIR: state, FLOKA_RUNTIME_DIR: join(state, "runtime") } });
      const stdout = r.stdout.toString(), result = JSON.parse(stdout);
      expect(r.exitCode).toBe(0); expect(result.source).toBe("target");
      expect(stdout).toBe(JSON.stringify(result, null, 2) + "\n");
      expect(readdirSync(state).sort()).toEqual(action === "show" ? ["projects.json"] : ["logs", "projects.json"]);
      if (action !== "show") {
        expect(readdirSync(join(state, "logs"))).toEqual(["cron.out"]);
        expect(statSync(join(state, "logs/cron.out")).size).toBe(33 * 1024 * 1024);
      }
    }
  }, 30_000);
  test("schema-class recovery defaults to observe", () => { expect(defaultRecoveryMode("projectDecl")).toBe("observe"); });
});

describe("Floka compatibility evidence", () => {
  const base = "21719e92853414b98ba8863691d341967b54116e";
  const root = join(import.meta.dir, "..");
  test("built-in declaration has the existing literal commands, never applies to a fixture spoofing origin", () => {
    const pinned = flokaFixture(root, base);
    expect(git(pinned.repo, "branch", "--show-current")).toBe("");
    const repo = resolveDeclRepository(pinned.project, pinned.repo, "main");
    const d = builtinProjectDeclaration(repo)!;
    expect(d.validation.author[0].argv).toEqual(["bun", "run", "check"]);
    expect(d.validation.review.map((c) => c.argv)).toEqual([["bun", "run", "typecheck"], ["bun", "run", "guard"]]);
    expect(d.validation.build.map((c) => c.argv)).toEqual(["bridge", "channel-server", "manager", "launcher", "cron", "setup", "relay", "scheduler"]
      .map((entry) => ["bun", "build", `src/${entry}.ts`, "--target=bun", "--outdir=/tmp/ci-build"]));
    expect(d.tests.rules[0].argv).toEqual(["bun", "run", "test"]);
    expect(d.ci.requiredChecks).toEqual(["typecheck + test + guard"]);
    const loaded = loadProjectDeclaration({ project: pinned.project, repoDir: pinned.repo, targetBranch: "main", mode: "on" });
    expect(loaded.source).toBe("builtin"); expect(loaded.valid).toBe(true);
    expect(loaded.capabilities.every((c) => c.available)).toBe(true);
    const f = fixture(); git(f.repo, "remote", "set-url", "origin", "https://github.com/shawnlu96/claudestra.git");
    expect(builtinProjectDeclaration({ ...repo, root: f.repo, targetHead: f.basisHead })).toBeNull();
  }, 30_000);
  test("merged CI basis changes degrade the built-in until explicit reconfirmation", () => {
    const pinned = flokaFixture(root, base);
    put(pinned.repo, ".github/workflows/ci.yml", git(pinned.repo, "show", `${base}:.github/workflows/ci.yml`) + "\n# merged CI maintenance\n");
    const head = commit(pinned.repo); git(pinned.repo, "update-ref", "refs/remotes/origin/main", head);
    const loaded = loadProjectDeclaration({ project: pinned.project, repoDir: pinned.repo, targetBranch: "main", mode: "on" });
    expect(loaded.source).toBe("builtin"); expect(loaded.targetHead).toBe(head); expect(loaded.valid).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ reasonCode: "BASIS_CHANGED", field: "basis..github/workflows/ci.yml" }));
    expect(loaded.capabilities.every((c) => !c.available)).toBe(true);
  }, 30_000);
  test("legacy project outputs, standard messages and exit codes match the pinned baseline", () => {
    const pinned = flokaFixture(root, base), state = join(pinned.repo, "compat-state");
    put(pinned.repo, "compat-state/projects.json", JSON.stringify({ projects: [{ id: "fixture", name: "fixture", dirs: ["."], createdAt: "" }] }));
    put(pinned.repo, "compat-state/registry.json", JSON.stringify({ agents: {} }));
    for (const args of [["project-list"], ["project-edit"], ["project-remove"], ["project-assign"]]) {
      const outputs = [pinned.repo, root].map((repo) => {
        const r = Bun.spawnSync([process.execPath, "--no-env-file", join(repo, "src/manager.ts"), ...args],
          { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: state,
            CLAUDESTRA_RUNTIME_DIR: join(state, "runtime"), FLOKA_STATE_DIR: state, FLOKA_RUNTIME_DIR: join(state, "runtime") } });
        return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      });
      expect(outputs[0].code).toBe(0); expect(JSON.parse(outputs[0].stdout).ok).toBe(args[0] === "project-list");
      expect(outputs[1]).toEqual(outputs[0]);
    }
  }, 30_000);
});
