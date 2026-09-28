/**
 * 受控测试：真实起一个沙箱 bridge（scripts/sandbox.ts），启动 → 使用 → 重启 → 退出，全程证明没有副作用。
 *
 * 「生产」由临时目录冒充：HOME 指向假 home（里面种好 ~/.claude-orchestrator 与 ~/.claude），调用者环境里
 * 塞满生产地址与身份（BRIDGE_URL=生产端口、Discord token、中继地址），PATH 前面垫一层记账 shim
 * （launchctl / tmux / claude …）。断言：
 *   1. 假 home 下没有任何文件新建 / 修改 / 删除（逐文件比 size + mtime + 内容哈希）；
 *   2. launchctl 一次都没被调；tmux 每次调用都走沙箱 socket；
 *   3. 出站请求 0 次：代理替身、中继替身都没收到请求，bridge 日志里也没有出站闸门拦截记录；
 *   4. bridge 只监听沙箱端口（有 lsof 时）；沙箱状态目录确实收到了写入（证明写入被重定向，而不是没发生）。
 * 另测：绕过脚本、直接带着 Discord token / 中继地址起沙箱 bridge → 拒绝启动，同样零写入零出站。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.js";
import { OUTBOUND_BLOCKED_MARK } from "../src/lib/sandbox.js";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "sandbox.ts");
const BUN = process.execPath;
const REAL_TMUX = Bun.which("tmux");

let tmp = "";
let home = "";
let root = "";
let shimLog = "";
let port = 0;
const hits: { proxy: string[]; decoy: string[] } = { proxy: [], decoy: [] };
let proxy: ReturnType<typeof Bun.serve> | null = null;
let decoy: ReturnType<typeof Bun.serve> | null = null;

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.set(`${p}/`, String(st.mtimeMs));
        walk(p);
      } else {
        out.set(p, `${st.size}:${st.mtimeMs}:${createHash("sha1").update(readFileSync(p)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return out;
}

function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push(`${a.has(k) ? "改" : "新"} ${k}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`删 ${k}`);
  return out;
}

function seedFakeHome(): void {
  const st = join(home, ".claude-orchestrator");
  mkdirSync(join(st, "logs"), { recursive: true });
  writeFileSync(join(st, "registry.json"), JSON.stringify({ agents: { "agent-prod": { channelId: "111", status: "active", cwd: home } } }));
  writeFileSync(join(st, "peers.json"), JSON.stringify({ httpPeers: [{ name: "prod-peer", url: "https://peer.example.com", token: "t" }] }));
  writeFileSync(join(st, "config.json"), "{}");
  mkdirSync(join(home, ".claude", "projects", "-prod"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: {} }));
  writeFileSync(join(home, ".claude", "projects", "-prod", "s.jsonl"), "{}\n");
}

/** 记账 shim：记下 argv；tmux 透传真 tmux（沙箱 socket 上的真实行为），其余一律失败退出 */
function writeShims(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const shim = (name: string, tail: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${shimLog}'\n${tail}\n`);
    chmodSync(p, 0o755);
  };
  shim("tmux", REAL_TMUX ? `exec '${REAL_TMUX}' "$@"` : "exit 1");
  for (const n of ["launchctl", "claude", "codex", "pi", "npm", "curl", "open", "osascript", "tailscale"]) shim(n, "exit 1");
}

function callerEnv(): Record<string, string> {
  return {
    PATH: `${join(tmp, "shim")}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: tmp,
    HTTP_PROXY: `http://127.0.0.1:${proxy!.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy!.port}`,
    NO_PROXY: "127.0.0.1,localhost",
    // 测试驱动本身（相当于执行者的终端）跑 bun 也会写转译缓存：关掉，免得把它算成沙箱的写入
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    // 执行者 agent 自己的环境长这样——脚本必须一个都不带进沙箱
    BRIDGE_URL: `ws://localhost:${DEFAULT_BRIDGE_PORT}`,
    BRIDGE_PORT: String(DEFAULT_BRIDGE_PORT),
    DISCORD_CHANNEL_ID: "111",
    DISCORD_BOT_TOKEN: "decoy-token",
    RELAY_URL: `ws://127.0.0.1:${decoy!.port}`,
    CLAUDESTRA_STATE_DIR: join(home, ".claude-orchestrator"),
  };
}

