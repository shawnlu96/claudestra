import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCenterDeployJob } from "../src/lib/center-deploy-worker.js";
import { scriptDigest } from "../src/lib/center-deploy-proof.js";
import { CENTER_TARGET_MISSING, centerDeployTarget, centerTargetFile } from "../src/lib/center-deploy-target.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const SECRET = "center-host-secret.example.invalid";
const uid = process.getuid!();
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "center-target-")); roots.push(dir);
  const script = "#!/bin/sh\n", path = join(dir, "request.json"), sha = "a".repeat(40), target = join(dir, "target.env");
  writeFileSync(target, `FLOKA_CENTER_HOST=${SECRET}\n`); chmodSync(target, 0o600);
  writeFileSync(join(dir, "deploy.sh"), script); chmodSync(join(dir, "deploy.sh"), 0o700);
  writeJsonAtomicSync(path, { kind: "center", intentId: "i", taskId: "T9", mergeSha: sha, prRef: "center-deploy",
    label: `com.claudestra.scheduler.deploy.${"b".repeat(32)}`, repoDir: dir, relayArgv: null, restartLabels: ["center"],
    timeoutMs: 600_000, createdAt: Date.now(), env: { KEEP: "1" }, center: { askId: "a", config: { repo: "a/b", script: "deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 10 },
      proof: { project: "p", repo: "a/b", sha, scriptDigest: scriptDigest(script), cards: ["T9"] } } });
  const gitCalls: string[][] = [];
  const git: typeof runBounded = async (a) => {
    gitCalls.push(a);
    if (a.includes("add")) { mkdirSync(join(dir, "checkout")); writeFileSync(join(dir, "checkout", "deploy.sh"), readFileSync(join(dir, "deploy.sh"))); }
    return { code: 0, timedOut: false, stderr: "", stdout: a.includes("rev-parse") ? sha : a.includes("ls-tree") ? "100755 blob b\tdeploy.sh" : a.includes("show") ? script : "" };
  };
  return { dir, path, target, git, gitCalls, raw: () => readFileSync(join(dir, "result.json"), "utf8") };
}

describe("center deployment target file", () => {
  test("lives under the state directory, not the real one in tests", () => {
    expect(centerTargetFile()).toBe(join(STATE_DIR, "center-deploy-target.env"));
  });
  test("[验收线 2] only an owner-only regular file of this user is accepted", () => {
    const f = setup();
    expect(centerDeployTarget(f.target, uid)).toBe(f.target);
    expect(centerDeployTarget(join(f.dir, "missing.env"), uid)).toBeNull();
    expect(centerDeployTarget(f.target, uid + 1)).toBeNull();
    chmodSync(f.target, 0o644); expect(centerDeployTarget(f.target, uid)).toBeNull();
    chmodSync(f.target, 0o400); expect(centerDeployTarget(f.target, uid)).toBeNull();
  });

  test("[验收线 2][验收线 3] a valid target passes only its absolute path into both script phases", async () => {
    const f = setup(), envs: Record<string, string | undefined>[] = [];
    await runCenterDeployJob(f.path, { run: f.git, centerAuthorized: () => true, machine: { path: join(f.dir, "machine.lock") },
      centerTarget: () => centerDeployTarget(f.target, uid),
      centerRun: async (_a, o) => { envs.push(o.env!); return { code: 0, timedOut: false, stdout: "", stderr: "" }; } });
    expect(envs).toHaveLength(2);
    for (const e of envs) { expect(e.FLOKA_CENTER_DEPLOY_TARGET).toBe(f.target); expect(e.KEEP).toBe("1"); }
    expect(JSON.parse(f.raw()).status).toBe("success");
    expect(f.raw()).not.toContain(SECRET); expect(f.raw()).not.toContain(f.target);
  });

  for (const bad of ["missing", "0644", "other-owner"] as const) test(`[验收线 2][验收线 3] ${bad} target ends before the dry run without calling the script`, async () => {
    const f = setup(); let scripts = 0;
    if (bad === "missing") rmSync(f.target);
    if (bad === "0644") chmodSync(f.target, 0o644);
    const logs: unknown[] = [], orig = console.error; console.error = (...a: unknown[]) => { logs.push(a); };
    try {
      await runCenterDeployJob(f.path, { run: f.git, centerAuthorized: () => true, machine: { path: join(f.dir, "machine.lock") },
        centerTarget: () => centerDeployTarget(f.target, bad === "other-owner" ? uid + 1 : uid),
        centerRun: async () => { scripts++; return { code: 0, timedOut: false, stdout: "", stderr: "" }; } });
    } finally { console.error = orig; }
    expect(scripts).toBe(0);
    expect(JSON.parse(f.raw())).toMatchObject({ status: "failed", reason: CENTER_TARGET_MISSING });
    expect(f.gitCalls.some((a) => a.includes("worktree"))).toBe(false);
    expect(f.raw()).not.toContain(SECRET); expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  for (const when of ["checkout-chmod", "checkout-delete", "after-dry-chmod"] as const) test(`[验收线 2] target invalidated (${when}) is re-checked before the next script start`, async () => {
    const f = setup(); let scripts = 0;
    const spoil = () => { if (when.endsWith("delete")) rmSync(f.target); else chmodSync(f.target, 0o644); };
    const git: typeof runBounded = async (a, o) => { const out = await f.git(a, o); if (when.startsWith("checkout") && a.includes("add")) spoil(); return out; };
    await runCenterDeployJob(f.path, { run: git, centerAuthorized: () => true, machine: { path: join(f.dir, "machine.lock") },
      centerTarget: () => centerDeployTarget(f.target, uid),
      centerRun: async () => { scripts++; if (when === "after-dry-chmod") spoil(); return { code: 0, timedOut: false, stdout: "", stderr: "" }; } });
    expect(scripts).toBe(when === "after-dry-chmod" ? 1 : 0);
    expect(JSON.parse(f.raw())).toMatchObject({ status: "failed", reason: CENTER_TARGET_MISSING, dryRun: when !== "after-dry-chmod" });
    expect(f.gitCalls.some((a) => a.includes("remove"))).toBe(true);
    expect(f.raw()).not.toContain(SECRET); expect(f.raw()).not.toContain(f.target);
  });
});
