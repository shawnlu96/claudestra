/**
 * 真实 sandbox 生命周期、bridge/ws 与假 agent：假生产 home 的 hash、socket 归属、出站与设施调用均须保持隔离。
 * 端口竞争及取消由可控钩子注入；失败路径仍核验 child、bridge、pid 文件与监听端口的清理。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.js";
import { OUTBOUND_BLOCKED_MARK } from "../src/lib/sandbox-outbound.js";
import { fakeClaudeSource } from "./sandbox-fake-claude.js";
import { fakePiSource } from "./sandbox-fake-pi.ts";
import { testChildEnv } from "./test-env.ts";
import { atGate, Fleet, gateHit, gateShell, pickPort, pidAlive as alive, StartFailure, startSandbox, type StartSpec } from "./sandbox-isolation-start-fixture.ts";
const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "sandbox.ts");
const BUN = process.execPath;
const REAL_TMUX = Bun.which("tmux");
const PROD_SID = "11111111-2222-4333-8444-555555555555";
/** 候选端口禁用表：生产端口与下面拒连负例用的固定端口 */
const AVOID_PORTS = [DEFAULT_BRIDGE_PORT, 23998, 23999];
let [tmp, home, root, shimLog, port] = ["", "", "", "", 0];
const hits: { proxy: string[]; decoy: string[] } = { proxy: [], decoy: [] };
let [proxy, decoy]: Array<ReturnType<typeof Bun.serve> | null> = [null, null];
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
  // 与真实安装相同的全局配置：hooks 与 statusLine 指向本仓库（合并后就是生产跑的那份）
  const typing = [{ matcher: "", hooks: [{ type: "command", command: `${BUN} ${join(REPO, "src", "hooks", "typing-hook.ts")}` }] }];
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    hooks: {
      Stop: typing, StopFailure: typing, Notification: typing,
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `${BUN} ${join(REPO, "src", "hooks", "recall-hook.ts")}` }] }],
    },
    // 全局 statusLine 指向「主树里还没修的旧脚本」：无条件写生产的 usage-cache.json。沙箱 agent 必须经 --settings
    // 换成本 checkout 的脚本，否则下面的零写入断言会红（T1 复核第 2 轮：合并前的实机验证就是这个情况）
    statusLine: { type: "command", command: join(tmp, "stale-statusline.sh") },
  }));
  writeFileSync(join(tmp, "stale-statusline.sh"), `#!/bin/sh\ncat >/dev/null\necho '{}' > "$HOME/.claude-orchestrator/usage-cache.json"\n`);
  chmodSync(join(tmp, "stale-statusline.sh"), 0o755);
  writeFileSync(join(home, ".claude", "projects", "-prod", "s.jsonl"), "{}\n");
  // 一段生产会话：沙箱里 set-session 到它、再 restart，就会续到生产那段对话——必须被拒
  writeFileSync(join(home, ".claude", "projects", "-prod", `${PROD_SID}.jsonl`), JSON.stringify({ type: "user", sessionId: PROD_SID, cwd: join(home, "prodrepo") }) + "\n");
  // 用户 rc 把自己的 bin 放 PATH 最前（真实用户靠它找到 claude）；login shell 的 path_helper 之后 .zshrc 再垫一次
  const rc = `export PATH="${join(tmp, "shim")}:$PATH"\n`;
  for (const f of [".zshenv", ".zshrc", ".bashrc", ".profile"]) writeFileSync(join(home, f), rc);
}
/** 记账 shim：记下 argv；tmux 透传真 tmux（沙箱 socket 上的真实行为），其余一律失败退出 */
function writeShims(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const shim = (name: string, tail: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${shimLog}'\n${tail}\n`);
    chmodSync(p, 0o755);
  };
  shim("tmux", `${gateShell(tmuxGate())}\n${REAL_TMUX ? `exec '${REAL_TMUX}' "$@"` : "exit 1"}`); // 闸门只在端口竞争测试里打开
  for (const n of ["launchctl", "codex", "npm", "curl", "open", "osascript", "tailscale"]) shim(n, "exit 1");
  // pi：只答版本探测和 ACP 适配器起的 rpc 模式（交给假 pi），别的（pi update / install …）照旧失败并被下面的断言抓到
  writeFileSync(join(dir, "fake-pi"), fakePiSource(BUN, join(tmp, "fake-pi.log")));
  chmodSync(join(dir, "fake-pi"), 0o755);
  shim("pi", `case "$1" in --version) echo 0.99.2 ;; --mode) exec '${join(dir, "fake-pi")}' "$@" ;; *) exit 1 ;; esac`);
  writeFileSync(join(dir, "claude"), fakeClaudeSource(BUN, join(tmp, "fake-claude.log")));
  chmodSync(join(dir, "claude"), 0o755);
}
const tmuxGate = () => join(tmp, "tmux-gate");
function callerEnv(): Record<string, string> {
  return {
    PATH: `${join(tmp, "shim")}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: tmp,
    LANG: "en_US.UTF-8", // 同生产 launchd plist：没有 UTF-8 locale 时 tmux 把 -F 输出里的 \t 换成 _，按 \t 切的解析（如 web-shell readShells）全落空
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
/** 经原入口 scripts/sandbox.ts up 起沙箱的夹具参数（端口竞争由 startSandbox 协调）；deadline 取调用方现有 timeout 之内 */
function upSpec(r: string, ms: number, extra: Partial<StartSpec> = {}): StartSpec {
  return {
    root: r, cwd: REPO, env: callerEnv, avoid: AVOID_PORTS, deadline: Date.now() + ms,
    argv: (sub, p) => [BUN, SCRIPT, sub, "--port", String(p), "--root", r], ...extra,
  };
}
/** 进程当前打开的文件路径（有 lsof 时）：用来断言沙箱 bridge 没开着任何生产目录里的文件 */
function openFiles(pid: number): string[] | null {
  if (!Bun.which("lsof")) return null;
  const r = Bun.spawnSync(["lsof", "-p", String(pid), "-Fn"], { stdout: "pipe" });
  return r.stdout.toString().split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
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
  expect(list.out).not.toContain(OUTBOUND_BLOCKED_MARK); // manager 子进程也没试图出站
  // 被拒绝的动作：manager 白名单外、API 拒绝表（无 token 时 401 也算没做成）
  expect(sandbox("manager", "install-cli").code).not.toBe(0);
  expect((await fetch(`${base}/api/v1/update`, { method: "POST" })).ok).toBe(false);
  await Bun.sleep(4000); // 等 bridge 启动后 3s 的 project-migrate 等延迟任务跑完
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(300)) if (check()) return;
  throw new Error(`等不到：${what}`);
}

/** agent 侧：真建一个沙箱 agent（claude = 假 Claude Code），经 API 收发一条消息，hooks / statusLine / 会话发现都走一遍 */
async function agentSide(): Promise<void> {
  const flog = () => (existsSync(join(tmp, "fake-claude.log")) ? readFileSync(join(tmp, "fake-claude.log"), "utf8") : "");
  const blog = () => readFileSync(join(root, "bridge.log"), "utf8");
  const created = sandbox("manager", "create", "sbxt", join(root, "work"), "隔离测试");
  const info = JSON.parse(created.out.split("\n").find((l) => l.startsWith("{")) ?? "{}") as { ok?: boolean; channelId?: string; sessionId?: string };
  expect(info.ok, `${created.out}\n${flog()}`).toBe(true);
  await until("channel-server 注册到沙箱 bridge", () => blog().includes(`注册频道: ${info.channelId}`));
  await until("bridge 发现会话 jsonl", () => blog().includes("开始监听: agent-sbxt"));
  const tok = sandbox("manager", "token-add", "dev", "--agents", "*", "--force");
  const secret = (JSON.parse(tok.out.split("\n").find((l) => l.startsWith("{")) ?? "{}") as { secret?: string }).secret;
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/agents/agent-sbxt/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "ping", wait: 20 }),
  });
  expect(((await r.json()) as { reply?: string }).reply, flog()).toBe("pong");
  await until("Stop hook 打到沙箱 bridge", () => blog().includes(`Hook 收到 Stop: channel=${info.channelId}`));
  expect(flog()).toContain("strict=true");
  expect(flog()).not.toMatch(/code=[1-9]/); // SessionStart / statusLine / Stop 都正常退出
  // statusLine 的用量缓存落在沙箱状态目录，生产的没出现
  expect(existsSync(join(root, "state", "usage-cache.json"))).toBe(true);
  expect(existsSync(join(home, ".claude-orchestrator", "usage-cache.json"))).toBe(false);
  // 沙箱根目录外、目录不存在（tmux 会回落到 $HOME）、Codex 真 TUI：拒绝；API 建 agent 同样经 manager create
  expect(sandbox("manager", "create", "bad", tmp).out).toContain("沙箱 agent 必须建在");
  expect(sandbox("manager", "create", "typo", join(root, "work", "typo")).out).toContain("不存在");
  expect(sandbox("manager", "create", "bad2", join(root, "work"), "--runtime", "codex", "--transport", "tmux").code).not.toBe(0);
  const api = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "typo2", dir: join(root, "work", "typo2") }),
  });
  expect(JSON.stringify(await api.json())).toContain("不存在");
  // 生产侧（不带沙箱开关的 manager）：takeover 不列沙箱会话、resume 不接管它
  const listed = productionManager("takeover");
  expect((JSON.parse(listed.out.split("\n").find((l) => l.startsWith("{")) ?? "{}") as { candidates?: unknown[] }).candidates, listed.out).toEqual([]);
  expect(productionManager("resume", "prodx", info.sessionId ?? "").out).toContain("属于沙箱");
  // set-session：指到生产会话被拒（否则 restart 就续到生产对话）；指回自己的会话照常
  const hijack = sandbox("manager", "set-session", "sbxt", PROD_SID);
  expect(hijack.code, hijack.out).not.toBe(0);
  expect(hijack.out).toContain("沙箱");
  expect(sandbox("manager", "set-session", "sbxt", info.sessionId ?? "").code).toBe(0);
  // 带尾空格的目录：规范化后交给 tmux（检查的与实际用的是同一个串），agent 落在 work/ 里
  const spaced = sandbox("manager", "create", "sbxsp", `${join(root, "work")} `, "尾空格");
  expect(spaced.out).toContain('"ok":true');
  expect(sandbox("manager", "list").out).toContain(`"cwd":"${join(root, "work")}"`);
  // 事后复核：目录存在但进不去（chmod 000）时 tmux 会回落到 $HOME——前置检查过得去，复核必须关掉窗口
  const noperm = join(root, "work", "noperm");
  mkdirSync(noperm);
  chmodSync(noperm, 0o000);
  try {
    const r = Bun.spawnSync([BUN, "--no-env-file", "-e", `
      const { tmuxRawStrict, tmuxRaw } = await import(${JSON.stringify(join(REPO, "src", "lib", "tmux-helper.ts"))});
      try { await tmuxRawStrict(["new-window", "-t", "master:", "-n", "sbx-noperm", "-c", ${JSON.stringify(noperm)}]); console.log("through"); }
      catch (e) { console.log("blocked: " + e.message); }
      console.log("windows: " + (await tmuxRaw(["list-windows", "-t", "master", "-F", "#{window_name}"])).split("\\n").join(","));`],
    { cwd: root, env: sandboxEnvOf(), stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(out, r.stderr.toString()).toContain("已关掉");
    expect(out).not.toContain("sbx-noperm");
  } finally {
    chmodSync(noperm, 0o755);
  }
  expect(sandbox("manager", "kill", "sbxsp").code).toBe(0);
  expect(sandbox("manager", "kill", "sbxt").code).toBe(0);
}

const firstJson = (out: string) => JSON.parse(out.split("\n").find((l) => l.startsWith("{")) ?? "{}") as Record<string, any>;

/** 网页新终端：登记过的项目目录 stat 是目录但进不去（chmod 000），tmux 会回落 HOME——路由必须报错、不留窗口（new-session / new-window 两条分支） */
async function webShellSide(): Promise<void> {
  const noperm = join(root, "work", "sh-noperm");
  mkdirSync(noperm);
  expect(sandbox("manager", "project-add", "sbxsh", "--dirs", noperm).out).toContain('"ok":true');
  const secret = firstJson(sandbox("manager", "token-add", "dev-sh", "--agents", "master", "--force", "--terminal").out).secret;
  const api = async (method: string, path = "", body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/shells${path}`, {
      method, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  chmodSync(noperm, 0o000);
  try {
    const first = await api("POST", "", { dir: noperm }); // 还没有 webshell session：new-session
    expect(first.status, JSON.stringify(first.body)).toBe(500);
    expect(first.body.error).toContain("已关掉");
    expect((await api("GET")).body.shells).toEqual([]);
    const ok = await api("POST", "", { dir: join(root, "work") });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const second = await api("POST", "", { dir: noperm }); // session 已在：new-window
    expect(second.status, JSON.stringify(second.body)).toBe(500);
    expect((await api("GET")).body.shells.map((s: { id: string }) => s.id)).toEqual([ok.body.shell.id]);
    expect((await api("DELETE", `/${ok.body.shell.id}`)).status).toBe(200);
  } finally {
    chmodSync(noperm, 0o755);
  }
}

/** Pi 走 ACP（假 pi）：目录钉在沙箱根、HOME 隔离、发现开关全关，reply 经 channel-server 回到沙箱 bridge；切回 tmux 在沙箱里被拒 */
async function piSide(): Promise<void> {
  const plog = () => (existsSync(join(tmp, "fake-pi.log")) ? readFileSync(join(tmp, "fake-pi.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const created = sandbox("manager", "create", "sbxpi", join(root, "work"), "Pi 隔离测试", "--runtime", "pi");
  const info = firstJson(created.out);
  expect(info, created.out).toMatchObject({ ok: true, transport: "acp" });
  const secret = firstJson(sandbox("manager", "token-add", "dev-pi", "--agents", "*", "--force").out).secret;
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/agents/agent-sbxpi/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "ping", wait: 20 }),
  });
  expect(((await r.json()) as { reply?: string }).reply, JSON.stringify(plog())).toBe("pong");
  const start = plog().find((l) => l.argv);
  expect(start).toMatchObject({ HOME: join(root, "acp-home"), PI_CODING_AGENT_DIR: join(root, "pi-agent"), PI_OFFLINE: "1", BRIDGE_PORT: null, DISCORD_CHANNEL_ID: null, mcp: ["claudestra"] });
  expect(start.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", "builtin:mcp", "--session-id", info.sessionId]));
  const back = sandbox("manager", "migrate", "--pi", "sbxpi", "--to", "tmux");
  expect([back.code === 0, back.out]).toEqual([false, expect.stringContaining("只走 ACP")]);
  expect(sandbox("manager", "kill", "sbxpi").code).toBe(0);
}

/**
 * 以「生产」身份跑 manager（不带沙箱开关）：状态 / 运行目录是另一套一次性目录（不碰假 home 的状态目录，
 * 也绝不碰真实的 /tmp/claude-orchestrator），bridge 地址指向中继替身——万一闸门失效，替身会记到请求
 */
function productionManager(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([BUN, "--no-env-file", join(REPO, "src", "manager.ts"), ...args], {
    cwd: tmp, stdout: "pipe", stderr: "pipe", timeout: 30_000,
    env: testChildEnv({
      PATH: `${join(tmp, "shim")}:${process.env.PATH}`, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      CLAUDESTRA_STATE_DIR: join(tmp, "prodmgr", "state"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "prodmgr", "run"),
      BRIDGE_URL: `ws://127.0.0.1:${decoy!.port}`, BRIDGE_PORT: String(decoy!.port),
    }),
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() };
}

/** 沙箱环境（与 scripts/sandbox.ts 给沙箱进程的完全相同），用来模拟 `eval "$(bun run sandbox env)"` 与沙箱 agent 的 Bash */
function sandboxEnvOf(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of sandbox("env").out.split("\n")) {
    const m = /^export ([A-Z_]+)='(.*)'$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/'\\''/g, "'");
  }
  return { ...out, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
}

beforeAll(async () => {
  tmp = mkdtempSync("/tmp/sbxi-"); // 短路径：unix socket 上限 104 字节
  [home, root, shimLog] = [join(tmp, "home"), join(tmp, "sbx"), join(tmp, "shim.log")];
  writeFileSync(shimLog, "");
  seedFakeHome();
  writeShims(join(tmp, "shim"));
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits.proxy.push(`${req.method} ${req.url}`); return new Response("no", { status: 502 }); } });
  decoy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits.decoy.push(`${req.method} ${req.url}`); return new Response("no", { status: 502 }); } });
});

