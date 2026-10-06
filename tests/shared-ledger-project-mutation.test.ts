import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { testChildEnv } from "./test-env.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