function sandbox(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([BUN, SCRIPT, ...args, "--port", String(port), "--root", root], {
    cwd: REPO, env: callerEnv(), stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() };
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 9000);
    try {
      Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }).stop(true);
      return p;
    } catch {
      continue; // 被占了，换一个
    }
  }
  throw new Error("找不到空闲端口");
}

function listeningPorts(pid: number): number[] | null {
  if (!Bun.which("lsof")) return null;
  const r = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-nP", "-Fn"], { stdout: "pipe" });
  return r.stdout.toString().split("\n").filter((l) => l.startsWith("n")).map((l) => Number(l.split(":").pop()));
}

async function exercise(): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  expect((await fetch(`${base}/stats`)).ok).toBe(true);
  expect((await fetch(`${base}/hook`, { method: "POST", body: JSON.stringify({ channelId: "local-x", event: "Stop" }) })).status).toBeLessThan(500);
  // 冒充一个 channel-server 注册上来，走一遍注册 / 断开路径
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error("ws 连不上")); });
  ws.send(JSON.stringify({ type: "register", channelId: "local-sbx-test", cwd: join(root, "work"), pid: process.pid, ppid: process.ppid }));
  await Bun.sleep(500);
  ws.close();
  const list = sandbox("manager", "list");
  expect(list.code).toBe(0);
  // 被拒绝的动作：manager 白名单外、API 拒绝表（无 token 时 401 也算没做成）
  expect(sandbox("manager", "install-cli").code).not.toBe(0);
  expect((await fetch(`${base}/api/v1/update`, { method: "POST" })).ok).toBe(false);
  await Bun.sleep(4000); // 等 bridge 启动后 3s 的 project-migrate 等延迟任务跑完
}

beforeAll(async () => {
  tmp = mkdtempSync("/tmp/sbxi-"); // 短路径：unix socket 上限 104 字节
  home = join(tmp, "home");
  root = join(tmp, "sbx");
  shimLog = join(tmp, "shim.log");
  writeFileSync(shimLog, "");
  seedFakeHome();
  writeShims(join(tmp, "shim"));
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits.proxy.push(`${req.method} ${req.url}`); return new Response("no", { status: 502 }); } });
  decoy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits.decoy.push(`${req.method} ${req.url}`); return new Response("no", { status: 502 }); } });
  port = await freePort();
});