afterAll(() => {
  if (existsSync(join(root, "bridge.pid"))) sandbox("down");
  [proxy, decoy].forEach((s) => s?.stop(true));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("沙箱 bridge 无副作用", () => {
  test("启动 → 使用 → 重启 → 退出：假生产 home 零改动、不碰 launchd、不出站、只用沙箱 socket 与端口", async () => {
    const before = snapshot(home);

    const up = await startSandbox(upSpec(root, 45_000));
    port = up.port;
    const pid = Number(readFileSync(join(root, "bridge.pid"), "utf8"));
    expect(pid).toBe(up.pid);
    const ports = listeningPorts(pid);
    if (ports) expect(ports.every((p) => p === port), `监听端口 ${ports}`).toBe(true);
    expect(port).not.toBe(DEFAULT_BRIDGE_PORT);
    await exercise();
    // agent 侧要真 tmux。CI 装了 tmux（.github/workflows/ci.yml）；CI 里没有就失败，免得这段覆盖悄悄没跑
    if (!REAL_TMUX && process.env.CI) throw new Error("CI 里找不到 tmux：agent 侧隔离测试不能跳过");
    if (REAL_TMUX) await agentSide();
    if (REAL_TMUX) await webShellSide();
    if (REAL_TMUX) await piSide();
    const open = openFiles(pid);
    if (open) expect(open.filter((f) => f.includes("claude-orchestrator"))).toEqual([]);

    expect(sandbox("down").code).toBe(0);
    port = (await startSandbox(upSpec(root, 45_000, { firstPort: port }))).port; // 重启沿用原端口，确认被抢才换
    await exercise();
    expect(sandbox("down").code).toBe(0);

    // 唯一允许的改动：假 Claude Code 自己写的会话 jsonl 与进程登记（~/.claude/projects、~/.claude/sessions，Claude Code 自身的写入）
    const cc = [join(home, ".claude", "projects"), join(home, ".claude", "sessions")];
    const ccOwn = (c: string) => cc.some((d) => c.startsWith(`新 ${d}/`) || c === `改 ${d}/` || c === `新 ${d}/` || c.startsWith(`删 ${d}/`));
    expect(diff(before, snapshot(home)).filter((c) => !ccOwn(c) && c !== `改 ${join(home, ".claude")}/`)).toEqual([]);

    const calls = readFileSync(shimLog, "utf8").split("\n").filter(Boolean);
    expect(calls.filter((c) => c.startsWith("launchctl"))).toEqual([]);
    const sock = join(root, "run", "master.sock");
    // 例外只有测试自己以「生产」身份跑的 manager（productionManager，一次性的假生产运行目录）
    const prodSock = join(tmp, "prodmgr", "run", "master.sock");
    expect(calls.filter((c) => c.startsWith("tmux") && !c.includes(`-S ${sock}`) && !c.includes(`-S ${prodSock}`))).toEqual([]);
    expect(calls.filter((c) => /^(npm|pi|curl|codex) /.test(c) && !/^pi (--version$|--mode rpc )/.test(c))).toEqual([]);

    expect(hits).toEqual({ proxy: [], decoy: [] });
    const log = readFileSync(join(root, "bridge.log"), "utf8");
    expect(log).not.toContain(OUTBOUND_BLOCKED_MARK);
    expect(log).toContain("Web-only");
    // 写入确实落在沙箱里
    expect(existsSync(join(root, "state", "projects.json"))).toBe(true);
    expect(readdirSync(join(root, "state")).length).toBeGreaterThan(0);
  }, 150_000);

  test("绕过脚本、带着生产身份直接起沙箱 bridge → 拒绝启动，零写入零出站", async () => {
    const before = snapshot(home);
    const stateDir = join(tmp, "direct", "state");
    const base = {
      PATH: process.env.PATH ?? "", HOME: home, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_STATE_DIR: stateDir,
      CLAUDESTRA_RUNTIME_DIR: join(tmp, "direct", "run"), BRIDGE_PORT: String(pickPort(AVOID_PORTS)), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const cases: Array<[string, Record<string, string>]> = [
      ["DISCORD_BOT_TOKEN", { DISCORD_BOT_TOKEN: "decoy-token" }],
      ["RELAY_URL", { RELAY_URL: `ws://127.0.0.1:${decoy!.port}` }],
      ["CLAUDESTRA_STATE_DIR", { CLAUDESTRA_STATE_DIR: "" }],
      ["生产端口", { BRIDGE_PORT: String(DEFAULT_BRIDGE_PORT) }],
    ];
    for (const [want, extra] of cases) {
      const r = Bun.spawnSync([BUN, "--no-env-file", join(REPO, "src", "bridge.ts")], {
        cwd: tmp, env: testChildEnv({ ...base, BRIDGE_URL: undefined, ...extra }), stdout: "pipe", stderr: "pipe", timeout: 20_000,
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

  test("绕过脚本：带着沙箱环境直接跑 manager 的危险子命令、launcher / cron / setup，全部拒绝，零写入零出站", async () => {
    const before = snapshot(home);
    const launchctlBefore = readFileSync(shimLog, "utf8").split("\n").filter((c) => c.startsWith("launchctl")).length;
    const env = sandboxEnvOf();
    expect(env.CLAUDESTRA_SANDBOX).toBe("1");
    const run = (argv: string[]) => {
      const r = Bun.spawnSync([BUN, "--no-env-file", ...argv], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() };
    };
    const mgr = join(REPO, "src", "manager.ts");
    const cmds = [
      ["install-cli"], ["install-hooks"], ["install-skills"], ["takeover"], ["takeover", "--all"], ["update"], ["retire-web"],
      ["resume", "x", "00000000-0000-4000-8000-000000000000", join(root, "work")], ["adopt", "x", "00000000-0000-4000-8000-000000000000"],
      ["peer-http-list"], ["doctor"],
    ];
    for (const c of cmds) {
      const r = run([mgr, ...c]);
      expect(r.code, `${c.join(" ")}\n${r.out}`).not.toBe(0);
      expect(r.out, c.join(" ")).toContain("沙箱");
    }
    for (const entry of ["launcher.ts", "cron.ts", "setup.ts"]) {
      const r = run([join(REPO, "src", entry)]);
      expect(r.code, `${entry}\n${r.out}`).not.toBe(0);
      expect(r.out, entry).toContain("不能在沙箱里跑");
    }
    // `bun -e 'await import(...)'` 时 argv[1] 为空，按入口名的那道拦不住：launcher / setup 的 main 自己再拦
    for (const entry of ["launcher.ts", "setup.ts"]) {
      const r = run(["-e", `await import(${JSON.stringify(join(REPO, "src", entry))});`]);
      expect(r.code, `import ${entry}\n${r.out}`).not.toBe(0);
      expect(r.out, entry).toContain("沙箱里不许跑");
    }
    expect(diff(before, snapshot(home))).toEqual([]);
    expect(readFileSync(shimLog, "utf8").split("\n").filter((c) => c.startsWith("launchctl")).length).toBe(launchctlBefore);
    expect(hits).toEqual({ proxy: [], decoy: [] });
  }, 120_000);

  test("tmux socket：沙箱进程起来之后把 socket 或整个运行目录换成软链，tmux 调用直接拒绝", async () => {
    const base = join(tmp, "socktest");
    const fakeProd = join(tmp, "fakeprod-run");
    mkdirSync(join(base, "run"), { recursive: true });
    mkdirSync(fakeProd, { recursive: true });
    const env = testChildEnv({
      HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CLAUDESTRA_SANDBOX: "1",
      CLAUDESTRA_STATE_DIR: join(base, "state"), CLAUDESTRA_RUNTIME_DIR: join(base, "run"), BRIDGE_PORT: "23998", BRIDGE_URL: "ws://localhost:23998",
      CLAUDESTRA_SANDBOX_DENY_DIRS: fakeProd,
    });
    const attempt = (swap: string) => Bun.spawnSync([BUN, "--no-env-file", "-e", `
      const { tmuxRaw } = await import(${JSON.stringify(join(REPO, "src", "lib", "tmux-helper.ts"))});
      const fs = await import("fs");
      ${swap}
      try { await tmuxRaw(["kill-server"]); console.log("through"); } catch (e) { console.log("blocked: " + e.message); }`],
    { cwd: tmp, env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
    const sock = join(base, "run", "master.sock");
    expect(attempt(`fs.symlinkSync(${JSON.stringify(join(fakeProd, "master.sock"))}, ${JSON.stringify(sock)});`)).toContain("软链");
    rmSync(sock, { force: true });
    const swapDir = `fs.renameSync(${JSON.stringify(join(base, "run"))}, ${JSON.stringify(join(base, "run.old"))});
      fs.symlinkSync(${JSON.stringify(fakeProd)}, ${JSON.stringify(join(base, "run"))});`;
    expect(attempt(swapDir)).toContain("生产目录");
  }, 60_000);

  test("出站闸门：沙箱进程里 fetch 与 WebSocket 连非自己端口（含回环上的其它端口）都被拦，替身零请求", async () => {
    const before = hits.decoy.length;
    const code = `
      await import(${JSON.stringify(join(REPO, "src", "lib", "paths.ts"))});
      const out = [];
      try { await fetch("http://127.0.0.1:${decoy!.port}/x"); out.push("fetch-through"); } catch { out.push("fetch-blocked"); }
      try { new WebSocket("ws://127.0.0.1:${decoy!.port}/"); out.push("ws-through"); } catch { out.push("ws-blocked"); }
      console.log(out.join(","));`;
    const p = Bun.spawn([BUN, "--no-env-file", "-e", code], {
      cwd: tmp, stdout: "pipe", stderr: "pipe",
      env: testChildEnv({ HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CLAUDESTRA_SANDBOX: "1", BRIDGE_PORT: "23999",
        BRIDGE_URL: "ws://localhost:23999", CLAUDESTRA_STATE_DIR: join(tmp, "g", "state"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "g", "run") }),
    });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    await p.exited;
    expect(out.trim(), err).toBe("fetch-blocked,ws-blocked");
    expect(err).toContain(OUTBOUND_BLOCKED_MARK);
    await Bun.sleep(200);
    expect(hits.decoy.length).toBe(before);
  }, 30_000);

  test("全局注册的 Stop hook：沙箱 agent 按 BRIDGE_URL 打到沙箱端口；拿到生产地址就报错退出、不发请求", async () => {
    const got: string[] = [];
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { got.push(`${new URL(req.url).pathname} ${await req.text()}`); return Response.json({}); } });
    // 异步 spawn：替身服务跑在本测试进程里，spawnSync 会把它的事件循环一起卡住
    const hook = async (env: Record<string, string>) => {
      const p = Bun.spawn([BUN, "--no-env-file", join(REPO, "src", "hooks", "typing-hook.ts")], {
        cwd: tmp, stdin: new Blob([JSON.stringify({ hook_event_name: "Stop" })]), stdout: "pipe", stderr: "pipe",
        env: testChildEnv({ HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CLAUDESTRA_SANDBOX: "1", DISCORD_CHANNEL_ID: "local-sbx",
          BRIDGE_URL: undefined, BRIDGE_PORT: undefined, ...env }),
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

describe("启动夹具：端口竞争（受控扰动）", () => {
  const held: Array<{ stop(force?: boolean): void }> = [];
  const hold = (p: number) => held.push(Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }));
  const fleet = new Fleet(); // 起之前就登记：断言中途失败、起到一半 runner 收尾时 afterEach 兜底收掉并核验，问题汇总抛出
  /** 正常收尾核验：down 干净（bridge 已退、pid 文件已删、端口已释放）；假 home 零改动、零出站 */
  const downAndVerify = async (r: string, before: Map<string, string>) =>
    expect([await fleet.stop(r), diff(before, snapshot(home)), hits]).toEqual([[], [], { proxy: [], decoy: [] }]);
  afterEach(async () => {
    for (const f of [tmuxGate(), `${tmuxGate()}.hit`]) rmSync(f, { force: true });
    held.splice(0).forEach((l) => l.stop(true));
    expect(await fleet.stopAll(), "兜底清理没收干净").toEqual([]);
  });

  test("候选端口在 up 前被抢：原路径拒绝启动；夹具确认本端口 EADDRINUSE、无活宿主后换端口，归属与清理核验", async () => {
    const before = snapshot(home);
    const r = join(tmp, "race-pre");
    const p0 = pickPort(AVOID_PORTS);
    hold(p0); // 原路径：探测关占位 → 别人抢到 → up
    const old = Bun.spawnSync([BUN, SCRIPT, "up", "--port", String(p0), "--root", r], { cwd: REPO, env: callerEnv(), stdout: "pipe", stderr: "pipe" });
    expect([old.exitCode === 0, old.stderr.toString()]).toEqual([false, expect.stringContaining(`端口 ${p0} 已被占用`)]);
    const up = await fleet.start(upSpec(r, 45_000, { onPicked: (p, i) => void (i === 0 && hold(p)) }));
    expect([up.attempts.map((a) => a.outcome), up.port === up.attempts[0]!.port]).toEqual([["port-race", "started"], false]);
    expect((await fetch(`http://127.0.0.1:${up.port}/stats`)).ok).toBe(true);
    await downAndVerify(r, before);
  }, 60_000);

  test("预检之后、bridge 绑定之前被抢：bridge 因 EADDRINUSE 退出，夹具不等 20 秒就绪超时，清理后换端口", async () => {
    const before = snapshot(home);
    const r = join(tmp, "race-bind");
    // 同步点：up 过了预检、停在 ensure-tmux 的 tmux 闸门上（此时 bridge 还没 spawn）→ 抢下候选端口 → 放行
    let raced: Promise<unknown> | null = null;
    writeFileSync(tmuxGate(), "");
    const t0 = Date.now();
    const up = await fleet.start(upSpec(r, 45_000, { onPicked: (p, i) => { if (i === 0) raced = atGate(tmuxGate(), 15_000, () => hold(p)).then(() => null, (e: unknown) => e); } }));
    expect(await raced, "扰动没在闸门处抢到端口").toBeNull();
    // 冲突发生在 bridge 绑定（而不是脚本预检），且不等 20 秒就绪超时
    expect([up.attempts.map((a) => a.outcome), up.attempts[0]!.out.includes("已被占用"), Date.now() - t0 < 20_000]).toEqual([["port-race", "started"], false, true]);
    await downAndVerify(r, before);
  }, 60_000);

  test("up 的后代攥着输出管道时撞截止 / 起到一半被兜底收：不拖过截止，整组进程有界收掉、本次起的不留", async () => {
    writeFileSync(tmuxGate(), ""); // up 停在 ensure-tmux 的 tmux shim 里：up 的后代、继承 up 的输出管道，闸门不删就一直占着
    const t0 = Date.now();
    const cut = await fleet.start(upSpec(join(tmp, "race-hang"), 1_500)).catch((e) => e);
    expect([(cut as StartFailure).attempts?.map((a) => a.outcome), alive(await gateHit(tmuxGate(), 0)), Date.now() - t0 < 8_000]).toEqual([["failed"], false, true]);
    rmSync(`${tmuxGate()}.hit`); // 起到一半时 runner 收尾：起之前就登记过，stopAll 收掉整组进程，启动随之失败
    const late = fleet.start(upSpec(join(tmp, "race-abort"), 45_000)).catch((e) => e);
    const shim = await gateHit(tmuxGate(), 15_000);
    expect([await fleet.stopAll(), await late, alive(shim), existsSync(join(tmp, "race-abort", "bridge.pid")), Date.now() - t0 < 16_000]).toEqual([[], expect.any(StartFailure), false, false, true]);
  }, 30_000);

  test("onPicked 钩子 await 期间被 stopAll：放行后不再起 child，启动失败、无活 bridge，再收一次也不漏", async () => {
    const r = join(tmp, "race-hook");
    let [entered, go, spawned] = [() => {}, () => {}, 0];
    const inHook = new Promise<void>((ok) => (entered = ok)), gate = new Promise<void>((ok) => (go = ok));
    const late = fleet.start(upSpec(r, 45_000, { onPicked: async () => { entered(); await gate; }, onSpawn: () => void spawned++ })).catch((e) => e);
    const first = await inHook.then(() => fleet.stopAll()).finally(go); // 钩子还停着时收：没有 child、没有端口可收；收完放行
    expect([first, String(await late), await fleet.stopAll(), spawned, existsSync(join(r, "bridge.pid"))]).toEqual([[], expect.stringContaining("起到一半已被收掉"), [], 0, false]);
  }, 30_000);

  test("onPicked 检查后外层 await 恢复前 stopAll：微任务取消不能再 spawn 或遗留 bridge", async () => {
    const r = join(tmp, "race-microtask"), before = snapshot(home);
    let stop: Promise<string[]> | undefined, spawned = 0, picked = 0;
    const spec = upSpec(r, 45_000, {
      onPicked: (p) => { picked = p; queueMicrotask(() => queueMicrotask(() => { stop = fleet.stopAll(); })); },
      onSpawn: () => void spawned++,
    });
    try {
      const result = await fleet.start(spec).catch((e) => e);
      const pidFile = join(r, "bridge.pid"), pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
      expect([await stop, await fleet.stopAll(), spawned, pid !== null && alive(pid), existsSync(pidFile)])
        .toEqual([[], [], 0, false, false]);
      expect(String(result)).toContain("起到一半已被收掉");
      expect([diff(before, snapshot(home)), hits]).toEqual([[], { proxy: [], decoy: [] }]);
    } finally {
      // 原缺陷会摘掉 Fleet 登记却留下 detached bridge；原红复现也必须经原入口收回本次临时资源。
      if (spawned) {
        const d = Bun.spawnSync(spec.argv("down", picked), { cwd: REPO, env: spec.env(), stdout: "pipe", stderr: "pipe" });
        expect([d.exitCode, existsSync(join(r, "bridge.pid"))], d.stderr.toString()).toEqual([0, false]);
      }
    }
  }, 60_000);

  test("反向故障照常失败、不重跑：非端口原因、端口被本沙箱活宿主占着、候选是生产端口", async () => {
    const before = snapshot(home);
    const bad = await fleet.start(upSpec(join(home, ".claude-orchestrator", "sbx"), 30_000)).catch((e) => e);
    expect([bad instanceof StartFailure, (bad as StartFailure).attempts?.map((a) => a.outcome), String(bad.message)]).toEqual([true, ["failed"], expect.stringContaining("重叠")]);
    const cut = await fleet.start(upSpec(join(tmp, "race-cut"), 300)).catch((e) => e); // 起到一半撞截止：不重跑，本次起的收干净
    expect([(cut as StartFailure).attempts?.map((a) => a.outcome), existsSync(join(tmp, "race-cut", "bridge.pid"))]).toEqual([["failed"], false]);
    const r = join(tmp, "race-live");
    const up = await fleet.start(upSpec(r, 45_000));
    const twice = await startSandbox(upSpec(r, 30_000, { firstPort: up.port })).catch((e) => e); // 同 root：意外成功也由 live 里这条收
    expect([(twice as StartFailure).attempts?.map((a) => a.outcome), alive(up.pid)]).toEqual([["failed"], true]);
    expect(((await startSandbox(upSpec(r, 30_000, { firstPort: DEFAULT_BRIDGE_PORT })).catch((e) => e)) as StartFailure).attempts).toEqual([]); // 生产端口
    await downAndVerify(r, before);
  }, 90_000);
});
