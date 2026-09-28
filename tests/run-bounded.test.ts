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
  test("子进程已退出、后台孙进程还占着管道：不算超时，退出码照实返回，孙进程被收掉", async () => {
    const marker = `rb-exit-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    const r = await runBounded(["sh", "-c", `echo done; (sleep 30; echo ${marker}) & exit 0`], { timeoutMs: 5000 });
    expect(r).toMatchObject({ code: 0, stdout: "done\n", timedOut: false });
    expect(Date.now() - t0).toBeLessThan(2000);
    await Bun.sleep(200);
    expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).toBe("");
  });
  test("调用方收到 SIGTERM：它起的进程组一起被杀", async () => {
    const marker = `rb-term-${process.pid}-${Date.now()}`;
    const mod = new URL("../src/lib/run-bounded.ts", import.meta.url).pathname;
    const script = `import { runBounded } from ${JSON.stringify(mod)}; console.log("go"); await runBounded(["sh", "-c", "sleep 30 # ${marker}"], { timeoutMs: 60000 });`;
    const parent = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    const reader = parent.stdout.getReader();
    await reader.read(); // 等它起好子进程
    await Bun.sleep(300);
    expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).not.toBe("");
    parent.kill("SIGTERM");
    await parent.exited;
    await Bun.sleep(200);
    expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).toBe("");
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
