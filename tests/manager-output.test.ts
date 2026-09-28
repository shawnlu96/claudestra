/**
 * outputSync：stdout 是非阻塞管道（O_NONBLOCK）时，console.log（即 output()）只写出前 8KB，其余悄悄丢掉，进程照常 0 退出；
 * outputSync 撞上 EAGAIN 会等读方取走再写，保证写完。bun 1.3.14 在 macOS 和 Linux 上实测一致。阻塞管道上两种写法都完整，
 * 所以这里必须造非阻塞管道：建一个 FIFO，读写两端都以 O_NONBLOCK 打开，写端交给子进程当 stdout，读方晚 300ms 才开始读。
 * 第二条是对照，证明这个环境真能区分两种写法；它哪天变红，说明 Bun 修好了 console.log，outputSync 就可以退回 output()。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "manager-output-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const core = resolve(import.meta.dir, "../src/manager/core.ts");

async function runWithNonBlockingStdout(argv: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}) {
  const fifo = join(dir, `fifo-${Math.random().toString(36).slice(2)}`);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const rfd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const wfd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  const proc = Bun.spawn(argv, { stdout: wfd, stderr: "pipe", env: opts.env, cwd: opts.cwd });
  closeSync(wfd); // 子进程已经拿到自己的一份；父进程不关，读方永远等不到 EOF
  await Bun.sleep(300);
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  const deadline = Date.now() + 20_000;
  for (;;) {
    let n: number;
    try {
      n = readSync(rfd, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() > deadline) throw e;
      await Bun.sleep(5);
      continue;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  closeSync(rfd);
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { text: Buffer.concat(chunks).toString(), code, err };
}

const emit = (fn: "output" | "outputSync") =>
  runWithNonBlockingStdout(["bun", "-e", `import { ${fn} } from ${JSON.stringify(core)}; ${fn}({ x: "a".repeat(300000) });`]);

describe("outputSync：非阻塞 stdout 上写完才返回", () => {
  test("300KB、读方晚 300ms：outputSync 完整且可解析", async () => {
    const r = await emit("outputSync");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text).x.length).toBe(300000);
  });
  test("对照：同样条件下 output()（console.log）被截断，退出码却是 0", async () => {
    const r = await emit("output");
    expect(r.code).toBe(0);
    expect(r.text.length).toBeLessThan(300000);
  });
});

describe("manager sessions 走同步写：输出完整，且每个主会话只带最新 50 个子线程", () => {
  test("假 HOME 里 1 个 Codex 主会话 + 60 个子线程：51 行、moreSubs=10、JSON 完整", async () => {
    const home = join(dir, "home");
    const day = join(home, ".codex", "sessions", "2026", "09", "28");
    mkdirSync(day, { recursive: true });
    const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const cwd = `/p/${"x".repeat(200)}`; // 行够大：51 行约 40KB，远超 console.log 在非阻塞管道上写得出的 8KB
    const write = (n: number, payload: object) =>
      writeFileSync(join(day, `rollout-2026-09-28T00-00-00-${id(n)}.jsonl`), JSON.stringify({ type: "session_meta", payload: { cwd, ...payload } }) + "\n");
    write(0, { id: id(0), session_id: id(0), thread_source: "user" });
    for (let i = 1; i <= 60; i++) write(i, { id: id(i), session_id: id(0), parent_thread_id: id(0), thread_source: "subagent" });
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const env: Record<string, string | undefined> = {
      ...process.env, HOME: home, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9",
    };
    delete env.DISCORD_CHANNEL_ID;
    const r = await runWithNonBlockingStdout([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), "sessions"], { env, cwd: dir });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.text);
    expect(out.total).toBe(61);
    expect(out.showing).toBe(51);
    expect(out.sessions.find((s: { sessionId: string }) => s.sessionId === id(0)).moreSubs).toBe(10);
    expect(out.sessions.filter((s: { sub?: unknown }) => s.sub).length).toBe(50);
  }, 30_000);
});
