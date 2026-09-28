/** src/lib/run-bounded.ts：超时整组杀、不等孙进程占着的管道；正常退出码与输出；命令不存在 */
import { describe, expect, test } from "bun:test";
import { runBounded } from "../src/lib/run-bounded.js";

describe("runBounded", () => {
  test("孙进程占着管道：超时一到就返回，进程组被杀干净", async () => {
    const marker = `rb-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    const r = await runBounded(["sh", "-c", `(sleep 30; echo ${marker}) & wait`], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    await Bun.sleep(200);
    const ps = Bun.spawnSync(["pgrep", "-f", marker]);
    expect(ps.stdout.toString().trim()).toBe("");
  });
  test("正常退出：退出码、stdout、stderr 原样", async () => {
    expect(await runBounded(["sh", "-c", "echo hi; echo e >&2; exit 3"], { timeoutMs: 5000 })).toEqual({ code: 3, stdout: "hi\n", stderr: "e\n", timedOut: false });
  });
  test("命令不存在：code null，原因进 stderr", async () => {
    const r = await runBounded(["definitely-not-a-cmd-xyz"], { timeoutMs: 1000 });
    expect(r).toMatchObject({ code: null, timedOut: false });
    expect(r.stderr).not.toBe("");
  });
});
