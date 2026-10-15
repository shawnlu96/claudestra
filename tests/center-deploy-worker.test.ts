import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDeployJob } from "../src/lib/scheduler-deploy-worker.js";
import { scriptDigest } from "../src/lib/center-deploy-proof.js";
import { centerScriptRunner } from "../src/lib/center-deploy-run.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import type { CenterResult } from "../src/lib/center-deploy-worker.js";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "center-worker-")); roots.push(dir);
  const script = "#!/bin/sh\necho secret-private-address\n", path = join(dir, "request.json"), sha = "a".repeat(40);
  writeFileSync(join(dir, "deploy.sh"), script); chmodSync(join(dir, "deploy.sh"), 0o700);
  writeJsonAtomicSync(path, { kind: "center", intentId: "i", taskId: "T9", mergeSha: sha, prRef: "center-deploy",
    label: `com.claudestra.scheduler.deploy.${"b".repeat(32)}`, repoDir: dir, relayArgv: null, restartLabels: ["center"],
    timeoutMs: 600_000, createdAt: Date.now(), env: {}, center: { askId: "a", config: { repo: "a/b", script: "deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 10 },
      proof: { project: "p", repo: "a/b", sha, scriptDigest: scriptDigest(script), cards: ["T9"] } } });
  const git: typeof runBounded = async (a) => {
    if (a.includes("add")) { mkdirSync(join(dir, "checkout")); writeFileSync(join(dir, "checkout", "deploy.sh"), readFileSync(join(dir, "deploy.sh"))); }
    return ({ code: 0, timedOut: false, stderr: "secret-git-output",
    stdout: a.includes("rev-parse") ? sha : a.includes("ls-tree") ? "100755 blob b\tdeploy.sh" : a.includes("show") ? script : "" }); };
  return { dir, path, sha, git, result: () => JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as CenterResult };
}
describe("authorized center worker", () => {
  for (const failure of ["none", "dry", "formal", "timeout"] as const) test(`[验收线 5] dry-run precedes deploy (${failure}) and private output stays local`, async () => {
    const f = setup(), calls: string[][] = [];
    const run: typeof runBounded = async (a, o) => { calls.push(a); expect(o.timeoutMs).toBe(a.includes("--dry-run") ? 300_000 : 600_000);
      const fail = failure === "dry" || failure === "timeout" || failure === "formal" && !a.includes("--dry-run");
      return { code: fail ? 7 : 0, timedOut: failure === "timeout", stdout: "secret-private-output", stderr: "secret-private-error" }; };
    await runDeployJob(f.path, { run: f.git, centerRun: run, centerAuthorized: () => true, machine: { path: join(f.dir, "machine.lock") } });
    expect(calls).toHaveLength(["dry", "timeout"].includes(failure) ? 1 : 2); expect(calls[0]).toContain("--dry-run");
    expect(f.result().status).toBe(failure === "none" ? "success" : "failed");
    const raw = readFileSync(join(f.dir, "result.json"), "utf8"); expect(raw).not.toContain("secret"); expect(raw).not.toContain(f.dir);
  });
  test("[验收线 5] revoked authorization and changed script hash both execute nothing", async () => {
    for (const revoked of [true, false]) {
      const f = setup(); let executed = false;
      if (!revoked) writeFileSync(join(f.dir, "deploy.sh"), "changed");
      await runDeployJob(f.path, { run: f.git, centerAuthorized: () => !revoked,
        centerRun: async () => { executed = true; throw new Error("must not run"); } });
      expect(executed).toBe(false); expect(f.result().status).not.toBe("success");
    }
  });
  test("[验收线 6] complete script output is streamed to a 0600 local file", async () => {
    const f = setup(), log = join(f.dir, "script.log"), run = centerScriptRunner(log);
    const r = await run([process.execPath, "-e", "process.stdout.write('x'.repeat(1100000));process.stderr.write('secret')"], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(statSync(log).mode & 0o777).toBe(0o600); expect(statSync(log).size).toBe(1_100_006);
  });
});

test("[验收线 5] main moving during dry-run prevents the formal command after acquiring the lock", async () => {
  const f = setup(); let moved = false, scripts = 0;
  const git: typeof runBounded = async (a, opts) => moved && a.includes("rev-parse") && a.includes("refs/remotes/origin/main")
    ? { code: 0, timedOut: false, stdout: "c".repeat(40), stderr: "" } : f.git(a, opts);
  await runDeployJob(f.path, { run: git, centerAuthorized: () => true, machine: { path: join(f.dir, "machine.lock") },
    centerRun: async () => { scripts++; moved = true; return { code: 0, timedOut: false, stdout: "", stderr: "" }; } });
  expect(scripts).toBe(1); expect(f.result().status).toBe("stale");
});
