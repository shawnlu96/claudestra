/**
 * channel-server 不能比给它 stdio 的 Claude Code 活得久（CSO-1）：
 * SDK 的 StdioServerTransport 不听 stdin EOF，连上 bridge 后 ws + 退避定时器让事件循环常驻，
 * 父进程退出后就成了 ppid=1 的孤儿。这里用真进程 + 本地假 bridge 钉住两条退出路径：
 * stdin EOF，以及父进程被强杀、stdin 写端仍被别人持有（只能靠父进程看门狗）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/lib/codex-thread.js";
import { testChildEnv } from "./test-env.ts";

const SERVER = join(import.meta.dir, "..", "src", "channel-server.ts");

let bridge: ReturnType<typeof Bun.serve>;
const registers: Array<{ channelId: string; pid: number; ws: any }> = [];

beforeAll(() => {
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("nf", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type !== "register") return;
        registers.push({ channelId: msg.channelId, pid: msg.pid, ws });
        ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));
      },
    },
  });
});
afterAll(() => { void bridge.stop(true); });

async function waitFor<T>(what: string, fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(20);
  }
  throw new Error(`等待超时: ${what}`);
}

const serverEnv = (channelId: string) => testChildEnv({
  DISCORD_CHANNEL_ID: channelId,
  BRIDGE_URL: `ws://127.0.0.1:${bridge.port}`,
  BRIDGE_PORT: String(bridge.port),
});

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

/** 握手：等 initialize 响应再发 initialized，然后等 bridge 收到 register */
async function handshake(write: (s: string) => void, stdout: ReadableStream<Uint8Array>, channelId: string) {
  let buf = "";
  const reader = stdout.getReader();
  write(JSON.stringify(initialize) + "\n");
  const end = Date.now() + 8000;
  while (!/"id":1/.test(buf)) {
    if (Date.now() > end) throw new Error("等待超时: initialize 响应");
    const { value, done } = await reader.read();
    if (done) throw new Error("stdout 提前结束");
    buf += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  write(JSON.stringify(initialized) + "\n");
  return waitFor(`register ${channelId}`, () => registers.find((r) => r.channelId === channelId));
}

const killQuietly = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* 已经退了，正是期望的结果 */ } };

describe("channel-server 生命周期（CSO-1）", () => {
  test("握手并登记后关闭 stdin → 有限时间内退出", async () => {
    const proc = Bun.spawn([process.execPath, SERVER], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: serverEnv("999000501") });
    try {
      await handshake((s) => { proc.stdin.write(s); proc.stdin.flush(); }, proc.stdout as ReadableStream<Uint8Array>, "999000501");
      proc.stdin.end();
      const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "alive" as const)]);
      expect(code).toBe(0);
    } finally {
      killQuietly(proc.pid);
    }
  }, 20_000);

  test("父进程被强杀、stdin 写端仍被别人持有 → 父进程看门狗让它退出", async () => {
    // 中间父进程把 stdin/stdout 原样继承给 channel-server 后挂着。stdin 用 FIFO 且由本测试以读写方式
    // 独立持有（Bun 会在子进程退出时关掉 stdin:"pipe"，那样测的就又是 EOF 了），强杀中间父进程后
    // channel-server 收不到 EOF，只能靠发现父进程没了来退出。
    const dir = mkdtempSync(join(tmpdir(), "cso1-"));
    const fifo = join(dir, "stdin");
    execFileSync("mkfifo", [fifo]);
    const fd = openSync(fifo, "r+");
    const parentSrc = `Bun.spawn([process.execPath, ${JSON.stringify(SERVER)}], { stdin: "inherit", stdout: "inherit", stderr: "ignore" }); setInterval(() => {}, 1e9);`;
    const parent = Bun.spawn([process.execPath, "-e", parentSrc], { stdin: fd, stdout: "pipe", stderr: "ignore", env: serverEnv("999000502") });
    let childPid = 0;
    try {
      const reg = await handshake((s) => { writeSync(fd, s); }, parent.stdout as ReadableStream<Uint8Array>, "999000502");
      childPid = reg.pid;
      expect(childPid).not.toBe(parent.pid);
      parent.kill("SIGKILL");
      await parent.exited;
      const gone = await waitFor("channel-server 随父进程退出", () => (isPidAlive(childPid) ? undefined : true), 8000).catch(() => false);
      expect(gone).toBe(true);
    } finally {
      if (childPid) killQuietly(childPid);
      killQuietly(parent.pid);
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);

  for (const [code, label] of [[4001, "被顶替"], [4002, "被拒"]] as const) {
    test(`stdio 仍连着时${label}（${code}）→ 不退出、退避后重新登记`, async () => {
      const channelId = `99900051${code - 4000}`;
      const proc = Bun.spawn([process.execPath, SERVER], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: serverEnv(channelId) });
      try {
        const first = await handshake((s) => { proc.stdin.write(s); proc.stdin.flush(); }, proc.stdout as ReadableStream<Uint8Array>, channelId);
        first.ws.close(code, label);
        const again = await waitFor("重新登记", () => {
          const regs = registers.filter((r) => r.channelId === channelId);
          return regs.length >= 2 ? regs[1] : undefined;
        }, 10_000);
        expect(again.pid).toBe(proc.pid);
        expect(proc.exitCode).toBeNull();
      } finally {
        proc.stdin.end();
        killQuietly(proc.pid);
      }
    }, 20_000);
  }
});