afterAll(() => {
  if (existsSync(join(root, "bridge.pid"))) sandbox("down");
  proxy?.stop(true);
  decoy?.stop(true);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("沙箱 bridge 无副作用", () => {
  test("启动 → 使用 → 重启 → 退出：假生产 home 零改动、不碰 launchd、不出站、只用沙箱 socket 与端口", async () => {
    const before = snapshot(home);

    const up = sandbox("up");
    expect(up.code, up.out).toBe(0);
    const pid = Number(readFileSync(join(root, "bridge.pid"), "utf8"));
    const ports = listeningPorts(pid);
    if (ports) expect(ports.every((p) => p === port), `监听端口 ${ports}`).toBe(true);
    expect(port).not.toBe(DEFAULT_BRIDGE_PORT);
    await exercise();

    expect(sandbox("down").code).toBe(0);
    const again = sandbox("up");
    expect(again.code, again.out).toBe(0);
    await exercise();
    expect(sandbox("down").code).toBe(0);

    expect(diff(before, snapshot(home))).toEqual([]);

    const calls = readFileSync(shimLog, "utf8").split("\n").filter(Boolean);
    expect(calls.filter((c) => c.startsWith("launchctl"))).toEqual([]);
    const sock = join(root, "run", "master.sock");
    expect(calls.filter((c) => c.startsWith("tmux") && !c.includes(`-S ${sock}`))).toEqual([]);
    expect(calls.filter((c) => /^(npm|pi|curl|codex) /.test(c))).toEqual([]);

    expect(hits).toEqual({ proxy: [], decoy: [] });
    const log = readFileSync(join(root, "bridge.log"), "utf8");
    expect(log).not.toContain(OUTBOUND_BLOCKED_MARK);
    expect(log).toContain("Web-only");
    // 写入确实落在沙箱里
    expect(existsSync(join(root, "state", "projects.json"))).toBe(true);
    expect(readdirSync(join(root, "state")).length).toBeGreaterThan(0);
  }, 90_000);

  test("绕过脚本、带着生产身份直接起沙箱 bridge → 拒绝启动，零写入零出站", async () => {
    const before = snapshot(home);
    const stateDir = join(tmp, "direct", "state");
    const base = {
      PATH: process.env.PATH ?? "", HOME: home, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_STATE_DIR: stateDir,
      CLAUDESTRA_RUNTIME_DIR: join(tmp, "direct", "run"), BRIDGE_PORT: String(await freePort()), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const cases: Array<[string, Record<string, string>]> = [
      ["DISCORD_BOT_TOKEN", { DISCORD_BOT_TOKEN: "decoy-token" }],
      ["RELAY_URL", { RELAY_URL: `ws://127.0.0.1:${decoy!.port}` }],
      ["CLAUDESTRA_STATE_DIR", { CLAUDESTRA_STATE_DIR: "" }],
      ["BRIDGE_PORT", { BRIDGE_PORT: String(DEFAULT_BRIDGE_PORT) }],
    ];
    for (const [want, extra] of cases) {
      const r = Bun.spawnSync([BUN, "--no-env-file", join(REPO, "src", "bridge.ts")], {
        cwd: tmp, env: { ...base, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
      });
      const out = r.stdout.toString() + r.stderr.toString();
      expect(r.exitCode, out).not.toBe(0);
      expect(out).toContain("沙箱模式");
      expect(out).toContain(want);
    }
    expect(diff(before, snapshot(home))).toEqual([]);
    expect(existsSync(stateDir)).toBe(false);
    expect(hits).toEqual({ proxy: [], decoy: [] });
  }, 90_000);

  test("全局注册的 Stop hook：沙箱 agent 按 BRIDGE_URL 打到沙箱端口；拿到生产地址就报错退出、不发请求", async () => {
    const got: string[] = [];
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { got.push(`${new URL(req.url).pathname} ${await req.text()}`); return Response.json({}); } });
    // 异步 spawn：替身服务跑在本测试进程里，spawnSync 会把它的事件循环一起卡住
    const hook = async (env: Record<string, string>) => {
      const p = Bun.spawn([BUN, "--no-env-file", join(REPO, "src", "hooks", "typing-hook.ts")], {
        cwd: tmp, stdin: new Blob([JSON.stringify({ hook_event_name: "Stop" })]), stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CLAUDESTRA_SANDBOX: "1", DISCORD_CHANNEL_ID: "local-sbx", ...env },
      });
      return { code: await p.exited, err: await new Response(p.stderr).text() };
    };
    try {
      expect((await hook({ BRIDGE_URL: `ws://localhost:${fake.port}`, BRIDGE_PORT: String(fake.port) })).code).toBe(0);
      expect(got).toEqual([`/hook ${JSON.stringify({ channelId: "local-sbx", event: "Stop", stopHookActive: false })}`]);
      const bad: Array<Record<string, string>> = [{ BRIDGE_URL: `ws://localhost:${DEFAULT_BRIDGE_PORT}` }, {}];
      for (const env of bad) {
        const r = await hook(env);
        expect(r.code).not.toBe(0);
        expect(r.err).toContain("沙箱模式");
      }
      expect(got).toHaveLength(1);
    } finally {
      fake.stop(true);
    }
  }, 60_000);
});
