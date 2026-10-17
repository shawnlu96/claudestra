import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cmdProjectDeclScan } from "../src/manager/project-decl-scan.js";
import { builtinProjectDeclaration } from "../src/lib/project-decl-builtin.js";
import { resolveDeclRepository } from "../src/lib/project-decl-git.js";
import { loadProjectDeclaration } from "../src/lib/project-decl.js";
import { scanProjectDeclaration, type ProjectDeclScanOptions, type ProjectDeclScanResult } from "../src/lib/project-decl-scan.js";
import { darwinBoundary } from "../src/lib/project-decl-scan-run.js";
import { flokaFixture, git, put } from "./project-decl-fixtures.test.js";
import { scanFixture, stubRunner, tempDir } from "./project-decl-scan-fixtures.test.js";

/** The order's base head (origin/main when the card was cut): the "before" side of the compatibility evidence. */
const BASE = "2ba1f8b8ec756252eeafaf987c9ed48f202bf460";
const root = join(import.meta.dir, "..");

async function command(args: string[], projects: unknown, scan?: (o: ProjectDeclScanOptions) => Promise<ProjectDeclScanResult>) {
  const dir = tempDir("project-decl-scan-cli-"), projectsPath = join(dir, "projects.json");
  put(dir, "projects.json", JSON.stringify(projects));
  let output: any, code = -1;
  await cmdProjectDeclScan(args, { projectsPath, scan, output: (v) => { output = v; }, exitCode: (v) => { code = v; } });
  return { output, code };
}

describe("project-decl-scan command", () => {
  test("argument, project and selection errors are fixed reasons with exit 2", async () => {
    const f = scanFixture("go"), projects = { projects: [f.project] };
    expect((await command([], projects)).output.reasonCode).toBe("INVALID_ARGUMENTS");
    expect((await command([f.project.id, "--merge"], projects)).code).toBe(2);
    expect((await command(["missing"], projects)).output.reasonCode).toBe("INVALID_PROJECT_CONFIG");
    const two = { projects: [{ ...f.project, dirs: [f.repo, scanFixture("python").repo] }] };
    expect((await command([f.project.id], two)).output).toEqual({ ok: false, reasonCode: "REPOSITORY_SELECTION_REQUIRED" });
  }, 30_000);
  test("flags select the deterministic draft and a rescan; observed exits 0, refused exits 2", async () => {
    const f = scanFixture("go"); const seen: ProjectDeclScanOptions[] = [];
    const fake = async (o: ProjectDeclScanOptions): Promise<ProjectDeclScanResult> => {
      seen.push(o);
      return { status: o.ai ? "refused" : "observed", reasonCode: o.ai ? "READ_ISOLATION_UNAVAILABLE" : null, mode: "observe", targetHead: f.head };
    };
    expect((await command([f.project.id, "--without-ai", "--rescan"], { projects: [f.project] }, fake)).code).toBe(0);
    expect(seen[0]).toMatchObject({ ai: false, rescan: true, repoDir: f.repo });
    const refused = await command([f.project.id], { projects: [f.project] }, fake);
    expect(refused.code).toBe(2); expect(refused.output.ok).toBe(false);
  }, 30_000);
  test("real command output in observe carries no absolute path and no environment value", async () => {
    const f = scanFixture("python");
    const { output, code } = await command([f.project.id, "--without-ai"], { projects: [f.project] },
      (o) => scanProjectDeclaration({ ...o, mode: "observe", run: stubRunner().run, boundary: darwinBoundary("linux") }));
    expect(code).toBe(0); expect(output.status).toBe("observed");
    const text = JSON.stringify(output);
    expect(text).not.toContain(f.repo); expect(text).not.toContain(process.env.HOME ?? "/nonexistent-home");
    expect(text).not.toContain("fixturevalue0123456789abcdef");
  }, 30_000);
});

describe("Floka self regression with the built-in declaration", () => {
  test("a Floka draft keeps the built-in structure: its commands are the built-in's own literal argv", async () => {
    const head = git(root, "rev-parse", "HEAD");
    const pinned = flokaFixture(root, head);
    const repo = resolveDeclRepository(pinned.project, pinned.repo, "main");
    const builtin = builtinProjectDeclaration(repo)!;
    const r = await scanProjectDeclaration({ project: pinned.project, repoDir: pinned.repo, targetBranch: "main", mode: "observe", ai: false,
      run: stubRunner().run, boundary: darwinBoundary("linux") });
    expect(r.status).toBe("observed");
    // Root commands only: desktop/, native/ and web/ subprojects are discovered too, with their own cwd.
    const atRoot = <T extends { argv: string[] }>(list: (T & ({ cwd: string } | { dir: string }))[] = []) =>
      list.filter((c) => ("cwd" in c ? c.cwd : c.dir) === ".").map((c) => c.argv);
    expect(atRoot(r.draft?.validation.author)).toEqual(builtin.validation.author.map((c) => c.argv));
    expect(atRoot(r.draft?.tests.rules)).toEqual(builtin.tests.rules.map((c) => c.argv));
    for (const argv of atRoot(r.draft?.validation.review)) expect(builtin.validation.review.map((b) => b.argv)).toContainEqual(argv);
    expect(r.draft?.tests.rules.some((c) => c.dir === "desktop/src-tauri")).toBe(true);
    expect(r.draft?.ci.workflows).toContain(".github/workflows/ci.yml");
    const loaded = loadProjectDeclaration({ project: pinned.project, repoDir: pinned.repo, targetBranch: "main", mode: "on" });
    expect(loaded.source).toBe("builtin"); expect(loaded.declaration).toEqual(builtin);
  }, 60_000);
  test("before/after: existing manager commands are byte-identical to the base head; the new command is listed separately", () => {
    const pinned = flokaFixture(root, BASE), state = join(pinned.repo, "compat-state");
    put(pinned.repo, "compat-state/projects.json", JSON.stringify({ projects: [{ ...pinned.project, id: "self" }] }));
    put(pinned.repo, "compat-state/registry.json", JSON.stringify({ agents: {} }));
    const runManager = (repo: string, args: string[]) => {
      const r = Bun.spawnSync([process.execPath, "--no-env-file", join(repo, "src/manager.ts"), ...args], { cwd: repo, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "runtime"), FLOKA_STATE_DIR: state,
          FLOKA_RUNTIME_DIR: join(state, "runtime") } });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    for (const args of [["project-decl", "self", "show", pinned.repo, "main"], ["project-decl", "self", "validate"], ["project-decl"], ["project-list"]]) {
      const [before, after] = [pinned.repo, root].map((repo) => runManager(repo, args));
      expect(before.stdout.length).toBeGreaterThan(0); expect(after).toEqual(before);
    }
    const added = runManager(root, ["project-decl-scan"]);
    expect(added.code).toBe(2); expect(JSON.parse(added.stdout)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENTS" });
  }, 60_000);
});
