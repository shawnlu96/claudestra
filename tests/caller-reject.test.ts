/**
 * T85 顶替规则（CLAUDE.md channel-server lifecycle）：频道由已验证身份的会话持有时，没带有效凭据的注册被拒——
 * bridge 回 rejected + close 4002（bridge/caller-identity.ts admitCaller）；被拒的 channel-server 真进程不退出、
 * 不当成「被顶替」回来抢，按 3s → 6s → … 退避，不会每 3 秒撞一次（lib/link-policy.ts reconnectDelayMs）。
 * 状态目录由 tests/preload.ts 隔离；这里写的 registry / 凭据存储在 afterAll 还原。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitCaller } from "../src/bridge/caller-identity.ts";
import { CALLER_CRED_FILE_ENV, CALLER_CREDS_PATH, issueCallerCred, writeOneShot } from "../src/lib/caller-cred.ts";
import { reconnectDelayMs, REJECTED_CLOSE_CODE } from "../src/lib/link-policy.ts";
import { REGISTRY_PATH } from "../src/lib/registry.ts";
import { testChildEnv } from "./test-env.ts";

const SERVER = join(import.meta.dir, "..", "src", "channel-server.ts");
const root = mkdtempSync(join(tmpdir(), "caller-reject-"));
const saved = new Map<string, string | null>();

beforeAll(() => {
  for (const p of [REGISTRY_PATH, CALLER_CREDS_PATH]) saved.set(p, existsSync(p) ? readFileSync(p, "utf8") : null);
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { "agent-a": { channelId: "ch-a", status: "active", sessionId: "s-a" } } }));
});
afterAll(() => {
  for (const [p, v] of saved) v === null ? existsSync(p) && unlinkSync(p) : writeFileSync(p, v);
  rmSync(root, { recursive: true, force: true });
});

/** 假的 bridge 侧 ws：只记它收到的帧与关闭码 */
function fakeWs() {
  const w = { sent: [] as any[], closed: null as null | { code: number; reason: string } };
  return Object.assign(w, {
    send: (s: string) => void w.sent.push(JSON.parse(s)),
    close: (code: number, reason: string) => void (w.closed = { code, reason }),
  });
}

describe("bridge：已验证的持有者不被无凭据注册顶掉", () => {
  test("无凭据 → rejected + 4002，持有者不动；持有者的凭据失效（agent 重启）后照常顶替", async () => {
    const token = await issueCallerCred({ agent: "agent-a", family: "claude-code" });
    const holder = fakeWs();
    expect(admitCaller(holder as any, { channelId: "ch-a", callerCred: token }, undefined)).toBe(true);

    const stray = fakeWs();
    expect(admitCaller(stray as any, { channelId: "ch-a", pid: 4242 }, holder as any)).toBe(false);
    expect(stray.sent).toEqual([expect.objectContaining({ type: "rejected" })]);
    expect(stray.closed?.code).toBe(REJECTED_CLOSE_CODE);
    expect(REJECTED_CLOSE_CODE).toBe(4002);
    expect(holder.sent).toEqual([]);
    expect(holder.closed).toBeNull();

    // 拿不在存储里的凭据（伪造 / 别人旧的）同样被拒
    expect(admitCaller(fakeWs() as any, { channelId: "ch-a", callerCred: "f".repeat(64) }, holder as any)).toBe(false);
    // 同一 agent 重签（重启）：旧持有者不再 verified，新来的带新凭据 / 不带都放行（后者是兼容与 /mcp 重连）
    const fresh = await issueCallerCred({ agent: "agent-a", family: "claude-code" });
    expect(admitCaller(fakeWs() as any, { channelId: "ch-a", callerCred: fresh }, holder as any)).toBe(true);
    expect(admitCaller(fakeWs() as any, { channelId: "ch-a" }, holder as any)).toBe(true);
  });

  test("退避 3s → 60s 封顶", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(reconnectDelayMs)).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
  });
});

describe("channel-server 真进程被拒：不退出、不疯狂重试", () => {
  let bridge: ReturnType<typeof Bun.serve>;
  const registers: { at: number; msg: any }[] = [];
  beforeAll(() => {
    bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("nf", { status: 404 })),
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.type !== "register") return;
          registers.push({ at: Date.now(), msg });
          ws.send(JSON.stringify({ type: "rejected", reason: "test" }));
          ws.close(REJECTED_CLOSE_CODE, "verified holder");
        },
      },
    });
  });
  afterAll(() => void bridge.stop(true)); // 不等：被拒连接的收尾会让 stop 的 promise 拖过 hook 超时

  test("凭据从文件读走即删；被拒后按 3s、6s 退避，进程一直活着", async () => {
    const token = "c".repeat(64);
    const credFile = writeOneShot(token, join(root, "oneshot"));
    const proc = Bun.spawn([process.execPath, SERVER], {
      stdin: "pipe", stdout: "ignore", stderr: "ignore",
      env: testChildEnv({
        PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp",
        DISCORD_CHANNEL_ID: "999000485", BRIDGE_URL: `ws://127.0.0.1:${bridge.port}`, BRIDGE_PORT: String(bridge.port),
        [CALLER_CRED_FILE_ENV]: credFile,
      }),
    });
    try {
      const rpc = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      await Bun.sleep(300);
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (let i = 0; i < 100 && !registers.length; i++) await Bun.sleep(50);
      expect(registers[0]?.msg.callerCred).toBe(token);
      expect(existsSync(credFile)).toBe(false);

      await Bun.sleep(10_500 - (Date.now() - registers[0].at));
      expect(proc.exitCode).toBeNull();
      // 旧行为（连上就清零退避）是 0 / 3 / 6 / 9s 四次；现在 0 / 3 / 9s 三次
      expect(registers).toHaveLength(3);
      const gaps = registers.slice(1).map((r, i) => r.at - registers[i].at);
      expect(gaps[0]).toBeGreaterThan(2_500);
      expect(gaps[1]).toBeGreaterThan(5_500);
    } finally {
      proc.kill();
      await Promise.race([proc.exited, Bun.sleep(2000)]);
    }
  }, 20_000);
});
