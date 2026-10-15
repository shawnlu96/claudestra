import { describe, expect, test } from "bun:test";
import { centerProof, scriptDigest } from "../src/lib/center-deploy-proof.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const cfg = { repo: "a/b", script: "deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 10 };
describe("[验收线 4] script authorization proof", () => {
  test("fetches main and binds the exact committed script", async () => {
    const calls: string[][] = [];
    const run: typeof runBounded = async (a) => { calls.push(a); return { code: 0, timedOut: false, stderr: "",
      stdout: a.includes("rev-parse") ? "a".repeat(40) : a.includes("ls-tree") ? "100755 blob b\tdeploy.sh" : a.includes("show") ? "#!/bin/sh\necho ok\n" : "" }; };
    expect(await centerProof("p", cfg, ["T2", "T1", "T2"], { run, repoDir: () => "/fake" })).toEqual({ project: "p", repo: "a/b",
      sha: "a".repeat(40), scriptDigest: scriptDigest("#!/bin/sh\necho ok\n"), cards: ["T1", "T2"] });
    expect(calls[0]).toContain("fetch");
  });
  test("refuses symlink blobs and never includes git stderr", async () => {
    const run: typeof runBounded = async (a) => ({ code: 0, timedOut: false, stderr: "private-host-secret",
      stdout: a.includes("rev-parse") ? "a".repeat(40) : "120000 blob b\tdeploy.sh" });
    await expect(centerProof("p", cfg, [], { run, repoDir: () => "/fake" })).rejects.toThrow("不是普通仓内文件");
  });
});
