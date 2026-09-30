import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SRC_DIR } from "../src/lib/repo-root.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { testChildEnv } from "./test-env.js";

test("second scheduler fails closed while the first owns its singleton lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-singleton-"));
  const env = testChildEnv({ CLAUDESTRA_STATE_DIR: root });
  const argv = [process.execPath, "--no-env-file", join(SRC_DIR, "scheduler.ts")];
  const first = Bun.spawn(argv, { env, cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    // A cold bun start plus the scheduler import graph exceeds 2s while the full suite saturates the CPU.
    for (let n = 0; n < 400 && !existsSync(join(root, "scheduler.pid", "owner")); n++) await Bun.sleep(20);
    expect(existsSync(join(root, "scheduler.pid", "owner"))).toBe(true);
    const second = await runBounded(argv, { env, cwd: root, timeoutMs: 8000 });
    expect(second.timedOut).toBe(false);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("another scheduler holds scheduler.pid");
  } finally {
    first.kill("SIGTERM");
    const stopped = await Promise.race([first.exited, Bun.sleep(7000).then(() => "timeout")]);
    if (stopped === "timeout") { first.kill("SIGKILL"); await first.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
