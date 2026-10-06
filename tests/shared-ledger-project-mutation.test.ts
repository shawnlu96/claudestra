import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    const files = ["projects.json", "agents.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"];
    for (const id of ["a", "b"]) mkdirSync(join(dir, id));
    symlinkSync("/", join(dir, "root-alias"));
    const project = id => ({ id, name: id, dirs: [join(dir, id)], createdAt: "" });
    const reset = async (bound, personal) => {
      await writeProjects({ projects: [project("a"), { ...project("b"), ...(personal ? { personal: true } : {}) }] });
      writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: {} }));
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
