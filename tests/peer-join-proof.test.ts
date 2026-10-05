/** 原入口保留完整断言，但共享状态、console spy 与邀请方 mode 只能存在于私有子进程。 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.ts";
import { testChildEnv } from "./test-env.ts";

const role = process.env.CLAUDESTRA_JOIN_PROOF_ROLE;
type Receipt = { state: string; fp: string; redeemer: string };

// isolatedStateSuite inherits the caller's environment; this fixture needs explicit private HOME/runtime/tmp as well.
async function runProof(role: "suite" | "observer"): Promise<Receipt> {
  const root = mkdtempSync(join(tmpdir(), "join-proof-run-"));
  const dirs = Object.fromEntries(["home", "state", "runtime", "tmp"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: dirs.home, CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime,
      TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, CLAUDESTRA_JOIN_PROOF_ROLE: role }),
  });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, out + err).toBe(0);
    expect(err).toMatch(/\b0 fail\b/);
    expect(err).toContain(role === "suite" ? "13 pass" : "1 pass");
    const reports = out.split("\n").filter((line) => line.startsWith("JOIN_PROOF_RESULT "));
    expect(reports).toHaveLength(1);
    const receipt: Receipt = JSON.parse(reports[0]!.slice("JOIN_PROOF_RESULT ".length));
    expect(receipt.state).toBe(dirs.state);
    return receipt;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

if (role === "suite") {
  await import("./peer-join-proof-fixture.ts");
} else if (role === "observer") {
  test("并行两组完整证明：私有状态与钥匙独立，同进程邻居状态和 console spy 保留", async () => {
    const files = ["principals.json", "peers.json", "peer-keys.json"];
    const sentinel = JSON.stringify({ principals: [], httpPeers: [], pendingInvites: [], sentinel: "unrelated-fixture" });
    for (const file of files) writeFileSync(join(STATE_DIR, file), sentinel);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // allSettled ensures a failing run cannot leave its sibling alive while the observer's root is removed.
      const results = await Promise.allSettled([runProof("suite"), runProof("suite")]);
      const receipts = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(receipts[0]!.state).not.toBe(receipts[1]!.state);
      expect(receipts[0]!.fp).not.toBe(receipts[1]!.fp);
      expect(receipts[0]!.redeemer).not.toBe(receipts[1]!.redeemer);
      for (const file of files) expect(readFileSync(join(STATE_DIR, file), "utf8")).toBe(sentinel);
      expect(console.log).toBe(log);
      console.log("neighbor still owns console");
      expect(log.mock.calls).toEqual([["neighbor still owns console"]]);
      process.stdout.write("JOIN_PROOF_RESULT " + JSON.stringify({ state: STATE_DIR }) + "\n");
    } finally {
      log.mockRestore();
    }
  });
} else {
  test("peer join proof 原入口：隔离污染检查及两组并行完整断言", async () => {
    await runProof("observer");
  });
}
