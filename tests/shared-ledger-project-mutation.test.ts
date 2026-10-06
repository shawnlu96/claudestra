import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("real project edit/merge/remove reject bound mutations before any related file changes; unbinding restores operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-project-mutation-")); roots.push(dir);
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
    import { join } from "node:path";
    import { writeProjects, readProjects } from "./src/lib/projects.ts";
    import { runProjectCommand } from "./src/manager/projects.ts";
    import { setSharedLedgerBinding } from "./src/lib/shared-ledger-gate-bindings.ts";
    const dir = process.env.CLAUDESTRA_STATE_DIR;
    const files = ["projects.json", "registry.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"];
    for (const id of ["a", "b"]) mkdirSync(join(dir, id));
    symlinkSync("/", join(dir, "root-alias"));
    const project = id => ({ id, name: id, dirs: [join(dir, id)], createdAt: "" });
    const reset = async (bound, personal) => {
      await writeProjects({ projects: [project("a"), { ...project("b"), ...(personal ? { personal: true } : {}) }] });
      writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: {} }));
      writeFileSync(join(dir, "shared-ledger-bindings.json"), "[]", { mode: 0o600 });
      writeFileSync(join(dir, "shared-ledger-credentials.json"), "fixture credential bytes", { mode: 0o600 });
      await setSharedLedgerBinding({ centerId: "center", teamId: "team", projectId: "shared", localProjectId: bound });
    };
    const cases = [
      ["a", false, "project-edit", ["a", "--personal", "on"]],
      ["a", false, "project-edit", ["a", "--dirs", "/"]],
      ["a", false, "project-edit", ["a", "--dirs", join(dir, "root-alias")]],
      ["a", false, "project-edit", ["a", "--dirs", join(dir, "does-not-exist")]],
      ["a", false, "project-merge", ["a", "b"]],
      ["b", false, "project-merge", ["a", "b"]],
      ["a", true, "project-merge", ["b", "a"]],
      ["a", false, "project-remove", ["a"]],
    ];
    const outputs = [], originalLog = console.log;
    console.log = text => outputs.push(JSON.parse(text));
    for (const [bound, personal, cmd, args] of cases) {
      await reset(bound, personal);
      const before = files.map(f => readFileSync(join(dir, f)));
      await runProjectCommand(cmd, args);
      assert.equal(outputs.at(-1).ok, false);
      for (const [i, f] of files.entries()) assert.deepEqual(readFileSync(join(dir, f)), before[i], f);
    }
    await reset("a", false);
    await runProjectCommand("project-edit", ["a", "--desc", "allowed metadata"]);
    assert.equal(outputs.at(-1).ok, true);
    for (const [cmd, args] of [["project-edit", ["a", "--personal", "on"]],
      ["project-edit", ["a", "--dirs", "/"]], ["project-merge", ["a", "b"]], ["project-remove", ["a"]]]) {
      await reset("a", false);
      writeFileSync(join(dir, "shared-ledger-bindings.json"), "[]", { mode: 0o600 });
      await runProjectCommand(cmd, args);
      assert.equal(outputs.at(-1).ok, true, outputs.at(-1).error);
    }
    assert.equal((await readProjects()).projects.some(p => p.id === "a"), false);
    console.log = originalLog;
    console.log("project-mutations-passed");
  `;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: process.cwd(),
    env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime") }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("project-mutations-passed");
});

function world(bound: "source" | "target", personal = false) {
  const dir = mkdtempSync(join(tmpdir(), "sl-mutation-")); roots.push(dir);
  const projects = ["source", "target"].map(id => {
    const path = join(dir, id); mkdirSync(path);
    return { id, name: id, dirs: [path], ...(id === "source" && personal ? { personal: true } : {}) };
  });
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects }));
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: { worker: { projectId: "source", status: "idle" } } }));
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([
    { centerId: "center", teamId: "team", projectId: "shared", localProjectId: bound }]), { mode: 0o600 });
  return dir;
}
const snapshot = (dir: string) => ["projects.json", "registry.json", "shared-ledger-bindings.json"].map(n => readFileSync(join(dir, n), "utf8"));
async function command(dir: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e",
    'const { runProjectCommand } = await import("./src/manager/projects.ts"); await runProjectCommand(process.argv[1], process.argv.slice(2));', ...args], {
    cwd: process.cwd(), env: testChildEnv({ HOME: dir, TMPDIR: dir, CLAUDESTRA_STATE_DIR: dir,
      CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime"), BRIDGE_URL: "ws://127.0.0.1:9" }), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text(), error = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  if (error) throw new Error(error);
  return JSON.parse(output);
}

test("bound edit to personal or umbrella and bound remove are rejected before any file write", async () => {
  const dir = world("target"), before = snapshot(dir);
  for (const args of [["project-edit", "target", "--personal", "on"], ["project-edit", "target", "--dirs", "/"], ["project-remove", "target"]]) {
    expect((await command(dir, args)).ok).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  }
  writeFileSync(join(dir, "shared-ledger-bindings.json"), "[]");
  expect((await command(dir, ["project-edit", "target", "--personal", "on"])).ok).toBe(true);
  expect((await command(dir, ["project-remove", "target"])).ok).toBe(true);
});

test("merge refuses either bound endpoint and personal inheritance before moving agents", async () => {
  for (const [bound, personal] of [["source", false], ["target", false], ["target", true]] as const) {
    const dir = world(bound, personal), before = snapshot(dir);
    expect((await command(dir, ["project-merge", "source", "target"])).ok).toBe(false);
    expect(snapshot(dir)).toEqual(before);
    writeFileSync(join(dir, "shared-ledger-bindings.json"), "[]");
    expect((await command(dir, ["project-merge", "source", "target"])).ok).toBe(true);
    const projects = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")).projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].personal === true).toBe(personal);
  }
});
