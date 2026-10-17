import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CENTER_SUBMODULE_FAILED, centerCheckout } from "../src/lib/center-deploy-checkout.js";
import { runBounded } from "../src/lib/run-bounded.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "center-checkout-")); roots.push(d); return d; };
// Fixture submodules live on local paths; real repositories use remote URLs and need no protocol override.
const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function git(cwd: string, ...a: string[]): string {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function repo(dir: string, file: string, body: string) {
  mkdirSync(dir, { recursive: true }); git(dir, "init", "-q");
  writeFileSync(join(dir, file), body); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
}
const run: typeof runBounded = (a, o) => runBounded(a, { ...o, env });

test("[验收线 1] checkout with .gitmodules initializes submodule files", async () => {
  const root = tmp(), sub = join(root, "sub"), main = join(root, "main"), job = join(root, "job");
  repo(sub, "closure.ts", "export const x = 1;\n");
  repo(main, "deploy.sh", "#!/bin/sh\n");
  git(main, "submodule", "add", "-q", sub, "vendor/closure"); git(main, "commit", "-qm", "sub");
  mkdirSync(job);
  const co = await centerCheckout(main, job, git(main, "rev-parse", "HEAD"), run);
  expect(readFileSync(join(co.dir, "vendor/closure/closure.ts"), "utf8")).toBe("export const x = 1;\n");
  await co.release();
  expect(existsSync(co.dir)).toBe(false);
});

test("[验收线 1] submodule update failure ends the checkout and removes the temporary worktree", async () => {
  const calls: string[][] = [];
  const job = tmp();
  const fake: typeof runBounded = async (a) => {
    calls.push(a);
    if (a.includes("add")) { mkdirSync(join(job, "checkout")); writeFileSync(join(job, "checkout", ".gitmodules"), "[submodule]\n"); }
    if (a.includes("remove")) rmSync(join(job, "checkout"), { recursive: true, force: true });
    return { code: a.includes("submodule") ? 128 : 0, timedOut: false, stdout: "", stderr: "secret" };
  };
  await expect(centerCheckout("/repo", job, "a".repeat(40), fake)).rejects.toThrow(CENTER_SUBMODULE_FAILED);
  expect(calls.map((a) => a.slice(3, 5))).toEqual([["worktree", "add"], ["submodule", "update"], ["worktree", "remove"]]);
  expect(existsSync(join(job, "checkout"))).toBe(false);
});

test("[验收线 1] a timed-out submodule update is also a failure", async () => {
  const job = tmp(), calls: string[][] = [];
  const fake: typeof runBounded = async (a, o) => {
    calls.push(a);
    if (a.includes("submodule")) expect(o.timeoutMs).toBeGreaterThan(0);
    if (a.includes("add")) { mkdirSync(join(job, "checkout")); writeFileSync(join(job, "checkout", ".gitmodules"), ""); }
    return { code: 0, timedOut: a.includes("submodule"), stdout: "", stderr: "" };
  };
  await expect(centerCheckout("/repo", job, "a".repeat(40), fake)).rejects.toThrow(CENTER_SUBMODULE_FAILED);
  expect(calls.at(-1)).toContain("remove");
});

test("[验收线 1] without .gitmodules the call sequence is unchanged", async () => {
  const job = tmp(), calls: [string[], number][] = [];
  const fake: typeof runBounded = async (a, o) => {
    calls.push([a, o.timeoutMs]);
    if (a.includes("add")) mkdirSync(join(job, "checkout"));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  const sha = "a".repeat(40), dir = join(job, "checkout");
  const co = await centerCheckout("/repo", job, sha, fake);
  await co.release();
  expect(calls).toEqual([[["git", "-C", "/repo", "worktree", "add", "--detach", dir, sha], 60_000],
    [["git", "-C", "/repo", "worktree", "remove", "--force", dir], 60_000]]);
});
